// ============================================================================
// NASA FIRMS — focos activos (Capa 3)
// ============================================================================
// Antes la MAP_KEY vivía en src/local/nasa_firms_config.js, o sea: en el bundle
// del navegador, a la vista de cualquiera que abriera las herramientas de
// desarrollo. Ahora vive en backend/.env y no sale nunca de este proceso.
// De paso desaparece el proxy de Vite: ya no hace falta esquivar CORS porque
// quien llama a NASA es el servidor.
import { pedir } from "../lib/cola.js";
import { conCacheTolerante } from "../lib/cache.js";
import { FIRMS, TTL } from "../config.js";
import { leerCsv } from "../lib/csv.js";
import * as grid from "./grid.js";

const BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";

export const claveConfigurada = () => Boolean(FIRMS.clave && FIRMS.clave.trim());

// Respaldo: los focos históricos REALES del municipio (focos.csv, NASA FIRMS
// 2019–2025). Cuando la API en vivo no devuelve nada —porque no hay clave, o
// porque no hay incendios activos ahora mismo, que es lo normal fuera de
// temporada— se muestran estos para que la Capa 3 nunca aparezca vacía. Se
// marcan como "historico" para que quede claro que no son de hoy.
function focosHistoricosDeRespaldo(limite = 200) {
  const todos = grid.obtenerFocos() || [];
  if (!todos.length) return [];
  // Los más recientes primero (el CSV trae fecha AAAA-MM-DD, ordenable como texto)
  const ordenados = [...todos].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
  return ordenados.slice(0, limite).map((f, i) => ({
    id: `hist-${f.id ?? i}`,
    lat: f.lat,
    lon: f.lon,
    fecha: f.fecha != null ? String(f.fecha) : "",
    hora: "",
    brillo: null,
    frp: null,
    confianza: f.confianza != null ? String(f.confianza) : null,
    satelite: "Histórico (focos.csv)",
    historico: true,
  }));
}

export async function obtenerFocosActivos() {
  if (!claveConfigurada()) {
    // Sin clave: en vez de una lista vacía, se muestran los focos históricos
    // reales del municipio. `configurada:false` deja que el frontend explique
    // que basta con poner la MAP_KEY para ver los focos en vivo.
    const respaldo = focosHistoricosDeRespaldo();
    return {
      focos: respaldo,
      configurada: false,
      respaldo: "historico",
      mensaje: "Sin MAP_KEY: se muestran focos históricos reales (focos.csv). Añade NASA_FIRMS_MAP_KEY en backend/.env para ver los activos.",
      procedencia: { origen: "historico", reciente: false },
    };
  }

  const clave = `firms:${FIRMS.fuente}:${FIRMS.dias}:${FIRMS.bbox}`;
  const r = await conCacheTolerante(clave, TTL.firms, async () => {
    const url = `${BASE}/${FIRMS.clave}/${FIRMS.fuente}/${FIRMS.bbox}/${FIRMS.dias}`;
    const respuesta = await pedir(url, { etiqueta: "NASA FIRMS" });
    const texto = await respuesta.text();
    if (texto.startsWith("Invalid") || texto.includes("Invalid MAP_KEY")) {
      throw new Error(`NASA FIRMS: ${texto.trim().slice(0, 200)}`);
    }
    return leerCsv(texto)
      .filter((f) => f.latitude != null && f.longitude != null)
      .map((f, i) => ({
        id: `firms-${i}`,
        lat: f.latitude,
        lon: f.longitude,
        fecha: f.acq_date != null ? String(f.acq_date) : "",
        hora: f.acq_time != null ? String(f.acq_time).padStart(4, "0") : "",
        brillo: f.bright_ti4 ?? f.brightness ?? null,
        frp: f.frp ?? null,
        confianza: f.confidence != null ? String(f.confidence) : null,
        satelite: f.satellite ? String(f.satellite) : FIRMS.fuente,
      }));
  });

  // Con clave puesta pero SIN focos activos (lo habitual fuera de temporada de
  // incendios), se muestran los históricos para no dejar la capa vacía.
  if (!r.valor || r.valor.length === 0) {
    return {
      focos: focosHistoricosDeRespaldo(),
      configurada: true,
      activos: 0,
      respaldo: "historico",
      mensaje: "Sin focos activos ahora mismo. Se muestran focos históricos reales del municipio.",
      procedencia: { origen: "historico", reciente: false },
    };
  }

  return {
    focos: r.valor,
    configurada: true,
    activos: r.valor.length,
    fuente: FIRMS.fuente,
    dias: FIRMS.dias,
    procedencia: {
      origen: r.origen,
      edad_minutos: Math.round(r.edadMs / 60000),
      reciente: r.origen !== "cache-caducada",
      aviso: r.error ? r.error.message : null,
    },
  };
}
