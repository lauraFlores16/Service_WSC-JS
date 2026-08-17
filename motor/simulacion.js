// ============================================================================
// SIMULACIÓN — orquestación del lado servidor
// ============================================================================
// Es el mismo flujo que antes corría en el navegador (simulacionLocal.ejecutar),
// movido aquí. Ventajas de que viva en el servidor:
//
//   · El navegador ya no congela la pestaña mientras corre el autómata.
//   · El DEM, las barreras de OSM y la serie de viento se inyectan desde la
//     caché del servidor: no viajan por la red en cada simulación.
//   · Los escenarios se guardan en disco, sin el tope de 5 MB del localStorage.
//     Aun así se sigue comprimiendo a deltas, que es lo correcto de todos modos.
// ============================================================================

import crypto from "node:crypto";
import { ejecutarAutomata } from "./automata.js";
import { evaluarAlertas } from "./alertas.js";
import { obtenerGrid, obtenerIndice } from "../servicios/grid.js";
import { obtenerDem, obtenerTerrenoOsm } from "../servicios/terreno.js";
import { leerCalibracion, guardarEscenario, obtenerEscenario } from "../almacen/db.js";

const AREA_POR_CELDA_HA = 25.0;

/**
 * Ejecuta una simulación completa y la guarda.
 * Las fuentes de la Capa 1 (DEM y barreras) se resuelven aquí: el cliente ya no
 * tiene que mandarlas, solo dice qué quiere simular.
 */
export async function ejecutarSimulacion(parametros, opciones = {}) {
  const grid = obtenerGrid();
  const indice = obtenerIndice();

  // --- Capa 1: relieve y barreras, desde la caché del servidor ---
  let elevacion = null, barrerasExtra = null, resumenTerreno = null;
  if (opciones.usarTerreno !== false) {
    try {
      const dem = await obtenerDem(parametros.foco_fila, parametros.foco_columna,
                                   opciones.radioDem ?? 20);
      elevacion = new Map(Object.entries(dem.alturas));
    } catch (e) {
      console.warn("[simulacion] sin DEM:", e.message);
    }
    try {
      const osm = await obtenerTerrenoOsm();
      barrerasExtra = new Set(osm.barreras);
      resumenTerreno = osm.resumen;
    } catch (e) {
      console.warn("[simulacion] sin capa OSM:", e.message);
    }
  }

  // --- Constantes: las calibradas, salvo que vengan explícitas ---
  const calibracion = await leerCalibracion();
  const constantes = parametros.constantes || opciones.constantes || calibracion?.constantes || null;

  const iteraciones = ejecutarAutomata(grid, parametros, {
    elevacion,
    barrerasExtra,
    serieViento: parametros.serie_viento || opciones.serieViento || null,
    constantes,
  });

  // --- Alertas ---
  const escenarioId = crypto.randomUUID();
  const probs = new Map(grid.map((c) => [c.id, c.prob_ignicion]));
  const alertas = [];
  for (let i = 0; i < iteraciones.length; i++) {
    alertas.push(...evaluarAlertas(escenarioId, iteraciones[i], i > 0 ? iteraciones[i - 1] : null, probs));
  }

  // --- Variables ambientales medias del área quemada (comparación histórica) ---
  const ultima = iteraciones[iteraciones.length - 1];
  const acc = { ndvi: 0, humedad: 0, velocidad_viento: 0, temperatura_aire: 0 };
  let nq = 0;
  for (const celda of ultima.celdas) {
    const c = indice.porId.get(celda.celda_id);
    if (!c) continue;
    acc.ndvi += c.ndvi ?? 0;
    acc.humedad += c.humedad ?? 0;
    acc.velocidad_viento += Math.hypot(c.viento_u ?? 0, c.viento_v ?? 0);
    acc.temperatura_aire += c.temperatura_aire ?? c.lst_c ?? 0;
    nq++;
  }
  const variablesPromedio = nq
    ? {
        ndvi: +(acc.ndvi / nq).toFixed(4),
        humedad: +(acc.humedad / nq).toFixed(4),
        velocidad_viento: +(acc.velocidad_viento / nq).toFixed(4),
        temperatura_aire: +(acc.temperatura_aire / nq).toFixed(4),
      }
    : null;

  const celdaFoco = indice.porFilaCol.get(`${parametros.foco_fila},${parametros.foco_columna}`);

  // --- Compresión a deltas: solo lo que CAMBIÓ en cada iteración ---
  const estadoPrev = new Map();
  const iteracionesDelta = iteraciones.map((it) => {
    const cambios = [];
    for (const c of it.celdas) {
      if (estadoPrev.get(c.celda_id) !== c.estado) {
        cambios.push({
          celda_id: c.celda_id,
          lat: +c.lat.toFixed(5),
          lon: +c.lon.toFixed(5),
          estado: c.estado,
        });
        estadoPrev.set(c.celda_id, c.estado);
      }
    }
    return {
      iteracion: it.iteracion,
      num_celdas_ardiendo: it.num_celdas_ardiendo,
      num_celdas_quemadas: it.num_celdas_quemadas,
      viento: it.viento || null,
      cambios,
    };
  });

  const escenario = {
    escenario_id: escenarioId,
    nombre: parametros.nombre_escenario || `Escenario ${new Date().toISOString()}`,
    descripcion: parametros.descripcion || null,
    parametros: { ...parametros, serie_viento: undefined }, // la serie no se guarda entera
    horas_serie_viento: parametros.serie_viento ? parametros.serie_viento.length : 0,
    creado_en: new Date().toISOString(),
    creado_por: opciones.usuario?.nombre || "demo",
    iteraciones_delta: iteracionesDelta,
    alertas,
    variables_promedio: variablesPromedio,
    foco_coordenadas: celdaFoco ? { lat: celdaFoco.lat, lon: celdaFoco.lon } : null,
    area_final_ha: ultima.num_celdas_quemadas * AREA_POR_CELDA_HA,
    metadatos_motor: {
      constantes: iteraciones.metadatos.constantes,
      usa_dem: iteraciones.metadatos.usa_dem,
      celdas_con_dem: iteraciones.metadatos.celdas_con_dem,
      usa_serie_viento: iteraciones.metadatos.usa_serie_viento,
      barreras_osm: iteraciones.metadatos.barreras_osm,
      saltos_spotting: iteraciones.metadatos.eventos_spotting.length,
      minutos_por_iteracion: iteraciones.metadatos.minutos_por_iteracion,
      resumen_terreno: resumenTerreno,
      calibrado: Boolean(constantes),
    },
    diagnostico: parametros.diagnostico || null,
  };

  await guardarEscenario(escenario);

  return {
    escenario_id: escenarioId,
    parametros: escenario.parametros,
    iteraciones,                       // completas, para animar de inmediato
    metadatos_motor: escenario.metadatos_motor,
  };
}

// ---------------------------------------------------------------------------
// Reconstrucción de las iteraciones completas a partir de los deltas
// ---------------------------------------------------------------------------
export function reconstruirIteraciones(esc) {
  if (esc.iteraciones && !esc.iteraciones_delta) return esc.iteraciones;
  if (!esc.iteraciones_delta) return [];

  const estado = new Map();
  return esc.iteraciones_delta.map((d) => {
    for (const c of d.cambios) estado.set(c.celda_id, c);
    const celdas = [];
    for (const c of estado.values()) {
      // El motor emite "quemada"; se aceptan las dos formas por compatibilidad
      // con escenarios guardados por versiones anteriores.
      if (c.estado === "ardiendo" || c.estado === "quemada" || c.estado === "quemado") celdas.push(c);
    }
    return {
      iteracion: d.iteracion,
      num_celdas_ardiendo: d.num_celdas_ardiendo,
      num_celdas_quemadas: d.num_celdas_quemadas,
      viento: d.viento || null,
      celdas,
    };
  });
}

export async function obtenerSimulacion(escenarioId) {
  const esc = await obtenerEscenario(escenarioId);
  if (!esc) return null;
  return {
    escenario_id: esc.escenario_id,
    parametros: esc.parametros,
    iteraciones: reconstruirIteraciones(esc),
    metadatos_motor: esc.metadatos_motor || null,
  };
}

export { AREA_POR_CELDA_HA };
