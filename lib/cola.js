// ============================================================================
// COLA DE PETICIONES SALIENTES  —  aquí se arregla el error 429
// ============================================================================
// El error que veías:
//
//   Open-Meteo respondió 429: "Minutely API request limit exceeded"
//
// no era un fallo de la API: era el frontend disparándole ~45 peticiones en dos
// segundos (1 forecast + 5 de climatología + 38 lotes de DEM), y encima una vez
// por cada pestaña, recarga y cambio de foco. Open-Meteo limita por minuto y
// cortaba.
//
// Ahora TODAS las llamadas externas pasan por aquí, en el servidor:
//
//   1. UN SOLO ORIGEN. Da igual cuántos navegadores haya abiertos: el que llama
//      a Open-Meteo es este proceso, así que el límite se respeta de verdad.
//   2. RITMO CONTROLADO por host (intervalo mínimo entre peticiones y un tope
//      de peticiones por minuto). Nunca se dispara una ráfaga.
//   3. REINTENTO CON ESPERA EXPONENCIAL si igual llega un 429 o un 503,
//      respetando la cabecera Retry-After cuando el servidor la manda.
//   4. Si tras los reintentos sigue fallando, se devuelve un error tipado para
//      que la ruta responda "no disponible" con elegancia en vez de reventar.
// ============================================================================

// Límites por host. Open-Meteo permite ~600 peticiones/minuto en el plan
// gratuito, pero vamos MUY por debajo a propósito: los datos se cachean, así
// que no hace falta correr, y así el servicio nunca nos corta.
const LIMITES = {
  "api.open-meteo.com":        { intervaloMs: 120, porMinuto: 250 },
  "archive-api.open-meteo.com": { intervaloMs: 250, porMinuto: 120 },
  "overpass-api.de":           { intervaloMs: 2000, porMinuto: 12 },
  "firms.modaps.eosdis.nasa.gov": { intervaloMs: 1000, porMinuto: 30 },
  _defecto:                    { intervaloMs: 300, porMinuto: 100 },
};

const REINTENTOS_MAX = 4;
const ESPERA_BASE_MS = 1500;

// --- Cortacircuitos ---------------------------------------------------------
// Si un host lleva varios fallos seguidos (está caído, la clave es inválida, o
// nos tiene bloqueados), seguir encolando peticiones solo sirve para que cada
// carga de pantalla tarde segundos de más esperando el turno de la cola para
// volver a fallar. Tras FALLOS_PARA_ABRIR fallos consecutivos el circuito se
// abre y las peticiones se rechazan al instante, sin tocar la red, durante el
// enfriamiento. Un único éxito lo cierra otra vez.
const FALLOS_PARA_ABRIR = 3;
const ENFRIAMIENTO_MS = { 429: 60_000, 503: 60_000, defecto: 120_000 };

const estados = new Map(); // host → { cola, ocupado, ultimaMs, marcas[] }

function estadoDe(host) {
  if (!estados.has(host)) {
    estados.set(host, {
      cola: [], ocupado: false, ultimaMs: 0, marcas: [],
      fallosSeguidos: 0, abiertoHasta: 0, ultimoError: null, ultimoOkMs: 0,
    });
  }
  return estados.get(host);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

export class ErrorExterno extends Error {
  constructor(mensaje, { estado = 503, servicio = null, reintentarEnS = null } = {}) {
    super(mensaje);
    this.name = "ErrorExterno";
    this.estadoHttp = estado;
    this.servicio = servicio;
    this.reintentarEnS = reintentarEnS;
  }
}

/**
 * Encola una petición HTTP saliente y la ejecuta cuando toque.
 * @param {string} url
 * @param {Object} opciones  opciones de fetch + { etiqueta, timeoutMs }
 */
export function pedir(url, opciones = {}) {
  const host = new URL(url).host;
  const estado = estadoDe(host);

  // Circuito abierto: se falla ya, sin esperar turno ni tocar la red.
  if (estado.abiertoHasta > Date.now()) {
    const segundos = Math.ceil((estado.abiertoHasta - Date.now()) / 1000);
    return Promise.reject(new ErrorExterno(
      `${opciones.etiqueta || host} no está respondiendo. Se reintentará en ${segundos} s.`,
      { estado: 503, servicio: opciones.etiqueta || host, reintentarEnS: segundos }
    ));
  }

  return new Promise((resolver, rechazar) => {
    estado.cola.push({ url, opciones, resolver, rechazar });
    bombear(host);
  });
}

async function bombear(host) {
  const estado = estadoDe(host);
  if (estado.ocupado || estado.cola.length === 0) return;
  estado.ocupado = true;

  const limite = LIMITES[host] || LIMITES._defecto;

  while (estado.cola.length > 0) {
    // --- Respetar el intervalo mínimo entre peticiones ---
    const desdeUltima = Date.now() - estado.ultimaMs;
    if (desdeUltima < limite.intervaloMs) await dormir(limite.intervaloMs - desdeUltima);

    // --- Respetar el tope por minuto ---
    const ahora = Date.now();
    estado.marcas = estado.marcas.filter((t) => ahora - t < 60_000);
    if (estado.marcas.length >= limite.porMinuto) {
      const esperar = 60_000 - (ahora - estado.marcas[0]) + 50;
      console.log(`[cola] ${host}: tope por minuto alcanzado, esperando ${Math.round(esperar / 1000)}s`);
      await dormir(esperar);
      continue;
    }

    const tarea = estado.cola.shift();
    estado.ultimaMs = Date.now();
    estado.marcas.push(estado.ultimaMs);

    try {
      const respuesta = await ejecutarConReintentos(tarea.url, tarea.opciones, host);
      estado.fallosSeguidos = 0;
      estado.ultimoError = null;
      estado.ultimoOkMs = Date.now();
      tarea.resolver(respuesta);
    } catch (e) {
      estado.fallosSeguidos++;
      estado.ultimoError = e.message;
      if (estado.fallosSeguidos >= FALLOS_PARA_ABRIR) {
        const espera = ENFRIAMIENTO_MS[e.estadoHttp] ?? ENFRIAMIENTO_MS.defecto;
        estado.abiertoHasta = Date.now() + espera;
        console.warn(`[cola] ${host}: ${estado.fallosSeguidos} fallos seguidos, se deja de intentar durante ${Math.round(espera / 1000)}s`);
        // Las que quedaban en la cola se rechazan de inmediato en vez de
        // esperar su turno para fallar una a una.
        const pendientes = estado.cola.splice(0);
        for (const p of pendientes) {
          p.rechazar(new ErrorExterno(
            `${p.opciones.etiqueta || host} no está respondiendo.`,
            { estado: 503, servicio: p.opciones.etiqueta || host, reintentarEnS: Math.ceil(espera / 1000) }
          ));
        }
      }
      tarea.rechazar(e);
    }
  }

  estado.ocupado = false;
}

async function ejecutarConReintentos(url, opciones, host) {
  const { timeoutMs = 30_000, etiqueta = host, ...restoFetch } = opciones;

  for (let intento = 0; intento <= REINTENTOS_MAX; intento++) {
    const abortador = new AbortController();
    const reloj = setTimeout(() => abortador.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...restoFetch, signal: abortador.signal });
      clearTimeout(reloj);

      // 429 / 503 / 504 → esperar y reintentar
      if (r.status === 429 || r.status === 503 || r.status === 504) {
        const cabecera = Number(r.headers.get("retry-after"));
        const espera = Number.isFinite(cabecera) && cabecera > 0
          ? cabecera * 1000
          : ESPERA_BASE_MS * Math.pow(2, intento);

        if (intento === REINTENTOS_MAX) {
          throw new ErrorExterno(
            `${etiqueta} está limitando las peticiones (HTTP ${r.status}).`,
            { estado: 503, servicio: etiqueta, reintentarEnS: Math.ceil(espera / 1000) }
          );
        }
        console.warn(`[cola] ${etiqueta} devolvió ${r.status}; reintento ${intento + 1}/${REINTENTOS_MAX} en ${Math.round(espera / 1000)}s`);
        await dormir(espera);
        continue;
      }

      if (!r.ok) {
        const texto = await r.text().catch(() => "");
        throw new ErrorExterno(
          `${etiqueta} respondió ${r.status}: ${texto.slice(0, 200)}`,
          { estado: 502, servicio: etiqueta }
        );
      }

      return r;
    } catch (e) {
      clearTimeout(reloj);
      if (e instanceof ErrorExterno) throw e;

      // Timeout o fallo de red: también se reintenta
      if (intento === REINTENTOS_MAX) {
        throw new ErrorExterno(
          e.name === "AbortError"
            ? `${etiqueta} no respondió a tiempo.`
            : `No se pudo contactar con ${etiqueta}: ${e.message}`,
          { estado: 504, servicio: etiqueta }
        );
      }
      await dormir(ESPERA_BASE_MS * Math.pow(2, intento));
    }
  }
}

/** Estado de las colas, para el endpoint /api/estado. */
export function estadoColas() {
  const salida = {};
  for (const [host, e] of estados) {
    const abierto = e.abiertoHasta > Date.now();
    salida[host] = {
      disponible: !abierto,
      en_cola: e.cola.length,
      ocupado: e.ocupado,
      peticiones_ultimo_minuto: e.marcas.filter((t) => Date.now() - t < 60_000).length,
      limite_por_minuto: (LIMITES[host] || LIMITES._defecto).porMinuto,
      fallos_seguidos: e.fallosSeguidos,
      ultimo_error: e.ultimoError,
      reintenta_en_s: abierto ? Math.ceil((e.abiertoHasta - Date.now()) / 1000) : 0,
      ultimo_ok: e.ultimoOkMs ? new Date(e.ultimoOkMs).toISOString() : null,
    };
  }
  return salida;
}
