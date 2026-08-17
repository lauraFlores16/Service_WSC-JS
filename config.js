// ============================================================================
// Configuración del backend
// ============================================================================
// Lee backend/.env si existe. Ninguna de estas variables llega al navegador:
// viven solo en este proceso. Por eso la clave de NASA FIRMS puede estar aquí
// y ya no en el bundle del frontend.
//
// Todo tiene un valor por defecto sensato, así que `node index.js` arranca
// aunque no crees el .env.
// ============================================================================
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RAIZ = path.dirname(fileURLToPath(import.meta.url));

// Lector de .env mínimo: evitamos depender de dotenv para que la instalación
// sea literalmente `npm i express cors`.
(function cargarEnv() {
  const ruta = path.join(RAIZ, ".env");
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, "utf8").split("\n")) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith("#")) continue;
    const i = limpia.indexOf("=");
    if (i < 0) continue;
    const clave = limpia.slice(0, i).trim();
    const valor = limpia.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!(clave in process.env)) process.env[clave] = valor;
  }
})();

const desdeRaiz = (p) => (path.isAbsolute(p) ? p : path.resolve(RAIZ, p));

export const PUERTO = Number(process.env.PORT || 8000);

export const CORS_ORIGENES = (process.env.CORS_ORIGENES ||
  "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);

export const JWT_SECRETO = process.env.JWT_SECRETO || "sipro-desarrollo-local";

// ---------------------------------------------------------------------------
// Supabase (opcional)
// ---------------------------------------------------------------------------
// Si defines SUPABASE_URL y SUPABASE_SERVICE_KEY, el backend guarda todo en la
// base de datos. Si no, usa los JSON de almacen/datos/ y funciona igual.
// La SERVICE_KEY es secreta y NUNCA llega al navegador: solo la usa el backend.
export const SUPABASE = {
  url: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  serviceKey: process.env.SUPABASE_SERVICE_KEY || "",
};
export const USAR_SUPABASE = Boolean(SUPABASE.url && SUPABASE.serviceKey);

// Municipio de Apolo (Franz Tamayo, La Paz). El bbox va en el orden que exige
// FIRMS: oeste,sur,este,norte.
export const APOLO = {
  lat: -14.65,
  lon: -68.25,
  bbox: { oeste: -69.05, sur: -15.05, este: -67.55, norte: -13.95 },
};

export const FIRMS = {
  clave: process.env.NASA_FIRMS_MAP_KEY || "",
  fuente: process.env.NASA_FIRMS_FUENTE || "VIIRS_SNPP_NRT",
  dias: Number(process.env.NASA_FIRMS_DIAS || 5),
  bbox: "-69.05,-15.05,-67.55,-13.95",
};

// Los CSV pesan ~5 MB: se leen de donde ya están (frontend/public/datos) en vez
// de duplicarlos. Si mueves el backend a otra máquina, copia esa carpeta y
// apunta CSV_DIR ahí.
export const CSV_DIR = desdeRaiz(process.env.CSV_DIR || "./datos");

// "Base de datos" del prototipo: JSON en disco. Cuando migres a Postgres o
// Supabase, lo único que hay que reescribir es almacen/db.js.
export const DATOS_DIR = desdeRaiz(process.env.DATOS_DIR || "./almacen/datos");

// Caché en disco de las respuestas de las APIs externas.
export const CACHE_DIR = desdeRaiz(process.env.CACHE_DIR || "./.cache");

// ---------------------------------------------------------------------------
// Tiempos de vida de la caché (ms)
// ---------------------------------------------------------------------------
// Cada dato se cachea según lo rápido que cambia de verdad. Esto es lo que
// evita el 429 de Open-Meteo: el modelo meteorológico se actualiza cada hora,
// así que pedirlo más de una vez cada 10 minutos no aporta nada y solo gasta
// cuota. Las alturas del terreno no cambian nunca.
export const TTL = {
  meteo: 10 * 60 * 1000,                 // 10 min
  climatologia: 30 * 24 * 60 * 60 * 1000, // 30 días
  vientoHistorico: 365 * 24 * 60 * 60 * 1000, // 1 año (el pasado no cambia)
  dem: Infinity,                          // el relieve no cambia
  osm: 7 * 24 * 60 * 60 * 1000,          // 7 días
  firms: 10 * 60 * 1000,                 // 10 min (los satélites pasan 2 veces/día)
};

for (const dir of [DATOS_DIR, CACHE_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
