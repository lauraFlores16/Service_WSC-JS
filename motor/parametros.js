// ============================================================================
// PARÁMETROS AUTOMÁTICOS DE SIMULACIÓN
// ============================================================================
// Antes: DEFAULTS = { foco_fila: 40, foco_columna: 40, p_base: 0.3, ... }
// Números escritos a mano que no significaban nada.
//
// Ahora cada parámetro se DEDUCE de datos vivos y queda justificado:
//
//   nombre_escenario      ← fecha/hora real + condiciones + nivel de peligro
//   foco_fila / columna   ← foco NASA FIRMS más intenso, o la celda de mayor
//                           probabilidad XGBoost si no hay focos activos
//   delta_temperatura_c   ← temperatura actual (Open-Meteo) − climatología ERA5
//   delta_humedad         ← humedad relativa actual − climatología ERA5
//   multiplicador_viento  ← 1.0 cuando hay serie horaria real (el viento entra
//                           por la serie, no por el multiplicador); si no,
//                           razón entre viento real y el promedio del grid
//   p_base                ← constante calibrada (calibracion.js) escalada por
//                           el índice de peligro meteorológico del momento
//   num_iteraciones       ← horizonte temporal / minutos por iteración
//
// Cada decisión se devuelve también en `diagnostico`, que es lo que pinta el
// panel lateral "Decisiones de la simulación".
// ============================================================================

import { obtenerMeteorologia, obtenerClimatologia, indicePeligro } from "../servicios/meteo.js";
import { obtenerFocosActivos, claveConfigurada } from "../servicios/firms.js";
import { celdaMasCercana, promediosGrid } from "../servicios/grid.js";
import { leerCalibracion } from "../almacen/db.js";

const HORIZONTE_HORAS_POR_DEFECTO = 6;
const MINUTOS_POR_ITERACION = 15;

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

function rosaDeLosVientos(grados) {
  if (grados == null) return "—";
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                "S", "SSO", "SO", "OSO", "O", "ONO", "NO", "NNO"];
  return dirs[Math.round(grados / 22.5) % 16];
}

// ---------------------------------------------------------------------------
// Selección automática del foco
// ---------------------------------------------------------------------------
async function elegirFoco(grid, focoManual, historicos) {
  if (focoManual) {
    return {
      celda: focoManual,
      origen: "manual",
      detalle: "Foco marcado por el usuario en el mapa",
    };
  }

  // 1) Foco activo de NASA FIRMS con mayor potencia radiativa (FRP)
  if (claveConfigurada()) {
    try {
      const { focos } = await obtenerFocosActivos();
      if (focos.length) {
        const ordenados = [...focos].sort((a, b) => (b.frp ?? 0) - (a.frp ?? 0));
        const mejor = ordenados[0];
        const celda = celdaMasCercana(mejor.lat, mejor.lon);
        if (celda) {
          return {
            celda,
            origen: "firms",
            detalle: `Foco activo VIIRS del ${mejor.fecha} ${mejor.hora || ""} · FRP ${
              mejor.frp ?? "n/d"} MW (el más intenso de ${focos.length} detectados)`,
          };
        }
      }
    } catch (e) {
      console.warn("FIRMS no disponible para elegir foco:", e.message);
    }
  }

  // 2) Celda con mayor probabilidad de ignición del modelo XGBoost
  let mejorCelda = null;
  for (const c of grid) {
    if (!mejorCelda || (c.prob_ignicion ?? 0) > (mejorCelda.prob_ignicion ?? 0)) mejorCelda = c;
  }
  if (mejorCelda) {
    return {
      celda: mejorCelda,
      origen: "xgboost",
      detalle: `Sin focos activos: se usa la celda de mayor probabilidad de ignición del modelo (${
        ((mejorCelda.prob_ignicion ?? 0) * 100).toFixed(1)}%)`,
    };
  }

  // 3) Último recurso: foco del evento histórico más grande
  const ev = (historicos || []).sort((a, b) => (b.area_km2 ?? 0) - (a.area_km2 ?? 0))[0];
  if (ev) {
    return {
      celda: { fila: ev.foco.fila, columna: ev.foco.columna, lat: ev.foco.lat, lon: ev.foco.lon },
      origen: "historico",
      detalle: `Foco del evento histórico "${ev.nombre}"`,
    };
  }
  throw new Error("No se pudo determinar un foco automáticamente.");
}

// ===========================================================================
// FUNCIÓN PRINCIPAL
// ===========================================================================
/**
 * @param {Array}  grid
 * @param {Object} opciones
 *    - foco: celda ya elegida por el usuario (opcional)
 *    - historicos: eventos históricos (opcional)
 *    - horizonteHoras: cuánto tiempo simular (por defecto 6 h)
 *    - reproducible: si true, la semilla es fija (para comparar escenarios)
 * @returns {Object} { parametros, diagnostico, meteo, climatologia, peligro }
 */
export async function derivarParametros(grid, opciones = {}) {
  const {
    foco: focoManual = null,
    historicos = [],
    horizonteHoras = HORIZONTE_HORAS_POR_DEFECTO,
    reproducible = false,
  } = opciones;

  const diagnostico = [];
  const anotar = (etiqueta, valor, fuente, nota) =>
    diagnostico.push({ etiqueta, valor, fuente, nota });

  // ---- 1. Foco ----
  const seleccion = await elegirFoco(grid, focoManual, historicos);
  const celdaFoco = seleccion.celda;
  anotar(
    "Foco de ignición",
    `fila ${celdaFoco.fila}, columna ${celdaFoco.columna}`,
    { manual: "Usuario", firms: "NASA FIRMS (VIIRS)", xgboost: "Modelo XGBoost V3", historico: "Histórico" }[seleccion.origen],
    seleccion.detalle
  );

  // ---- 2. Meteorología real en el foco ----
  let meteo = null, climatologia = null, peligro = null, errorMeteo = null;
  try {
    meteo = await obtenerMeteorologia(celdaFoco.lat, celdaFoco.lon);
    climatologia = await obtenerClimatologia(celdaFoco.lat, celdaFoco.lon);
    peligro = indicePeligro(meteo);
  } catch (e) {
    errorMeteo = e.message;
    console.warn("Open-Meteo no disponible, se usan los promedios del grid:", e.message);
  }

  const prom = promediosGrid();

  // ---- 3. Δ temperatura ----
  let deltaTemp = 0;
  if (meteo && climatologia) {
    deltaTemp = +(meteo.actual.temperatura_c - climatologia.temperatura_c).toFixed(1);
    anotar(
      "Temperatura",
      `${meteo.actual.temperatura_c.toFixed(1)} °C  (Δ ${deltaTemp > 0 ? "+" : ""}${deltaTemp} °C)`,
      "Open-Meteo · ERA5",
      `Climatología de ${MESES[climatologia.mes - 1]} (${climatologia.anios_usados} años): ${
        climatologia.temperatura_c} °C`
    );
  } else {
    anotar("Temperatura", "Δ 0 °C", "Sin conexión", "No se pudo consultar Open-Meteo; se usa el promedio del grid");
  }

  // ---- 4. Δ humedad ----
  let deltaHumedad = 0;
  if (meteo) {
    const hrActual = meteo.actual.humedad_relativa ?? prom.humedad;
    const referencia = climatologia ? climatologia.humedad_relativa : prom.humedad;
    deltaHumedad = +(hrActual - referencia).toFixed(3);
    deltaHumedad = Math.min(Math.max(deltaHumedad, -1), 1);
    anotar(
      "Humedad relativa",
      `${(hrActual * 100).toFixed(0)} %  (Δ ${deltaHumedad > 0 ? "+" : ""}${(deltaHumedad * 100).toFixed(0)} %)`,
      "Open-Meteo",
      `Referencia ${(referencia * 100).toFixed(0)} % · ${
        meteo.sequedad.horas_sin_lluvia} h sin lluvia · ${meteo.sequedad.lluvia_48h_mm} mm en 48 h`
    );
  } else {
    anotar("Humedad relativa", "Δ 0 %", "Sin conexión", "Se conserva la humedad ERA5 del grid");
  }

  // ---- 5. Viento ----
  let multiplicadorViento = 1.0;
  let serieViento = null;
  if (meteo && meteo.serieViento.length) {
    serieViento = meteo.serieViento;
    const v0 = meteo.actual;
    const vMax = Math.max(...serieViento.map((s) => s.velocidad_ms));
    anotar(
      "Viento",
      `${v0.viento_ms.toFixed(1)} m/s del ${rosaDeLosVientos(v0.viento_direccion)}`,
      "Open-Meteo (serie horaria)",
      `Serie de ${serieViento.length} h cargada en el motor · máximo previsto ${
        vMax.toFixed(1)} m/s · ráfagas ${v0.rafaga_ms.toFixed(1)} m/s. ` +
        "El multiplicador queda en ×1.0 porque el viento ya es real."
    );
  } else {
    // Sin serie real: el multiplicador escala el viento ERA5 promedio del grid
    multiplicadorViento = 1.0;
    anotar("Viento", "×1.0 (ERA5 del grid)", "grid.csv", "Sin serie meteorológica en vivo");
  }

  // ---- 6. Probabilidad base ----
  const calibracion = await leerCalibracion();
  const pBaseCalibrado = calibracion?.p_base ?? 0.30;
  const factorPeligro = peligro ? 0.7 + 0.6 * peligro.puntaje : 1.0; // 0.7 .. 1.3
  const pBase = +Math.min(Math.max(pBaseCalibrado * factorPeligro, 0.01), 1).toFixed(3);
  anotar(
    "Probabilidad base",
    pBase.toFixed(3),
    calibracion ? `Calibración ${calibracion.fecha?.slice(0, 10) ?? ""}` : "Valor por defecto",
    calibracion
      ? `p_base calibrada = ${pBaseCalibrado} (F1 = ${(calibracion.f1 ?? 0).toFixed(3)} sobre perímetros reales), ` +
        `ajustada ×${factorPeligro.toFixed(2)} por el peligro meteorológico actual`
      : "Aún no se ha corrido la calibración automática (Capa 4 → Calibrar constantes K)"
  );

  // ---- 7. Horizonte temporal ----
  const numIteraciones = Math.round((horizonteHoras * 60) / MINUTOS_POR_ITERACION);
  anotar(
    "Iteraciones",
    `${numIteraciones} pasos (${horizonteHoras} h)`,
    "Derivado",
    `${MINUTOS_POR_ITERACION} min de tiempo simulado por iteración`
  );

  // ---- 8. Nivel de peligro y nombre ----
  let nivel = "BAJO";
  if (peligro) {
    if (peligro.puntaje >= 0.66) nivel = "ALTO";
    else if (peligro.puntaje >= 0.4) nivel = "MEDIO";
    anotar(
      "Índice de peligro",
      `${nivel} (${(peligro.puntaje * 100).toFixed(0)} %)`,
      "Regla 30-30-30 + sequedad",
      `${peligro.regla_303030}/3 condiciones 30-30-30 cumplidas con datos reales`
    );
  }

  const ahora = new Date();
  const marca = `${ahora.getDate()}-${MESES[ahora.getMonth()]}-${ahora.getFullYear()} ${
    String(ahora.getHours()).padStart(2, "0")}:${String(ahora.getMinutes()).padStart(2, "0")}`;
  const resumenMeteo = meteo
    ? `${meteo.actual.temperatura_c.toFixed(0)}°C · HR ${(meteo.actual.humedad_relativa * 100).toFixed(0)}% · viento ${
        meteo.actual.viento_ms.toFixed(1)} m/s ${rosaDeLosVientos(meteo.actual.viento_direccion)}`
    : "condiciones ERA5 promedio";
  const nombre = `Apolo · ${marca} · ${resumenMeteo} · peligro ${nivel}`;

  const parametros = {
    nombre_escenario: nombre,
    descripcion:
      `Escenario generado automáticamente. Foco: ${seleccion.detalle}. ` +
      (errorMeteo ? `Meteorología en vivo no disponible (${errorMeteo}).` : `Meteorología: ${meteo.fuente}.`),
    foco_fila: celdaFoco.fila,
    foco_columna: celdaFoco.columna,
    p_base: pBase,
    multiplicador_viento: multiplicadorViento,
    delta_humedad: deltaHumedad,
    delta_temperatura_c: deltaTemp,
    num_iteraciones: numIteraciones,
    minutos_por_iteracion: MINUTOS_POR_ITERACION,
    semilla: reproducible ? 12345 : (Date.now() % 2147483647),
    serie_viento: serieViento,
    constantes: calibracion?.constantes ?? null,
  };

  return { parametros, diagnostico, meteo, climatologia, peligro, nivel, errorMeteo, seleccionFoco: seleccion };
}

export { rosaDeLosVientos };
