// ============================================================================
// SIPRO FIRE — Backend
// ============================================================================
//   cd backend
//   npm install          (express, cors, dotenv)
//   node index.js
//
// Queda escuchando en http://localhost:8000 (PORT en backend/.env).
// El frontend apunta aquí con VITE_API_URL.
//
// Qué resguarda este proceso:
//   · Las APIs externas (Open-Meteo, Copernicus DEM, Overpass, NASA FIRMS),
//     con cola, caché y reintentos. Aquí se arregla el 429.
//   · La clave de NASA FIRMS, que antes viajaba en el bundle del navegador.
//   · La autenticación y los tokens de sesión.
//   · El guardado de escenarios, calibraciones, alertas y bitácora.
//   · El cómputo pesado: el autómata celular y la calibración.
// ============================================================================

import express from "express";
import cors from "cors";
import { PUERTO, CORS_ORIGENES, APOLO, FIRMS } from "./config.js";
import { rutas } from "./rutas/index.js";
import * as grid from "./servicios/grid.js";
import * as meteo from "./servicios/meteo.js";
import * as terreno from "./servicios/terreno.js";
import * as db from "./almacen/db.js";
import { USAR_SUPABASE, SUPABASE } from "./config.js";
import { comprobarConexion } from "./almacen/supabase.js";

const app = express();

app.use(cors({
  origin: (origen, cb) => {
    // Sin origen = curl, Postman o peticiones del propio servidor
    if (!origen || CORS_ORIGENES.includes(origen)) return cb(null, true);
    cb(new Error(`Origen no autorizado: ${origen}`));
  },
  credentials: true,
}));

// Las simulaciones pueden traer series de viento largas
app.use(express.json({ limit: "12mb" }));

// Parser de cookies mínimo: puebla req.cookies sin depender de cookie-parser.
// El token de sesión viaja en una cookie httpOnly, que el JavaScript del
// navegador NO puede leer (protección contra XSS). Por eso ya no hace falta
// guardar nada de la sesión en localStorage.
app.use((req, _res, siguiente) => {
  req.cookies = {};
  const cabecera = req.headers.cookie;
  if (cabecera) {
    for (const par of cabecera.split(";")) {
      const i = par.indexOf("=");
      if (i < 0) continue;
      const clave = par.slice(0, i).trim();
      req.cookies[clave] = decodeURIComponent(par.slice(i + 1).trim());
    }
  }
  siguiente();
});

// Traza mínima: método, ruta y cuánto tardó. Útil para ver qué está lento.
app.use((req, res, siguiente) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    if (ms > 400 || res.statusCode >= 400) {
      console.log(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms} ms)`);
    }
  });
  siguiente();
});

app.use("/api", rutas);

app.get("/", (_req, res) => {
  res.json({
    servicio: "SIPRO FIRE backend",
    documentacion: "/api/estado",
    rutas: [
      "GET  /api/estado",
      "POST /api/auth/login",
      "GET  /api/auth/yo",
      "GET  /api/ambiente/meteo?lat&lon",
      "GET  /api/ambiente/climatologia?lat&lon",
      "GET  /api/ambiente/firms",
      "GET  /api/ambiente/terreno/osm",
      "GET  /api/ambiente/terreno/dem?fila&columna&radio",
      "GET  /api/simulacion/parametros-auto?fila&columna&horas",
      "POST /api/simulacion/ejecutar",
      "GET  /api/simulacion/:id",
      "GET  /api/escenarios",
      "GET  /api/escenarios/:id",
      "GET  /api/escenarios/:id/alertas",
      "GET  /api/escenarios/:id/grafica",
      "GET  /api/calibracion",
      "POST /api/calibracion",
      "GET  /api/usuarios",
      "POST/PATCH/DELETE /api/usuarios/:id",
      "GET  /api/historicos",
    ],
  });
});

app.use((_req, res) => res.status(404).json({ ok: false, error: "Ruta no encontrada" }));

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------
async function arrancar() {
  console.log("SIPRO FIRE backend — arrancando…");
  await grid.cargar();

  // --- Almacenamiento: Supabase o JSON ---
  if (USAR_SUPABASE) {
    try {
      await comprobarConexion();
      console.log(`  Almacén: Supabase (${SUPABASE.url})`);
    } catch (e) {
      console.error(`\n  ✗ No se pudo conectar a Supabase: ${e.message}`);
      console.error("    Revisa SUPABASE_URL y SUPABASE_SERVICE_KEY en backend/.env,");
      console.error("    y que hayas ejecutado sql/01_esquema.sql en tu proyecto.\n");
      process.exit(1);
    }
  } else {
    console.log("  Almacén: JSON en disco (sin Supabase configurado)");
  }

  // Hashea las contraseñas que sigan en claro (usuarios recién sembrados).
  try {
    const n = await db.migrarPasswords();
    if (n) console.log(`  Contraseñas hasheadas: ${n}`);
  } catch (e) {
    console.warn(`  No se pudieron migrar las contraseñas: ${e.message}`);
  }

  // Limpia sesiones caducadas o revocadas.
  try {
    const n = await db.limpiarSesiones();
    if (n) console.log(`  Sesiones caducadas eliminadas: ${n}`);
  } catch { /* la tabla puede no existir aún */ }

  app.listen(PUERTO, () => {
    console.log(`\n  Escuchando en http://localhost:${PUERTO}`);
    console.log(`  Orígenes autorizados: ${CORS_ORIGENES.join(", ")}`);
    console.log(`  NASA FIRMS: ${FIRMS.clave ? "configurada" : "SIN configurar (añade NASA_FIRMS_MAP_KEY en backend/.env)"}\n`);
    precalentar();
  });
}

// ---------------------------------------------------------------------------
// Precalentamiento
// ---------------------------------------------------------------------------
// Se piden en segundo plano, nada más arrancar y sin prisa, los datos que el
// frontend va a necesitar sí o sí. Cuando el primer usuario abra Monitoreo, ya
// están en caché y la pantalla sale casi instantánea en vez de esperar a la red.
// Si algo falla aquí no pasa nada: se reintentará cuando alguien lo pida.
async function precalentar() {
  const tareas = [
    ["meteorología de Apolo", () => meteo.obtenerMeteorologia(APOLO.lat, APOLO.lon)],
    ["climatología ERA5", () => meteo.obtenerClimatologia(APOLO.lat, APOLO.lon)],
    ["capa de terreno OSM", () => terreno.obtenerTerrenoOsm()],
  ];
  for (const [nombre, tarea] of tareas) {
    try {
      const t0 = Date.now();
      await tarea();
      console.log(`[precalentado] ${nombre} lista (${Date.now() - t0} ms)`);
    } catch (e) {
      console.warn(`[precalentado] ${nombre} no disponible: ${e.message}`);
    }
  }
}

arrancar().catch((e) => {
  console.error("No se pudo arrancar el backend:", e);
  process.exit(1);
});
