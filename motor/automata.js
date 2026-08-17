// ============================================================================
// AUTÓMATA CELULAR v2 — motor de propagación de incendios
// ============================================================================
// (la v1, port directo de automata_service.py, queda en automata_v1_legacy.js
//  para poder comparar resultados en la defensa)
//
//  1. PENDIENTE REAL ENTRE CELDAS: el factor de pendiente ya no usa la
//     inclinación de la celda destino, sino la DIFERENCIA DE ALTURA entre la
//     celda que arde y la vecina (Δh / distancia). Uphill acelera, downhill
//     frena, como en la formulación de Rothermel.
//  2. VIENTO VARIABLE EN EL TIEMPO: acepta una serie meteorológica horaria
//     (Open-Meteo) y la interpola al paso de simulación.
//  3. TIEMPO DE RESIDENCIA: una celda arde varios pasos antes de pasar a
//     quemada; su intensidad decae a lo largo de la combustión.
//  4. SPOTTING: saltos de pavesas a distancia, con probabilidad y alcance
//     dependientes de la intensidad del frente y de la velocidad del viento.
//  5. CONSTANTES K CALIBRABLES: todas se reciben por parámetro (ver
//     calibracion.js, que las ajusta contra perímetros reales de NASA FIRMS).
//  6. VECINDAD ADAPTATIVA CON PESOS POR DISTANCIA: radio configurable y peso
//     1/d — la diagonal ya no propaga igual que la ortogonal, lo que elimina
//     el sesgo "cuadrado" clásico de los autómatas de Moore.
//
// Extras: PRNG con semilla (reproducible, imprescindible para calibrar) y
// barreras externas (ríos, quebradas, caminos) inyectadas desde OSM.
//
// Estados: 0=sin_quemar, 1=ardiendo, 2=quemado, 3=inerte
// ============================================================================

const SIN_QUEMAR = 0, ARDIENDO = 1, QUEMADO = 2, INERTE = 3;
const ESTADO_API = { [ARDIENDO]: "ardiendo", [QUEMADO]: "quemada" };

// Geometría del grid de Apolo: celdas de 0.0045° ≈ 500 m (25 ha, coherente con
// AREA_POR_CELDA_HA del resto del sistema).
export const TAM_CELDA_NS_M = 500; // norte-sur (Δfila)
export const TAM_CELDA_EO_M = 484; // este-oeste (Δcolumna, corregido por cos(lat))

// ---------------------------------------------------------------------------
// Constantes calibrables. calibracion.js las sobreescribe con los valores que
// mejor reproducen los perímetros reales de 2021 / 2023 / 2024.
// ---------------------------------------------------------------------------
export const CONSTANTES_POR_DEFECTO = {
  // Pendiente (Δh entre celdas)
  K_PENDIENTE_ARRIBA: 3.0,   // exp(K·tanθ) cuesta arriba
  K_PENDIENTE_ABAJO: 1.2,    // cuesta abajo (más suave → factor < 1)
  PENDIENTE_MAX: 4.0,        // tope del factor, evita explosiones numéricas

  // Viento
  K_VIENTO: 0.15,
  EXP_VIENTO: 1.0,           // no linealidad de la respuesta al viento

  // Temperatura / humedad
  K_TEMPERATURA: 0.01,       // °C → reducción de humedad efectiva
  K_HUMEDAD: 0.5,            // f_hum = max(1 - K_HUMEDAD·humedad, 0.1)

  // Vegetación
  NDVI_BARRERA: 0.10,
  NDVI_BASE: 0.5,            // f_veg = NDVI_BASE + ndvi

  // Tiempo de residencia (en pasos de simulación)
  // 1 paso = 15 min simulados. 3 pasos ≈ 45 min de llama en una celda de 500 m,
  // que es el orden de magnitud real del tiempo de residencia en pastizal/matorral;
  // 6 pasos ≈ 90 min para bosque denso (NDVI alto).
  RESIDENCIA_MIN: 3,
  RESIDENCIA_MAX: 6,
  DECAIMIENTO_FASE: 0.25,    // la intensidad baja hasta (1-0.25) al final

  // Spotting (saltos de pavesas)
  SPOTTING_ACTIVO: true,
  SPOTTING_PROB: 0.015,      // prob. base por celda ardiendo y por paso
  SPOTTING_VIENTO_MIN: 1.0,  // m/s por debajo del cual no hay saltos
  SPOTTING_DIST_MIN: 2,      // celdas (1 km)
  SPOTTING_DIST_MAX: 6,      // celdas (3 km)
  SPOTTING_DISPERSION: 0.35, // rad de apertura respecto a la dirección del viento

  // Vecindad
  RADIO_VECINDAD: 1,         // 1 = Moore 3x3; 2 = 5x5 con pesos por distancia
  EXP_DISTANCIA: 1.0,        // peso = 1 / d^EXP_DISTANCIA
};

// ---------------------------------------------------------------------------
// PRNG determinista (mulberry32). Misma semilla → misma corrida.
// ---------------------------------------------------------------------------
function mulberry32(semilla) {
  let a = semilla >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// MEJORA 1 — Factor de pendiente por diferencia de altura entre celdas.
// θ = atan(Δh / distancia_horizontal).  Δh > 0 = la vecina está más ARRIBA.
// El fuego sube mucho más rápido de lo que baja (precalentamiento por
// convección y radiación): por eso K_ARRIBA >> K_ABAJO, y cuesta abajo el
// factor resulta < 1.
// ---------------------------------------------------------------------------
function factorPendiente(deltaH, distanciaM, K) {
  if (!Number.isFinite(deltaH) || distanciaM <= 0) return 1.0;
  const tan = deltaH / distanciaM;
  const k = tan >= 0 ? K.K_PENDIENTE_ARRIBA : K.K_PENDIENTE_ABAJO;
  const f = Math.exp(k * tan);
  return Math.min(Math.max(f, 1 / K.PENDIENTE_MAX), K.PENDIENTE_MAX);
}

// ---------------------------------------------------------------------------
// Factor de viento: proyecta el vector viento sobre la dirección de avance.
// df = Δfila (positivo = hacia el sur), dc = Δcolumna (positivo = hacia el este).
// u = componente este, v = componente norte → dirección de avance = (dc, -df).
// ---------------------------------------------------------------------------
function factorViento(df, dc, u, v, K) {
  const vel = Math.hypot(u, v);
  if (vel < 1e-6) return 1.0;
  const norma = Math.hypot(dc, df) || 1;
  const dot = ((dc / norma) * u + (-df / norma) * v) / vel;
  return 1.0 + K.K_VIENTO * Math.pow(vel, K.EXP_VIENTO) * Math.max(0, dot);
}

// ---------------------------------------------------------------------------
// MEJORA 2 — Serie de viento variable en el tiempo.
// serieViento: [{ u, v, hora }] horaria (la entrega api_meteo.js).
// Se interpola linealmente al minuto simulado del paso actual.
// ---------------------------------------------------------------------------
function vientoEnPaso(serieViento, paso, minutosPorPaso, multiplicador) {
  if (!serieViento || serieViento.length === 0) return null;
  const horas = (paso * minutosPorPaso) / 60;
  const i0 = Math.min(Math.floor(horas), serieViento.length - 1);
  const i1 = Math.min(i0 + 1, serieViento.length - 1);
  const t = horas - Math.floor(horas);
  const a = serieViento[i0], b = serieViento[i1];
  return {
    u: (a.u + (b.u - a.u) * t) * multiplicador,
    v: (a.v + (b.v - a.v) * t) * multiplicador,
    hora: a.hora,
  };
}

// ---------------------------------------------------------------------------
// MEJORA 6 — Vecindad con pesos por distancia (se precalcula una sola vez).
// ---------------------------------------------------------------------------
function construirVecindad(radio, expDistancia) {
  const vecinos = [];
  for (let df = -radio; df <= radio; df++) {
    for (let dc = -radio; dc <= radio; dc++) {
      if (df === 0 && dc === 0) continue;
      const dCeldas = Math.hypot(df, dc);
      if (dCeldas > radio + 1e-9) continue; // vecindad circular, no cuadrada
      const dMetros = Math.hypot(df * TAM_CELDA_NS_M, dc * TAM_CELDA_EO_M);
      vecinos.push({
        df, dc, dCeldas, dMetros,
        peso: 1 / Math.pow(dCeldas, expDistancia), // ortogonal 1.0 · diagonal 0.707
      });
    }
  }
  return vecinos;
}

// ===========================================================================
// MOTOR
// ===========================================================================
/**
 * @param {Array}  gridCeldas  filas de grid.csv
 * @param {Object} parametros  foco_fila, foco_columna, p_base, multiplicador_viento,
 *                             delta_humedad, delta_temperatura_c, num_iteraciones,
 *                             minutos_por_iteracion, semilla
 * @param {Object} opciones
 *    - constantes:    sobreescribe CONSTANTES_POR_DEFECTO
 *    - elevacion:     Map(celda_id → metros) | función(celda) → metros   (DEM)
 *    - barrerasExtra: Set(celda_id) — ríos, lagunas, caminos (OSM/Overpass)
 *    - serieViento:   [{u, v, hora}] de api_meteo.js
 */
export function ejecutarAutomata(gridCeldas, parametros, opciones = {}) {
  const {
    foco_fila, foco_columna, p_base, multiplicador_viento = 1,
    delta_humedad = 0, delta_temperatura_c = 0, num_iteraciones = 20,
    minutos_por_iteracion = 15, semilla = 12345,
    focos_iniciales = null,
  } = parametros;

  const K = { ...CONSTANTES_POR_DEFECTO, ...(opciones.constantes || parametros.constantes || {}) };
  const serieViento = opciones.serieViento || parametros.serie_viento || null;
  const barrerasExtra = opciones.barrerasExtra || null;
  const elevacionFuente = opciones.elevacion || null;

  const rand = mulberry32(semilla);

  const filas = Math.max(...gridCeldas.map((c) => c.fila)) + 1;
  const columnas = Math.max(...gridCeldas.map((c) => c.columna)) + 1;
  const n = filas * columnas;
  const idx = (f, c) => f * columnas + c;

  // ---- Campos del grid (arreglos planos) ----
  const pendienteGrados = new Float32Array(n);
  const elevacion = new Float32Array(n);
  const hayElevacion = new Uint8Array(n);
  const ndvi = new Float32Array(n);
  const humedad = new Float32Array(n);
  const vientoU = new Float32Array(n);
  const vientoV = new Float32Array(n);
  const barrera = new Uint8Array(n);
  const valida = new Uint8Array(n);
  const celdaId = new Array(n);
  const latPos = new Float64Array(n);
  const lonPos = new Float64Array(n);

  const ajusteHumedadTemp = K.K_TEMPERATURA * delta_temperatura_c;
  let sumaVelLocal = 0, nVel = 0, celdasConDem = 0;

  for (const row of gridCeldas) {
    const i = idx(row.fila, row.columna);
    valida[i] = 1;
    const ndviVal = row.ndvi ?? 0.3;
    const humedadVal = row.humedad ?? 0.3;
    pendienteGrados[i] = row.pendiente_grados ?? 0;
    ndvi[i] = ndviVal;
    humedad[i] = Math.min(Math.max(humedadVal + delta_humedad - ajusteHumedadTemp, 0), 1);
    vientoU[i] = row.viento_u ?? 0;
    vientoV[i] = row.viento_v ?? 0;
    sumaVelLocal += Math.hypot(vientoU[i], vientoV[i]); nVel++;
    celdaId[i] = row.id;
    latPos[i] = row.lat;
    lonPos[i] = row.lon;

    // Altura real (DEM Copernicus vía api_terreno.js). Si no hay, el motor cae
    // al modo "pendiente de la celda" (compatibilidad con la v1).
    let h = null;
    if (elevacionFuente) {
      h = typeof elevacionFuente === "function"
        ? elevacionFuente(row)
        : (elevacionFuente.get ? elevacionFuente.get(row.id) : elevacionFuente[row.id]);
    }
    if (h == null && row.elevacion != null) h = row.elevacion;
    if (h != null && Number.isFinite(h)) { elevacion[i] = h; hayElevacion[i] = 1; celdasConDem++; }

    // Barreras: sin combustible (NDVI) + barreras físicas de OSM
    const esBarreraOsm = barrerasExtra ? barrerasExtra.has(row.id) : false;
    barrera[i] = (ndviVal < K.NDVI_BARRERA || esBarreraOsm) ? 1 : 0;
  }

  const velMediaLocal = nVel ? sumaVelLocal / nVel : 1;

  // ---- MEJORA 3: tiempo de residencia por celda ----
  // Más combustible (NDVI alto) → arde más pasos antes de consumirse.
  const residencia = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!valida[i]) continue;
    const carga = Math.min(Math.max(ndvi[i] / 0.8, 0), 1);
    const r = K.RESIDENCIA_MIN + carga * (K.RESIDENCIA_MAX - K.RESIDENCIA_MIN);
    residencia[i] = Math.max(1, Math.round(r));
  }

  const vecindad = construirVecindad(K.RADIO_VECINDAD, K.EXP_DISTANCIA);

  // ---- Estado inicial ----
  let estados = new Uint8Array(n).fill(INERTE);
  for (let i = 0; i < n; i++) {
    if (valida[i]) estados[i] = barrera[i] ? INERTE : SIN_QUEMAR;
  }
  const pasosArdiendo = new Uint8Array(n);

  const iFoco = idx(foco_fila, foco_columna);
  if (!valida[iFoco]) {
    throw new Error(
      `La celda foco (fila=${foco_fila}, columna=${foco_columna}) no pertenece al grid válido de Apolo.`
    );
  }
  estados[iFoco] = ARDIENDO;

  // Igniciones múltiples: un episodio real casi nunca arranca de una sola celda
  // (FIRMS detecta varios focos simultáneos). La calibración las usa para no
  // depender del azar de que la única celda inicial prenda o no.
  const indicesIniciales = [iFoco];
  if (Array.isArray(focos_iniciales)) {
    for (const fo of focos_iniciales) {
      const k = idx(fo.fila, fo.columna);
      if (k !== iFoco && valida[k] && !barrera[k] && estados[k] === SIN_QUEMAR) {
        estados[k] = ARDIENDO;
        indicesIniciales.push(k);
      }
    }
  }

  const ahora = new Date();
  const eventosSpotting = [];

  // ---- Frente activo + celdas tocadas ----
  // En vez de recorrer las 36.390 celdas en cada paso (O(N)), se mantiene la
  // lista de celdas que están ardiendo y la de celdas que alguna vez ardieron.
  // El coste pasa a ser proporcional al tamaño del incendio, no del municipio:
  // esto es lo que hace viable la calibración automática dentro del navegador.
  let frente = indicesIniciales.slice();
  const tocadas = indicesIniciales.slice();

  function construirIteracion(numIter, grid, vientoUsado) {
    const celdas = [];
    let ardiendo = 0, quemadas = 0;
    // Modo calibración: solo se cuentan celdas, no se construyen objetos por
    // celda (evita millones de asignaciones durante la optimización).
    if (opciones.soloConteo) {
      for (const i of tocadas) {
        if (grid[i] === ARDIENDO) ardiendo++;
        else if (grid[i] === QUEMADO) quemadas++;
      }
      return { iteracion: numIter, celdas: [], num_celdas_ardiendo: ardiendo, num_celdas_quemadas: quemadas };
    }
    for (const i of tocadas) {
      const e = grid[i];
      if (e === ARDIENDO) ardiendo++;
      else if (e === QUEMADO) quemadas++;
      else continue;
      celdas.push({ celda_id: celdaId[i], lat: latPos[i], lon: lonPos[i], estado: ESTADO_API[e] });
    }
    return {
      iteracion: numIter,
      timestamp_simulado: new Date(ahora.getTime() + minutos_por_iteracion * 60000 * numIter).toISOString(),
      celdas,
      num_celdas_ardiendo: ardiendo,
      num_celdas_quemadas: quemadas,
      viento: vientoUsado
        ? {
            velocidad_ms: +Math.hypot(vientoUsado.u, vientoUsado.v).toFixed(2),
            direccion_grados: Math.round(
              (270 - (Math.atan2(vientoUsado.v, vientoUsado.u) * 180) / Math.PI + 360) % 360
            ),
            hora: vientoUsado.hora ?? null,
          }
        : null,
    };
  }

  // ---- Un paso del autómata ----
  function paso(grid, numPaso) {
    const nuevo = grid.slice();
    const vientoGlobal = vientoEnPaso(serieViento, numPaso, minutos_por_iteracion, multiplicador_viento);
    const siguienteFrente = [];

    {
      for (const i of frente) {
        if (grid[i] !== ARDIENDO) continue;
        const f = Math.floor(i / columnas);
        const c = i - f * columnas;

        // --- MEJORA 3: residencia ---
        pasosArdiendo[i]++;
        if (pasosArdiendo[i] >= residencia[i]) nuevo[i] = QUEMADO;

        // La intensidad del frente decae conforme se consume el combustible.
        const fase = pasosArdiendo[i] / residencia[i];
        const factorFase = 1 - K.DECAIMIENTO_FASE * Math.min(fase, 1);

        // --- MEJORA 2: viento del paso ---
        // Con serie meteorológica: forzante regional escalado por la anomalía
        // local de ERA5 (canalización por el relieve). Sin serie: viento local.
        let u, v;
        if (vientoGlobal) {
          const escalaLocal = velMediaLocal > 1e-6
            ? Math.hypot(vientoU[i], vientoV[i]) / velMediaLocal : 1;
          const esc = 0.6 + 0.4 * Math.min(escalaLocal, 2); // 0.6 .. 1.4
          u = vientoGlobal.u * esc;
          v = vientoGlobal.v * esc;
        } else {
          u = vientoU[i] * multiplicador_viento;
          v = vientoV[i] * multiplicador_viento;
        }
        const velViento = Math.hypot(u, v);

        // --- Propagación a la vecindad ---
        for (const vec of vecindad) {
          const nf = f + vec.df, nc = c + vec.dc;
          if (nf < 0 || nf >= filas || nc < 0 || nc >= columnas) continue;
          const j = idx(nf, nc);
          if (grid[j] !== SIN_QUEMAR || nuevo[j] !== SIN_QUEMAR) continue;
          if (barrera[j]) continue;

          // MEJORA 1: pendiente por diferencia de altura real
          let fPend;
          if (hayElevacion[i] && hayElevacion[j]) {
            fPend = factorPendiente(elevacion[j] - elevacion[i], vec.dMetros, K);
          } else {
            fPend = 1 + 0.03 * pendienteGrados[j]; // fallback v1 si aún no hay DEM
          }

          const fViento = factorViento(vec.df, vec.dc, u, v, K);
          const fVeg = K.NDVI_BASE + ndvi[j];
          const fHum = Math.max(1 - K.K_HUMEDAD * humedad[j], 0.1);

          // MEJORA 6: peso por distancia (diagonal ≠ ortogonal)
          const p = p_base * vec.peso * factorFase * fPend * fViento * fVeg * fHum;
          if (rand() < Math.min(Math.max(p, 0), 1)) {
            nuevo[j] = ARDIENDO;
            siguienteFrente.push(j);
            tocadas.push(j);
          }
        }

        // --- MEJORA 4: spotting (saltos de pavesas) ---
        if (K.SPOTTING_ACTIVO && velViento >= K.SPOTTING_VIENTO_MIN) {
          const intensidad = Math.min(ndvi[i] / 0.8, 1) * (1 - humedad[i]) * factorFase;
          const pSalto = K.SPOTTING_PROB * intensidad * Math.min(velViento / 3, 3);
          if (rand() < pSalto) {
            const dirViento = Math.atan2(-v, u); // ángulo en el plano (columna, fila)
            const ang = dirViento + (rand() - 0.5) * 2 * K.SPOTTING_DISPERSION;
            const alcance = K.SPOTTING_DIST_MIN
              + rand() * (K.SPOTTING_DIST_MAX - K.SPOTTING_DIST_MIN) * Math.min(velViento / 5, 1);
            const sf = f + Math.round(-Math.sin(ang) * alcance);
            const sc = c + Math.round(Math.cos(ang) * alcance);
            if (sf >= 0 && sf < filas && sc >= 0 && sc < columnas) {
              const s = idx(sf, sc);
              if (valida[s] && !barrera[s] && grid[s] === SIN_QUEMAR && nuevo[s] === SIN_QUEMAR) {
                nuevo[s] = ARDIENDO;
                siguienteFrente.push(s);
                tocadas.push(s);
                eventosSpotting.push({
                  iteracion: numPaso,
                  origen: { fila: f, columna: c },
                  destino: { fila: sf, columna: sc, lat: latPos[s], lon: lonPos[s] },
                  distancia_m: Math.round(alcance * TAM_CELDA_NS_M),
                });
              }
            }
          }
        }

        // Sigue en el frente si aún no agotó su tiempo de residencia
        if (nuevo[i] === ARDIENDO) siguienteFrente.push(i);
      }
    }
    frente = siguienteFrente;
    return { nuevo, vientoGlobal };
  }

  // ---- Bucle principal ----
  const vientoInicial = vientoEnPaso(serieViento, 0, minutos_por_iteracion, multiplicador_viento);
  const iteraciones = [construirIteracion(0, estados, vientoInicial)];

  for (let t = 1; t <= num_iteraciones; t++) {
    const r = paso(estados, t);
    estados = r.nuevo;
    iteraciones.push(construirIteracion(t, estados, r.vientoGlobal));
    if (iteraciones[iteraciones.length - 1].num_celdas_ardiendo === 0) break;
    // Corte por tamaño (lo usa la calibración): un candidato que ya quemó
    // varias veces el área real es malo, no hace falta terminar de simularlo.
    if (opciones.limiteCeldas && tocadas.length > opciones.limiteCeldas) break;
  }

  iteraciones.metadatos = {
    constantes: K,
    minutos_por_iteracion,
    semilla,
    celdas_con_dem: celdasConDem,
    usa_dem: celdasConDem > 0,
    usa_serie_viento: !!serieViento,
    barreras_osm: barrerasExtra ? barrerasExtra.size : 0,
    eventos_spotting: eventosSpotting,
  };

  // Para la calibración: identificadores de todas las celdas que ardieron.
  if (opciones.soloConteo) {
    const ids = [];
    for (const i of tocadas) if (estados[i] === QUEMADO || estados[i] === ARDIENDO) ids.push(celdaId[i]);
    iteraciones.metadatos.celdas_quemadas_ids = ids;
  }

  return iteraciones;
}

// ---------------------------------------------------------------------------
// Utilidad para la calibración: corre el autómata y devuelve solo el conjunto
// de celdas quemadas (perímetro final). Mucho más barato que guardar todo.
// ---------------------------------------------------------------------------
export function perimetroSimulado(gridCeldas, parametros, opciones = {}) {
  const its = ejecutarAutomata(gridCeldas, parametros, { ...opciones, soloConteo: true });
  return new Set(its.metadatos.celdas_quemadas_ids);
}

export { SIN_QUEMAR, ARDIENDO, QUEMADO, INERTE };
