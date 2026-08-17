// ============================================================================
// ALERTAS DE RIESGO — sin necesidad de simular
// ============================================================================
// Antes solo había alertas DESPUÉS de ejecutar una simulación (se generaban de
// las iteraciones). Resultado: al abrir Monitoreo, el panel de alertas estaba
// siempre vacío hasta que corrías un escenario.
//
// Estas alertas son distintas: miran el estado ACTUAL del municipio y avisan del
// peligro aunque no haya ninguna simulación en marcha. Combinan dos señales que
// el sistema ya tiene:
//
//   · La probabilidad de ignición del modelo XGBoost por celda (grid.csv).
//   · Las condiciones meteorológicas reales del momento (Open-Meteo), vía la
//     regla 30-30-30 + sequedad que ya calcula servicios/meteo.js.
//
// La lógica: cuántas celdas de alta probabilidad hay, y con qué peligro
// meteorológico. Muchas celdas peligrosas + tiempo seco y ventoso = alerta roja.
// ============================================================================
import { obtenerGrid } from "../servicios/grid.js";
import { obtenerMeteorologia, indicePeligro } from "../servicios/meteo.js";
import { APOLO } from "../config.js";

const PROB_ALTA = 0.75;   // celda "de alto riesgo" según XGBoost
const PROB_MUY_ALTA = 0.90;

export async function calcularAlertasRiesgo() {
  const grid = obtenerGrid();
  if (!grid || !grid.length) return [];

  // --- Señal 1: distribución de probabilidad de ignición ---
  let altas = 0, muyAltas = 0, celdaTope = null;
  for (const c of grid) {
    const p = c.prob_ignicion;
    if (p == null || Number.isNaN(p)) continue;
    if (p >= PROB_ALTA) altas++;
    if (p >= PROB_MUY_ALTA) muyAltas++;
    if (!celdaTope || p > celdaTope.prob_ignicion) celdaTope = c;
  }

  // --- Señal 2: peligro meteorológico actual ---
  let meteo = null, peligro = null;
  try {
    meteo = await obtenerMeteorologia(APOLO.lat, APOLO.lon);
    peligro = indicePeligro(meteo);
  } catch { /* sin meteo: se avisa solo por probabilidad */ }

  const alertas = [];
  const ahora = new Date().toISOString();
  const puntaje = peligro?.puntaje ?? 0;

  // Regla combinada: el nivel sube cuando coinciden muchas celdas peligrosas y
  // condiciones meteorológicas adversas.
  if (muyAltas > 0 && puntaje >= 0.66) {
    alertas.push({
      origen: "riesgo", nivel: "roja",
      mensaje: `Riesgo extremo: ${muyAltas} celdas con probabilidad ≥ ${PROB_MUY_ALTA} y peligro meteorológico ALTO (${(puntaje * 100).toFixed(0)}%).`,
      lat: celdaTope?.lat ?? null, lon: celdaTope?.lon ?? null, creada_en: ahora,
    });
  } else if (altas > 0 && puntaje >= 0.4) {
    alertas.push({
      origen: "riesgo", nivel: "naranja",
      mensaje: `Riesgo elevado: ${altas} celdas de alta probabilidad con peligro meteorológico MEDIO (${(puntaje * 100).toFixed(0)}%).`,
      lat: celdaTope?.lat ?? null, lon: celdaTope?.lon ?? null, creada_en: ahora,
    });
  } else if (altas > 0) {
    alertas.push({
      origen: "riesgo", nivel: "amarilla",
      mensaje: `${altas} celdas con probabilidad de ignición ≥ ${PROB_ALTA} en el municipio.`,
      lat: celdaTope?.lat ?? null, lon: celdaTope?.lon ?? null, creada_en: ahora,
    });
  }

  // Alerta meteorológica independiente: tiempo de incendio aunque el modelo no
  // marque celdas concretas (viento fuerte + baja humedad + sequía).
  if (peligro && puntaje >= 0.66 && !alertas.some((a) => a.nivel === "roja")) {
    const reglas = peligro.regla_303030;
    alertas.push({
      origen: "riesgo", nivel: "naranja",
      mensaje: `Condiciones de incendio: ${reglas}/3 de la regla 30-30-30 cumplidas (temperatura, humedad y viento).`,
      lat: APOLO.lat, lon: APOLO.lon, creada_en: ahora,
    });
  }

  return alertas;
}
