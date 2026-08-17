// ============================================================================
// GRID EN MEMORIA
// ============================================================================
// Antes cada pestaña del navegador descargaba y parseaba grid.csv (36.390 filas,
// ~4 MB) en cada recarga. Ahora se lee UNA vez al arrancar el servidor y se
// queda en memoria, ya indexado. Todas las peticiones lo comparten.
//
// El índice espacial (lat/lon → celda) se calcula aquí y no se recalcula nunca,
// que es lo que hacía falta para rasterizar OSM y colocar los focos de FIRMS.
// ============================================================================

import fs from "node:fs/promises";
import path from "node:path";
import { leerCsv } from "../lib/csv.js";
import { CSV_DIR } from "../config.js";

let _grid = null;
let _focos = null;
let _historicos = null;
let _indice = null;
let _cargando = null;

export async function cargar() {
  if (_grid) return { grid: _grid, focos: _focos, historicos: _historicos, indice: _indice };
  if (_cargando) return _cargando;

  _cargando = (async () => {
    const t0 = Date.now();
    const [gridTxt, focosTxt, histTxt] = await Promise.all([
      fs.readFile(path.join(CSV_DIR, "grid.csv"), "utf8"),
      fs.readFile(path.join(CSV_DIR, "focos.csv"), "utf8"),
      fs.readFile(path.join(CSV_DIR, "eventos_historicos.json"), "utf8"),
    ]);
    _grid = leerCsv(gridTxt);
    _focos = leerCsv(focosTxt);
    _historicos = JSON.parse(histTxt);
    _indice = construirIndice(_grid);
    console.log(`[grid] ${_grid.length} celdas y ${_focos.length} focos cargados en ${Date.now() - t0} ms`);
    return { grid: _grid, focos: _focos, historicos: _historicos, indice: _indice };
  })();

  return _cargando;
}

function construirIndice(grid) {
  const porFilaCol = new Map();
  const porId = new Map();
  let latMin = Infinity, latMax = -Infinity, lonMin = Infinity, lonMax = -Infinity;
  let ref = null;

  for (const c of grid) {
    porFilaCol.set(`${c.fila},${c.columna}`, c);
    porId.set(c.id, c);
    if (c.lat < latMin) latMin = c.lat;
    if (c.lat > latMax) latMax = c.lat;
    if (c.lon < lonMin) lonMin = c.lon;
    if (c.lon > lonMax) lonMax = c.lon;
    if (!ref || c.fila < ref.fila || (c.fila === ref.fila && c.columna < ref.columna)) ref = c;
  }

  // Paso angular: mediana de las diferencias entre valores únicos consecutivos
  const paso = (valores) => {
    const u = [...new Set(valores.map((v) => +v.toFixed(6)))].sort((a, b) => a - b);
    const difs = [];
    for (let i = 1; i < u.length; i++) difs.push(u[i] - u[i - 1]);
    difs.sort((a, b) => a - b);
    return difs[Math.floor(difs.length / 2)] || 0.0045;
  };

  return {
    porFilaCol, porId, ref,
    pasoLat: paso(grid.map((c) => c.lat)),
    pasoLon: paso(grid.map((c) => c.lon)),
    bbox: { sur: latMin, norte: latMax, oeste: lonMin, este: lonMax },
  };
}

/** (lat, lon) → celda del grid, o null si cae fuera. */
export function celdaEn(lat, lon) {
  if (!_indice) return null;
  const fila = _indice.ref.fila + Math.round((_indice.ref.lat - lat) / _indice.pasoLat);
  const columna = _indice.ref.columna + Math.round((lon - _indice.ref.lon) / _indice.pasoLon);
  return _indice.porFilaCol.get(`${fila},${columna}`) || null;
}

export function celdaMasCercana(lat, lon) {
  const directa = celdaEn(lat, lon);
  if (directa) return directa;
  let mejor = null, mejorDist = Infinity;
  for (const c of _grid) {
    const d = (c.lat - lat) ** 2 + (c.lon - lon) ** 2;
    if (d < mejorDist) { mejorDist = d; mejor = c; }
  }
  return mejor;
}

export const obtenerGrid = () => _grid;
export const obtenerFocos = () => _focos;
export const obtenerHistoricos = () => _historicos;
export const obtenerIndice = () => _indice;

/** Promedios del grid: referencia ERA5 cuando no hay datos en vivo. */
let _promedios = null;
export function promediosGrid() {
  if (_promedios) return _promedios;
  let h = 0, v = 0, n = 0;
  for (const c of _grid) {
    h += c.humedad ?? 0;
    v += Math.hypot(c.viento_u ?? 0, c.viento_v ?? 0);
    n++;
  }
  _promedios = { humedad: h / n, viento_ms: v / n };
  return _promedios;
}
