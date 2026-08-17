// ============================================================================
// CALIBRACIÓN AUTOMÁTICA DE LAS CONSTANTES K
// ============================================================================
// El informe de validación del proyecto arroja IoU = 1.4 % y área simulada
// 2.944 km² frente a 159 km² reales: las constantes K estaban puestas a mano.
// Este módulo las ajusta solo, con un algoritmo evolutivo (evolución
// diferencial, la variante de AG que mejor funciona en espacios continuos).
//
// VERDAD DE CAMPO
// ---------------
// focos.csv trae 18.345 detecciones reales de NASA FIRMS etiquetadas por evento
// (2021, 2023, 2024). Un evento entero dura meses y son muchas igniciones, así
// que NO sirve como perímetro de un solo incendio. Lo que se hace es tomar, de
// cada evento, la VENTANA de N días con más detecciones (el episodio de
// propagación activa) y usar las celdas tocadas en esa ventana como perímetro
// observado. La ignición es la detección más temprana de esa ventana.
//
// FUNCIÓN OBJETIVO
// ----------------
// F1 (equivalente al coeficiente de Sørensen–Dice) entre el conjunto de celdas
// quemadas simuladas y el observado, promediado sobre los eventos y sobre
// varias semillas (el autómata es estocástico), con penalización si el área
// simulada se dispara respecto de la real.
//
// El resultado se guarda en el almacén del servidor (almacen/db.js) y lo
// consume motor/parametros.js en la siguiente simulación.
// ============================================================================

import { perimetroSimulado, CONSTANTES_POR_DEFECTO } from "./automata.js";
import { celdaEn, obtenerIndice } from "../servicios/grid.js";
import { obtenerSerieVientoHistorica } from "../servicios/meteo.js";
import {
  guardarCalibracion as persistirCalibracion,
  leerCalibracion as leerCalibracionDb,
} from "../almacen/db.js";

const MINUTOS_POR_ITERACION = 15; // el mismo que usa la simulación en producción

// ---------------------------------------------------------------------------
// Espacio de búsqueda: [mínimo, máximo, ¿entero?]
// ---------------------------------------------------------------------------
export const GENES = {
  p_base:              [0.02, 0.80, false],
  K_PENDIENTE_ARRIBA:  [0.50, 8.00, false],
  K_PENDIENTE_ABAJO:   [0.10, 4.00, false],
  K_VIENTO:            [0.02, 0.60, false],
  K_HUMEDAD:           [0.10, 1.50, false],
  RESIDENCIA_MAX:      [2, 10, true],
  SPOTTING_PROB:       [0.000, 0.060, false],
};
const NOMBRES = Object.keys(GENES);

// ===========================================================================
// 1. Perímetros observados a partir de NASA FIRMS
// ===========================================================================
/**
 * @param {Array} grid
 * @param {Array} focos       focos.csv (con columnas fecha y evento)
 * @param {Object} opciones   { ventanaDias = 4, minCeldas = 15 }
 * @returns {Array} [{ evento, celdas:Set, foco:{fila,columna}, desde, hasta, pasos }]
 */
export function construirPerimetrosReales(grid, focos, opciones = {}) {
  const { ventanaDias = 4, minCeldas = 15 } = opciones;
  const porEvento = new Map();

  for (const f of focos) {
    if (!f.evento || f.lat == null || f.lon == null) continue;
    const clave = String(f.evento);
    if (!porEvento.has(clave)) porEvento.set(clave, []);
    porEvento.get(clave).push(f);
  }

  const perimetros = [];
  const MS_DIA = 86400000;
  const ix = obtenerIndice();
  const porId = ix.porId;

  for (const [evento, lista] of porEvento) {
    const ordenados = lista
      .map((f) => ({ ...f, t: Date.parse(f.fecha) }))
      .filter((f) => Number.isFinite(f.t))
      .sort((a, b) => a.t - b.t);
    if (ordenados.length < minCeldas) continue;

    // Ventana deslizante de `ventanaDias` con más detecciones (episodio activo)
    const ancho = ventanaDias * MS_DIA;
    let mejor = { inicio: 0, fin: 0, n: 0 };
    let j = 0;
    for (let i = 0; i < ordenados.length; i++) {
      while (j < ordenados.length && ordenados[j].t - ordenados[i].t <= ancho) j++;
      if (j - i > mejor.n) mejor = { inicio: i, fin: j, n: j - i };
    }

    const enVentana = ordenados.slice(mejor.inicio, mejor.fin);
    const celdas = new Set();
    let celdaFoco = null;
    // Igniciones del PRIMER día de la ventana: es el estado inicial realista
    // (FIRMS ve varios focos simultáneos, no uno solo).
    const tPrimerDia = enVentana[0].t + MS_DIA;
    const iniciales = new Map();
    const idsIniciales = new Set();
    for (const f of enVentana) {
      const c = celdaEn(f.lat, f.lon);
      if (!c) continue;
      celdas.add(c.id);
      if (!celdaFoco) celdaFoco = c;
      if (f.t <= tPrimerDia) {
        iniciales.set(`${c.fila},${c.columna}`, { fila: c.fila, columna: c.columna });
        idsIniciales.add(c.id);
      }
    }
    if (celdas.size < minCeldas || !celdaFoco) continue;

    perimetros.push({
      evento,
      celdas,
      dilatar: (conjunto) => dilatar(conjunto, porId, ix.porFilaCol, 1),
      foco: { fila: celdaFoco.fila, columna: celdaFoco.columna },
      desde: enVentana[0].fecha,
      hasta: enVentana[enVentana.length - 1].fecha,
      detecciones: enVentana.length,
      iniciales: [...iniciales.values()],
      idsIniciales: idsIniciales,
      area_km2: +(celdas.size * 0.25).toFixed(1),
      pasos: Math.round((ventanaDias * 24 * 60) / MINUTOS_POR_ITERACION),
    });
  }

  return perimetros.sort((a, b) => b.celdas.size - a.celdas.size);
}

// ===========================================================================
// 2. Métricas de comparación de perímetros
// ===========================================================================
// NOTA METODOLÓGICA IMPORTANTE
// ----------------------------
// El "perímetro real" son detecciones VIIRS puntuales (375 m) tomadas 1-2 veces
// al día: NO es un polígono relleno, es un muestreo disperso del área quemada.
// Exigir coincidencia celda a celda contra un muestreo disperso subestima
// cualquier modelo. Por eso el F1 se calcula sobre el conjunto observado
// DILATADO 1 celda (±500 m), que es la práctica habitual al validar contra
// FIRMS. Se reportan siempre las dos cifras: estricta y con tolerancia.

/** Dilata un conjunto de celdas `radio` celdas en la vecindad de Moore. */
export function dilatar(celdas, indicePorId, indicePorFilaCol, radio = 1) {
  const salida = new Set(celdas);
  for (const id of celdas) {
    const c = indicePorId.get(id);
    if (!c) continue;
    for (let df = -radio; df <= radio; df++) {
      for (let dc = -radio; dc <= radio; dc++) {
        const v = indicePorFilaCol.get(`${c.fila + df},${c.columna + dc}`);
        if (v) salida.add(v.id);
      }
    }
  }
  return salida;
}

/**
 * Compara perímetros. `excluir` quita las celdas de ignición inicial de ambos
 * conjuntos: si no, el F1 premiaría al modelo por celdas que se le REGALARON
 * como condición inicial. Lo que se mide así es solo lo que el motor PREDIJO.
 */
export function compararPerimetros(simulado, real, opciones = {}) {
  const { excluir = null, dilatarSet = null } = opciones;
  let sim = simulado, obs = real;
  if (excluir && excluir.size) {
    sim = new Set([...sim].filter((id) => !excluir.has(id)));
    obs = new Set([...obs].filter((id) => !excluir.has(id)));
  }

  // --- Métrica ESTRICTA (celda a celda) ---
  let inter = 0;
  for (const id of sim) if (obs.has(id)) inter++;
  const precisionEstricta = sim.size ? inter / sim.size : 0;
  const recallEstricto = obs.size ? inter / obs.size : 0;
  const f1Estricto = precisionEstricta + recallEstricto > 0
    ? (2 * precisionEstricta * recallEstricto) / (precisionEstricta + recallEstricto) : 0;
  const unionEstricta = sim.size + obs.size - inter;

  const base = {
    f1_estricto: f1Estricto,
    iou_estricto: unionEstricta ? inter / unionEstricta : 0,
    area_sim: sim.size,
    area_real: obs.size,
    razon_area: obs.size ? sim.size / obs.size : 0,
  };

  if (!dilatarSet) {
    return { ...base, f1: f1Estricto, precision: precisionEstricta, recall: recallEstricto, iou: base.iou_estricto };
  }

  // --- Métrica CON TOLERANCIA, simétrica ---
  // precision: ¿cuántas celdas simuladas caen a ≤1 celda de una detección real?
  // recall:    ¿cuántas detecciones reales quedan a ≤1 celda de una simulada?
  // Al ser simétrica, inflar el área simulada NO mejora la precisión, así que
  // el modelo no puede hacer trampa quemándolo todo.
  const obsDilatado = dilatarSet(obs);
  const simDilatado = dilatarSet(sim);
  let aciertos = 0;
  for (const id of sim) if (obsDilatado.has(id)) aciertos++;
  let cubiertos = 0;
  for (const id of obs) if (simDilatado.has(id)) cubiertos++;

  const precision = sim.size ? aciertos / sim.size : 0;
  const recall = obs.size ? cubiertos / obs.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { ...base, f1, precision, recall, iou: f1 / (2 - f1) };
}

// ===========================================================================
// 3. Evaluación de un individuo (juego de constantes)
// ===========================================================================
function genesAParametros(vector) {
  const out = {};
  NOMBRES.forEach((nombre, i) => {
    const [min, max, entero] = GENES[nombre];
    let v = Math.min(Math.max(vector[i], min), max);
    if (entero) v = Math.round(v);
    out[nombre] = v;
  });
  return out;
}

function evaluar(vector, grid, perimetros, opciones) {
  const { semillas = [1, 2], elevacion = null, barrerasExtra = null } = opciones;
  const g = genesAParametros(vector);
  const constantes = {
    ...CONSTANTES_POR_DEFECTO,
    K_PENDIENTE_ARRIBA: g.K_PENDIENTE_ARRIBA,
    K_PENDIENTE_ABAJO: g.K_PENDIENTE_ABAJO,
    K_VIENTO: g.K_VIENTO,
    K_HUMEDAD: g.K_HUMEDAD,
    RESIDENCIA_MAX: Math.max(g.RESIDENCIA_MAX, CONSTANTES_POR_DEFECTO.RESIDENCIA_MIN),
    SPOTTING_PROB: g.SPOTTING_PROB,
  };

  let suma = 0, n = 0;
  const detalle = [];

  for (const per of perimetros) {
    let f1Evento = 0;
    let metricas = null;
    for (const semilla of semillas) {
      const sim = perimetroSimulado(
        grid,
        {
          foco_fila: per.foco.fila,
          foco_columna: per.foco.columna,
          focos_iniciales: per.iniciales,
          p_base: g.p_base,
          num_iteraciones: per.pasos,
          minutos_por_iteracion: MINUTOS_POR_ITERACION,
          multiplicador_viento: 1,
          delta_humedad: 0,
          delta_temperatura_c: 0,
          semilla,
          serie_viento: per.serieViento || null,
        },
        { constantes, elevacion, barrerasExtra, limiteCeldas: per.celdas.size * 8 }
      );
      const m = compararPerimetros(sim, per.celdas, {
        excluir: per.idsIniciales,
        dilatarSet: per.dilatar,
      });
      // Penalización por sobrepredicción: un incendio que se come el municipio
      // puede tener recall alto y no sirve de nada.
      const castigo = m.razon_area > 3 ? 3 / m.razon_area : 1;
      f1Evento += m.f1 * castigo;
      if (!metricas) metricas = m;
    }
    f1Evento /= semillas.length;
    suma += f1Evento; n++;
    detalle.push({ evento: per.evento, f1: f1Evento, ...metricas });
  }

  return { aptitud: n ? suma / n : 0, detalle, genes: g, constantes };
}

// ===========================================================================
// 4. Evolución diferencial (DE/rand/1/bin)
// ===========================================================================
/**
 * @param {Array} grid
 * @param {Array} focos        focos.csv
 * @param {Object} opciones
 *    - poblacion (16), generaciones (14), F (0.7), CR (0.9)
 *    - semillas: semillas del autómata por evaluación
 *    - elevacion, barrerasExtra: mismos que el autómata
 *    - onProgreso: (fraccion, mejor) => void
 */
export async function calibrar(grid, focos, opciones = {}) {
  const {
    poblacion = 12,
    generaciones = 10,
    F = 0.7,
    CR = 0.9,
    ventanaDias = 4,
    onProgreso = null,
    elevacion = null,
    barrerasExtra = null,
    semillas = [1, 2],
  } = opciones;

  const perimetros = construirPerimetrosReales(grid, focos, { ventanaDias });

  // Viento REAL de cada episodio (ERA5). Sin esto el motor acierta el área pero
  // no la dirección de avance, que es la mitad de la información útil.
  if (opciones.usarVientoHistorico !== false) {
    for (const per of perimetros) {
      try {
        const celdaFoco = grid.find((c) => c.fila === per.foco.fila && c.columna === per.foco.columna);
        if (celdaFoco) {
          per.serieViento = await obtenerSerieVientoHistorica(
            celdaFoco.lat, celdaFoco.lon, per.desde, per.hasta
          );
        }
      } catch (e) {
        console.warn(`Sin viento histórico para ${per.evento}:`, e.message);
      }
    }
  }

  if (!perimetros.length) {
    throw new Error(
      "No hay perímetros reales utilizables en focos.csv (se necesitan focos etiquetados por evento)."
    );
  }

  const dim = NOMBRES.length;
  const azar = (i) => {
    const [min, max] = GENES[NOMBRES[i]];
    return min + Math.random() * (max - min);
  };

  // Población inicial: aleatoria + un individuo con las constantes actuales
  let pob = Array.from({ length: poblacion }, () =>
    Array.from({ length: dim }, (_, i) => azar(i))
  );
  pob[0] = NOMBRES.map((nombre) =>
    nombre === "p_base" ? 0.30 : CONSTANTES_POR_DEFECTO[nombre] ?? azar(NOMBRES.indexOf(nombre))
  );

  const evalOpts = { semillas, elevacion, barrerasExtra };
  let puntajes = pob.map((ind) => evaluar(ind, grid, perimetros, evalOpts));
  let mejorIdx = puntajes.reduce((m, p, i) => (p.aptitud > puntajes[m].aptitud ? i : m), 0);

  const historia = [{ generacion: 0, mejor: puntajes[mejorIdx].aptitud }];
  const totalPasos = generaciones * poblacion;
  let hechos = 0;

  for (let g = 1; g <= generaciones; g++) {
    for (let i = 0; i < poblacion; i++) {
      // Mutación DE/rand/1
      let a, b, c;
      do { a = Math.floor(Math.random() * poblacion); } while (a === i);
      do { b = Math.floor(Math.random() * poblacion); } while (b === i || b === a);
      do { c = Math.floor(Math.random() * poblacion); } while (c === i || c === a || c === b);

      const jAzar = Math.floor(Math.random() * dim);
      const prueba = pob[i].map((v, j) => {
        if (Math.random() < CR || j === jAzar) {
          const [min, max] = GENES[NOMBRES[j]];
          return Math.min(Math.max(pob[a][j] + F * (pob[b][j] - pob[c][j]), min), max);
        }
        return v;
      });

      const res = evaluar(prueba, grid, perimetros, evalOpts);
      if (res.aptitud > puntajes[i].aptitud) { pob[i] = prueba; puntajes[i] = res; }

      hechos++;
      if (onProgreso && hechos % 4 === 0) {
        const mi = puntajes.reduce((m, p, k) => (p.aptitud > puntajes[m].aptitud ? k : m), 0);
        onProgreso(hechos / totalPasos, puntajes[mi]);
        // Cede el hilo para que la interfaz no se congele
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    mejorIdx = puntajes.reduce((m, p, i) => (p.aptitud > puntajes[m].aptitud ? i : m), 0);
    historia.push({ generacion: g, mejor: puntajes[mejorIdx].aptitud });
  }

  const mejor = puntajes[mejorIdx];
  const resultado = {
    fecha: new Date().toISOString(),
    metodo: `Evolución diferencial DE/rand/1/bin · población ${poblacion} · ${generaciones} generaciones`,
    p_base: mejor.genes.p_base,
    constantes: mejor.constantes,
    f1: mejor.aptitud,
    detalle: mejor.detalle,
    historia,
    perimetros: perimetros.map((p) => ({
      evento: p.evento, celdas: p.celdas.size, area_km2: p.area_km2,
      desde: p.desde, hasta: p.hasta, detecciones: p.detecciones,
      foco: p.foco, pasos: p.pasos,
    })),
    minutos_por_iteracion: MINUTOS_POR_ITERACION,
  };

  await persistirCalibracion(resultado);
  return resultado;
}

// ===========================================================================
// 5. Persistencia (delegada al almacén del servidor)
// ===========================================================================
export const guardarCalibracion = persistirCalibracion;
export const leerCalibracion = leerCalibracionDb;
