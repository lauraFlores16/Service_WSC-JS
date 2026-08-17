// ============================================================================
// SERVICIO DE TERRENO (Capa 1) — lado servidor
// ============================================================================
// El DEM era el gran culpable del 429: 38 peticiones seguidas desde el
// navegador cada vez que cambiaba el foco. Ahora:
//
//   · Los lotes van por la cola, espaciados.
//   · El resultado se guarda en disco SIN caducidad — el relieve del municipio
//     no va a cambiar. La primera vez cuesta unos segundos; a partir de ahí
//     responde en milisegundos aunque reinicies el servidor.
//   · Además hay un fichero acumulado (dem.json): las alturas se van juntando
//     entre focos distintos, así que cada nueva zona pedida es más barata que
//     la anterior.
//   · La capa de OSM se calcula UNA vez para todo el municipio y se guarda ya
//     rasterizada al grid: el navegador recibe solo el resumen y la lista de
//     celdas barrera, no los megabytes de geometría.
// ============================================================================

import fs from "node:fs/promises";
import path from "node:path";
import { pedir } from "../lib/cola.js";
import { conCache, conCacheTolerante } from "../lib/cache.js";
import { TTL, CACHE_DIR } from "../config.js";
import { obtenerGrid, obtenerIndice, celdaEn } from "./grid.js";

const URL_ELEVACION = "https://api.open-meteo.com/v1/elevation";
const URL_OVERPASS = "https://overpass-api.de/api/interpreter";
const LOTE = 100; // máximo de coordenadas por petición que acepta la API

// ---------------------------------------------------------------------------
// DEM acumulado en disco: "fila:columna" → metros
// ---------------------------------------------------------------------------
const RUTA_DEM = () => path.join(CACHE_DIR, "dem.json");
let _dem = null;
let _demSucio = false;

async function cargarDemDisco() {
  if (_dem) return _dem;
  try {
    _dem = new Map(Object.entries(JSON.parse(await fs.readFile(RUTA_DEM(), "utf8"))));
    console.log(`[terreno] DEM en caché: ${_dem.size} celdas`);
  } catch {
    _dem = new Map();
  }
  return _dem;
}

async function guardarDemDisco() {
  if (!_demSucio) return;
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(RUTA_DEM(), JSON.stringify(Object.fromEntries(_dem)));
    _demSucio = false;
  } catch (e) {
    console.warn("[terreno] no se pudo guardar el DEM:", e.message);
  }
}

/**
 * Alturas reales de una ventana alrededor del foco.
 * @returns {Object} { alturas: { celda_id: metros }, estadisticas, descargadas }
 */
export async function obtenerDem(focoFila, focoColumna, radio = 20, onProgreso = null) {
  const indice = obtenerIndice();
  const cache = await cargarDemDisco();

  const objetivo = [];
  for (let f = focoFila - radio; f <= focoFila + radio; f++) {
    for (let c = focoColumna - radio; c <= focoColumna + radio; c++) {
      const celda = indice.porFilaCol.get(`${f},${c}`);
      if (celda) objetivo.push(celda);
    }
  }

  const faltantes = objetivo.filter((c) => !cache.has(`${c.fila}:${c.columna}`));
  const lotes = Math.ceil(faltantes.length / LOTE);
  let descargadas = 0;

  for (let i = 0; i < faltantes.length; i += LOTE) {
    const lote = faltantes.slice(i, i + LOTE);
    const lats = lote.map((c) => c.lat.toFixed(5)).join(",");
    const lons = lote.map((c) => c.lon.toFixed(5)).join(",");
    try {
      const respuesta = await pedir(`${URL_ELEVACION}?latitude=${lats}&longitude=${lons}`,
        { etiqueta: "Open-Meteo (elevación)" });
      const json = await respuesta.json();
      if (json.error) throw new Error(json.reason);
      json.elevation.forEach((h, k) => {
        if (Number.isFinite(h)) {
          cache.set(`${lote[k].fila}:${lote[k].columna}`, Math.round(h));
          descargadas++;
        }
      });
      _demSucio = true;
    } catch (e) {
      // Si la API de elevación está caída o limitando, no tiene sentido pedir
      // los 17 lotes restantes uno por uno: se corta aquí y se sigue con lo que
      // ya hubiera en caché. El motor cae al modo "pendiente de celda".
      console.warn(`[terreno] elevación no disponible (${e.message}); se omiten ${lotes - (i / LOTE + 1)} lotes`);
      break;
    }
    if (onProgreso) onProgreso((i / LOTE + 1) / lotes);
  }

  await guardarDemDisco();

  const alturas = {};
  const valores = [];
  for (const c of objetivo) {
    const h = cache.get(`${c.fila}:${c.columna}`);
    if (h != null) { alturas[c.id] = h; valores.push(h); }
  }

  const estadisticas = valores.length
    ? {
        min: Math.min(...valores),
        max: Math.max(...valores),
        media: Math.round(valores.reduce((a, b) => a + b, 0) / valores.length),
        celdas: valores.length,
        desnivel: Math.round(Math.max(...valores) - Math.min(...valores)),
      }
    : null;

  return { alturas, estadisticas, descargadas, en_cache: valores.length - descargadas };
}

// ---------------------------------------------------------------------------
// OSM: hidrografía, roca desnuda y caminos, ya rasterizados al grid
// ---------------------------------------------------------------------------
function consultaOverpass(bbox) {
  const b = `${bbox.sur},${bbox.oeste},${bbox.norte},${bbox.este}`;
  // Solo lo que REALMENTE frena el fuego. Pedir además bosque/pastizal/cultivo
  // para ~12.000 km² devuelve decenas de MB y no aporta: esas coberturas no son
  // barrera y el combustible ya lo da el NDVI real del grid.
  return `
[out:json][timeout:180];
(
  way["waterway"~"^(river|canal)$"](${b});
  way["waterway"="stream"](${b});
  way["natural"="water"](${b});
  way["landuse"="reservoir"](${b});
  way["natural"~"^(bare_rock|sand|scree)$"](${b});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary)$"](${b});
);
out geom;`;
}

function clasificar(tags) {
  if (tags.waterway === "river" || tags.waterway === "canal") return "rio";
  if (tags.waterway === "stream") return "quebrada";
  if (tags.natural === "water" || tags.landuse === "reservoir") return "agua";
  if (tags.natural === "bare_rock" || tags.natural === "sand" || tags.natural === "scree") return "desnudo";
  if (tags.highway) return "camino";
  return null;
}

// Cuánto frena cada elemento la propagación (0 = barrera total, 1 = no frena)
const RESISTENCIA = {
  rio: 0.0, agua: 0.0, quebrada: 0.45, camino: 0.6, desnudo: 0.1,
};

export async function obtenerTerrenoOsm() {
  const indice = obtenerIndice();
  const b = indice.bbox;
  const clave = `osm:${b.sur.toFixed(3)},${b.oeste.toFixed(3)},${b.norte.toFixed(3)},${b.este.toFixed(3)}`;

  const r = await conCacheTolerante(clave, TTL.osm, async () => {
    const respuesta = await pedir(URL_OVERPASS, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "data=" + encodeURIComponent(consultaOverpass(b)),
      etiqueta: "Overpass / OpenStreetMap",
      timeoutMs: 190_000,
    });
    const json = await respuesta.json();
    return (json.elements || [])
      .filter((e) => e.geometry && e.geometry.length)
      .map((e) => ({
        t: clasificar(e.tags || {}),
        g: e.geometry.map((p) => [+p.lat.toFixed(5), +p.lon.toFixed(5)]),
      }))
      .filter((e) => e.t);
  });

  const rasterizado = rasterizar(r.valor);
  return {
    ...rasterizado,
    procedencia: {
      origen: r.origen,
      edad_minutos: Math.round(r.edadMs / 60000),
      reciente: r.origen !== "cache-caducada",
      aviso: r.error ? r.error.message : null,
    },
  };
}

function rasterizar(elementos) {
  const indice = obtenerIndice();
  const resistencia = {};  // celda_id → 0..1
  const clases = {};       // celda_id → tipo
  const conteo = {};

  const marcar = (lat, lon, tipo) => {
    const celda = celdaEn(lat, lon);
    if (!celda) return;
    const r = RESISTENCIA[tipo] ?? 1;
    const prev = resistencia[celda.id];
    if (prev == null || r < prev) {  // se queda con el elemento más restrictivo
      resistencia[celda.id] = r;
      clases[celda.id] = tipo;
    }
  };

  for (const el of elementos) {
    conteo[el.t] = (conteo[el.t] || 0) + 1;
    const g = el.g;
    for (let i = 0; i < g.length; i++) {
      marcar(g[i][0], g[i][1], el.t);
      // Interpolar dentro del segmento para no dejar huecos entre vértices
      if (i < g.length - 1) {
        const [la, lo] = g[i], [lb, lob] = g[i + 1];
        const pasos = Math.ceil(
          Math.max(Math.abs(lb - la) / indice.pasoLat, Math.abs(lob - lo) / indice.pasoLon) * 2
        );
        for (let k = 1; k < pasos && k < 400; k++) {
          marcar(la + ((lb - la) * k) / pasos, lo + ((lob - lo) * k) / pasos, el.t);
        }
      }
    }
  }

  const barreras = Object.entries(resistencia)
    .filter(([, r]) => r <= 0.05)
    .map(([id]) => id);

  return {
    resistencia, clases, barreras,
    resumen: {
      celdas_afectadas: Object.keys(resistencia).length,
      barreras_hidricas: barreras.length,
      rios: conteo.rio || 0,
      quebradas: conteo.quebrada || 0,
      cuerpos_agua: conteo.agua || 0,
      caminos: conteo.camino || 0,
      roca_desnuda: conteo.desnudo || 0,
    },
  };
}
