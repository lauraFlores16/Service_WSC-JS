// ============================================================================
// SERVICIO DE METEOROLOGÍA (Open-Meteo) — lado servidor
// ============================================================================
// Mismo contenido que antes, pero ahora:
//   · Las llamadas van por la cola (lib/cola.js): nunca ráfagas, reintentos con
//     espera exponencial si llega un 429.
//   · Todo se cachea (memoria + disco). La climatología, 30 días. El viento de
//     fechas pasadas, para siempre: el pasado no cambia.
//   · Si Open-Meteo falla y hay una copia caducada, se devuelve la caducada
//     marcada como tal, en vez de un error. El frontend enseña con qué está
//     trabajando y desde cuándo, que es lo que pediste.
// ============================================================================

import { pedir } from "../lib/cola.js";
import { conCache, conCacheTolerante } from "../lib/cache.js";
import { TTL, APOLO } from "../config.js";

const BASE = "https://api.open-meteo.com/v1/forecast";
const ARCHIVO = "https://archive-api.open-meteo.com/v1/archive";

const VARS_ACTUALES = [
  "temperature_2m", "relative_humidity_2m", "wind_speed_10m",
  "wind_direction_10m", "wind_gusts_10m", "precipitation", "surface_pressure",
].join(",");

const VARS_HORARIAS = [
  "temperature_2m", "relative_humidity_2m", "wind_speed_10m", "wind_direction_10m",
  "wind_gusts_10m", "precipitation", "vapour_pressure_deficit",
  "et0_fao_evapotranspiration", "soil_moisture_0_to_1cm", "soil_temperature_0cm",
].join(",");

// Viento meteorológico → componentes u (este) y v (norte), en m/s.
// La dirección de Open-Meteo es "de dónde viene" (convención meteorológica).
export function direccionAComponentes(velocidadKmh, direccionGrados) {
  const vel = (velocidadKmh ?? 0) / 3.6;
  const rad = ((direccionGrados ?? 0) * Math.PI) / 180;
  return { u: -vel * Math.sin(rad), v: -vel * Math.cos(rad), velocidad_ms: vel };
}

// ---------------------------------------------------------------------------
// Estado actual + serie horaria
// ---------------------------------------------------------------------------
export async function obtenerMeteorologia(lat = APOLO.lat, lon = APOLO.lon, opciones = {}) {
  const { horasAdelante = 48 } = opciones;
  // Se redondea la coordenada a 2 decimales (~1 km) para que celdas vecinas
  // compartan caché: pedir el tiempo con 5 decimales por celda no aporta nada
  // y multiplicaría las llamadas por mil.
  const clave = `meteo:${lat.toFixed(2)},${lon.toFixed(2)}`;

  const r = await conCacheTolerante(clave, TTL.meteo, async () => {
    const url =
      `${BASE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&current=${VARS_ACTUALES}&hourly=${VARS_HORARIAS}` +
      `&past_days=2&forecast_days=3&timezone=America%2FLa_Paz`;
    const respuesta = await pedir(url, { etiqueta: "Open-Meteo" });
    const json = await respuesta.json();
    if (json.error) throw new Error(`Open-Meteo: ${json.reason}`);
    return json;
  });

  return {
    ...normalizar(r.valor, horasAdelante),
    procedencia: {
      origen: r.origen,                 // memoria | disco | red | cache-caducada
      edad_minutos: Math.round(r.edadMs / 60000),
      reciente: r.origen !== "cache-caducada",
      aviso: r.error ? r.error.message : null,
    },
  };
}

function normalizar(json, horasAdelante) {
  const c = json.current || {};
  const h = json.hourly || {};
  const tiempos = h.time || [];

  const ahoraIso = (c.time || new Date().toISOString()).slice(0, 13);
  let iAhora = tiempos.findIndex((t) => t.slice(0, 13) === ahoraIso);
  if (iAhora < 0) iAhora = Math.max(0, tiempos.length - 72);

  const actualViento = direccionAComponentes(c.wind_speed_10m, c.wind_direction_10m);

  const serieViento = [];
  const serieAmbiental = [];
  for (let i = iAhora; i < Math.min(iAhora + horasAdelante, tiempos.length); i++) {
    const comp = direccionAComponentes(h.wind_speed_10m?.[i], h.wind_direction_10m?.[i]);
    serieViento.push({
      hora: tiempos[i], u: comp.u, v: comp.v,
      velocidad_ms: comp.velocidad_ms,
      rafaga_ms: (h.wind_gusts_10m?.[i] ?? 0) / 3.6,
      direccion_grados: h.wind_direction_10m?.[i] ?? null,
    });
    serieAmbiental.push({
      hora: tiempos[i],
      temperatura_c: h.temperature_2m?.[i] ?? null,
      humedad_relativa: h.relative_humidity_2m?.[i] ?? null,
      vpd_kpa: h.vapour_pressure_deficit?.[i] ?? null,
      precipitacion_mm: h.precipitation?.[i] ?? null,
      humedad_suelo: h.soil_moisture_0_to_1cm?.[i] ?? null,
      viento_ms: (h.wind_speed_10m?.[i] ?? 0) / 3.6,
    });
  }

  let horasSinLluvia = 0;
  for (let i = iAhora; i >= 0; i--) {
    if ((h.precipitation?.[i] ?? 0) > 0.1) break;
    horasSinLluvia++;
  }
  let lluvia48h = 0;
  for (let i = Math.max(0, iAhora - 48); i <= iAhora; i++) lluvia48h += h.precipitation?.[i] ?? 0;

  return {
    fuente: "Open-Meteo (best_match: ECMWF/GFS/ICON)",
    consultado: new Date().toISOString(),
    coordenadas: { lat: json.latitude, lon: json.longitude },
    elevacion_m: json.elevation ?? null,
    actual: {
      hora: c.time,
      temperatura_c: c.temperature_2m ?? null,
      humedad_relativa: c.relative_humidity_2m != null ? c.relative_humidity_2m / 100 : null,
      viento_ms: actualViento.velocidad_ms,
      viento_kmh: c.wind_speed_10m ?? null,
      viento_direccion: c.wind_direction_10m ?? null,
      viento_u: actualViento.u,
      viento_v: actualViento.v,
      rafaga_ms: (c.wind_gusts_10m ?? 0) / 3.6,
      precipitacion_mm: c.precipitation ?? 0,
      vpd_kpa: h.vapour_pressure_deficit?.[iAhora] ?? null,
      humedad_suelo: h.soil_moisture_0_to_1cm?.[iAhora] ?? null,
    },
    sequedad: { horas_sin_lluvia: horasSinLluvia, lluvia_48h_mm: +lluvia48h.toFixed(2) },
    serieViento,
    serieAmbiental,
  };
}

// ---------------------------------------------------------------------------
// Climatología de referencia (ERA5) — para calcular las anomalías Δ
// ---------------------------------------------------------------------------
export async function obtenerClimatologia(lat = APOLO.lat, lon = APOLO.lon, opciones = {}) {
  const { anios = 5 } = opciones;
  const mes = new Date().getMonth() + 1;
  const clave = `clima:${lat.toFixed(2)},${lon.toFixed(2)}:${mes}:${anios}`;

  const r = await conCacheTolerante(clave, TTL.climatologia, async () => {
    const hoy = new Date();
    const acumulado = { t: 0, hr: 0, v: 0, n: 0 };

    // Los años van por la cola de uno en uno: cinco peticiones seguidas a
    // pelo era justo lo que disparaba el 429.
    for (let k = 1; k <= anios; k++) {
      const anio = hoy.getFullYear() - k;
      const ini = `${anio}-${String(mes).padStart(2, "0")}-01`;
      const fin = `${anio}-${String(mes).padStart(2, "0")}-28`;
      const url =
        `${ARCHIVO}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
        `&start_date=${ini}&end_date=${fin}` +
        `&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m&timezone=America%2FLa_Paz`;
      try {
        const respuesta = await pedir(url, { etiqueta: "Open-Meteo (archivo ERA5)" });
        const j = await respuesta.json();
        const h = j.hourly || {};
        const n = (h.time || []).length;
        for (let i = 0; i < n; i++) {
          if (h.temperature_2m?.[i] == null) continue;
          acumulado.t += h.temperature_2m[i];
          acumulado.hr += h.relative_humidity_2m?.[i] ?? 0;
          acumulado.v += (h.wind_speed_10m?.[i] ?? 0) / 3.6;
          acumulado.n++;
        }
      } catch (e) {
        console.warn(`[meteo] climatología ${anio} no disponible: ${e.message}`);
      }
    }

    if (acumulado.n === 0) throw new Error("No se pudo construir la climatología ERA5.");

    return {
      mes, anios_usados: anios, horas: acumulado.n,
      temperatura_c: +(acumulado.t / acumulado.n).toFixed(2),
      humedad_relativa: +(acumulado.hr / acumulado.n / 100).toFixed(4),
      viento_ms: +(acumulado.v / acumulado.n).toFixed(3),
      fuente: "ERA5 (Open-Meteo Historical Weather API)",
    };
  });

  return r.valor;
}

// ---------------------------------------------------------------------------
// Serie histórica de viento (para calibrar contra eventos pasados)
// ---------------------------------------------------------------------------
export async function obtenerSerieVientoHistorica(lat, lon, fechaInicio, fechaFin) {
  const clave = `viento-hist:${lat.toFixed(2)},${lon.toFixed(2)}:${fechaInicio}:${fechaFin}`;
  const r = await conCache(clave, TTL.vientoHistorico, async () => {
    const url =
      `${ARCHIVO}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
      `&start_date=${fechaInicio}&end_date=${fechaFin}` +
      `&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,relative_humidity_2m` +
      `&timezone=America%2FLa_Paz`;
    const respuesta = await pedir(url, { etiqueta: "Open-Meteo (archivo ERA5)" });
    const j = await respuesta.json();
    const h = j.hourly || {};
    return (h.time || []).map((t, i) => {
      const comp = direccionAComponentes(h.wind_speed_10m?.[i], h.wind_direction_10m?.[i]);
      return {
        hora: t, u: comp.u, v: comp.v, velocidad_ms: comp.velocidad_ms,
        temperatura_c: h.temperature_2m?.[i] ?? null,
        humedad_relativa: h.relative_humidity_2m?.[i] != null ? h.relative_humidity_2m[i] / 100 : null,
      };
    });
  });
  return r.valor;
}

// ---------------------------------------------------------------------------
// Índice de peligro 30-30-30 con datos reales
// ---------------------------------------------------------------------------
export function indicePeligro(meteo) {
  if (!meteo) return null;
  const a = meteo.actual;
  const t = a.temperatura_c ?? 0;
  const hr = (a.humedad_relativa ?? 0.5) * 100;
  const vKmh = a.viento_kmh ?? 0;

  const fT = Math.min(Math.max((t - 15) / (30 - 15), 0), 1);
  const fH = Math.min(Math.max((45 - hr) / (45 - 30), 0), 1);
  const fV = Math.min(Math.max(vKmh / 30, 0), 1);
  const fS = Math.min(meteo.sequedad.horas_sin_lluvia / 168, 1);

  const puntaje = 0.3 * fT + 0.3 * fH + 0.25 * fV + 0.15 * fS;

  return {
    puntaje: Math.min(Math.max(puntaje, 0), 1),
    condiciones: {
      temperatura: { valor: t, umbral: 30, cumple: t >= 30, factor: fT },
      humedad: { valor: hr, umbral: 30, cumple: hr <= 30, factor: fH },
      viento: { valor: vKmh, umbral: 30, cumple: vKmh >= 30, factor: fV },
      sequedad: {
        valor: meteo.sequedad.horas_sin_lluvia, umbral: 168,
        cumple: meteo.sequedad.horas_sin_lluvia >= 168, factor: fS,
      },
    },
    regla_303030: [t >= 30, hr <= 30, vKmh >= 30].filter(Boolean).length,
  };
}
