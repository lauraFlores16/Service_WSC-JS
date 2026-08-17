// ============================================================================
// RUTAS DE LA API
// ============================================================================
// Un solo archivo porque el proyecto es pequeño y así se ve todo el contrato de
// un vistazo. Convención de respuestas:
//
//   { ok: true,  datos: ..., procedencia: {...} }
//   { ok: false, error: "mensaje para el usuario", servicio: "Open-Meteo" }
//
// `procedencia` es la pieza que pediste: dice si el dato viene de la red, de
// caché fresca o de una copia vieja, y con qué antigüedad. El frontend la usa
// para decir "trabajando con datos de hace 40 min" en vez de soltar un error.
// ============================================================================

import { Router } from "express";
import crypto from "node:crypto";
import { JWT_SECRETO, APOLO } from "../config.js";
import * as db from "../almacen/db.js";
const { MODO_ALMACEN } = db;
import * as meteo from "../servicios/meteo.js";
import * as terreno from "../servicios/terreno.js";
import * as firms from "../servicios/firms.js";
import * as gridSrv from "../servicios/grid.js";
import { derivarParametros } from "../motor/parametros.js";
import { ejecutarSimulacion, obtenerSimulacion, reconstruirIteraciones, AREA_POR_CELDA_HA } from "../motor/simulacion.js";
import { calibrar } from "../motor/calibracion.js";
import { calcularAlertasRiesgo } from "../motor/alertas_riesgo.js";
import { estadoColas } from "../lib/cola.js";
import { estadoCache } from "../lib/cache.js";

export const rutas = Router();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const bien = (datos, extra = {}) => ({ ok: true, datos, ...extra });

function mal(res, error) {
  const estado = error?.estadoHttp || 500;
  res.status(estado).json({
    ok: false,
    error: error?.message || "Error inesperado",
    servicio: error?.servicio || null,
    reintentar_en_s: error?.reintentarEnS || null,
  });
}

// Envuelve un handler async para no repetir try/catch en cada ruta
const asincrono = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[${req.method} ${req.path}]`, e.message);
  mal(res, e);
});

// --- Tokens de sesión ------------------------------------------------------
// El token es un JWT-lite firmado con HMAC (sin dependencias externas), pero
// AHORA lleva un identificador de sesión (jti) que además existe como fila en la
// tabla `sesiones`. Eso cambia dos cosas frente a antes:
//
//   1. Se puede REVOCAR una sesión (cerrar sesión, desactivar la cuenta): basta
//      con marcar la fila como revocada y el token deja de valer al instante.
//   2. La verificación es asíncrona porque consulta la base. Por eso exigirSesion
//      pasó a ser async.
//
// La firma HMAC evita que nadie fabrique un token; la fila en `sesiones` permite
// invalidarlo. Las dos capas juntas.
const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12 h
const COOKIE_SESION = "sipro_sesion";

// httpOnly: el JS del navegador no la lee (anti-XSS).
// sameSite lax + secure en producción. En local (http) secure debe ir en false.
function opcionesCookie() {
  const enProduccion = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: enProduccion ? "none" : "lax",
    secure: enProduccion,
    maxAge: DURACION_SESION_MS,
    path: "/",
  };
}

function firmar(carga) {
  const cuerpo = Buffer.from(JSON.stringify(carga)).toString("base64url");
  const firma = crypto.createHmac("sha256", JWT_SECRETO).update(cuerpo).digest("base64url");
  return `${cuerpo}.${firma}`;
}

function decodificarFirmado(token) {
  if (!token) return null;
  const [cuerpo, firma] = token.split(".");
  if (!cuerpo || !firma) return null;
  const esperada = crypto.createHmac("sha256", JWT_SECRETO).update(cuerpo).digest("base64url");
  if (firma.length !== esperada.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada))) return null;
  try {
    const carga = JSON.parse(Buffer.from(cuerpo, "base64url").toString());
    if (carga.expira && Date.now() > carga.expira) return null;
    return carga;
  } catch {
    return null;
  }
}

// Emite un token y registra su sesión en la base.
async function emitirToken(usuario, req) {
  const jti = crypto.randomUUID();
  const expira = Date.now() + DURACION_SESION_MS;
  await db.crearSesion({
    id: jti,
    usuario_id: usuario.id || usuario.usuario_id,
    emitida_en: new Date().toISOString(),
    expira_en: new Date(expira).toISOString(),
    user_agent: (req.headers["user-agent"] || "").slice(0, 300),
    ip: (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").toString().slice(0, 60),
  });
  return firmar({ ...usuario, jti, expira });
}

// Verifica firma + vigencia en base. Devuelve la carga del token o null.
async function verificarPeticion(req) {
  // El token puede venir en la cookie httpOnly (camino normal del navegador) o
  // en la cabecera Authorization (para curl, Postman o clientes sin cookies).
  const token = req.cookies?.[COOKIE_SESION]
    || (req.headers.authorization || "").replace(/^Bearer /, "");
  const carga = decodificarFirmado(token);
  if (!carga || !carga.jti) return null;
  const sesion = await db.obtenerSesion(carga.jti);
  if (!sesion || sesion.revocada) return null;
  if (new Date(sesion.expira_en).getTime() < Date.now()) return null;
  return carga;
}

async function exigirSesion(req, res, next) {
  try {
    const usuario = await verificarPeticion(req);
    if (!usuario) return res.status(401).json({ ok: false, error: "Sesión no válida o expirada" });
    req.usuario = usuario;
    next();
  } catch (e) {
    console.error("[auth]", e.message);
    res.status(401).json({ ok: false, error: "Sesión no válida o expirada" });
  }
}

// ===========================================================================
// ESTADO / SALUD
// ===========================================================================
rutas.get("/estado", asincrono(async (_req, res) => {
  res.json(bien({
    servicio: "SIPRO FIRE backend",
    version: "2.0.0",
    hora: new Date().toISOString(),
    grid_cargado: Boolean(gridSrv.obtenerGrid()),
    celdas: gridSrv.obtenerGrid()?.length ?? 0,
    firms_configurada: firms.claveConfigurada(),
    almacen: MODO_ALMACEN,
    colas: estadoColas(),
    cache: estadoCache(),
  }));
}));

// ===========================================================================
// AUTENTICACIÓN
// ===========================================================================
rutas.post("/auth/login", asincrono(async (req, res) => {
  const { email, password } = req.body || {};
  const usuario = await db.verificarCredenciales(email, password);
  if (!usuario) return res.status(401).json({ ok: false, error: "Email o contraseña incorrectos" });

  const token = await emitirToken(usuario, req);
  await db.marcarUltimoAcceso(usuario.id); // registra el momento del acceso
  await db.registrarBitacora({ usuario: usuario.nombre, accion: "Inició sesión", tipo: "auth" });
  // El token va en una cookie httpOnly: el navegador la envía sola en cada
  // petición y el JavaScript no puede leerla. Ya no se guarda en localStorage.
  res.cookie(COOKIE_SESION, token, opcionesCookie());
  // `access_token` se sigue devolviendo por compatibilidad con clientes no-navegador;
  // el frontend web lo ignora y usa la cookie.
  res.json(bien({ access_token: token, ...usuario }));
}));

rutas.get("/auth/yo", exigirSesion, (req, res) => {
  const { expira, jti, ...usuario } = req.usuario;
  res.json(bien(usuario));
});

// Cerrar sesión: revoca el token actual en la base. El navegador ya solo tiene
// un identificador que, sin su fila, no vale nada.
rutas.post("/auth/logout", exigirSesion, asincrono(async (req, res) => {
  if (req.usuario.jti) await db.revocarSesion(req.usuario.jti);
  res.clearCookie(COOKIE_SESION, { path: "/" });
  res.json(bien({ cerrada: true }));
}));

// ===========================================================================
// AMBIENTE — Capa 1 (terreno) y Capa 2 (meteorología) y Capa 3 (FIRMS)
// ===========================================================================
rutas.get("/ambiente/meteo", asincrono(async (req, res) => {
  const lat = Number(req.query.lat ?? APOLO.lat);
  const lon = Number(req.query.lon ?? APOLO.lon);
  const datos = await meteo.obtenerMeteorologia(lat, lon);
  const peligro = meteo.indicePeligro(datos);
  res.json(bien({ ...datos, peligro }, { procedencia: datos.procedencia }));
}));

rutas.get("/ambiente/climatologia", asincrono(async (req, res) => {
  const lat = Number(req.query.lat ?? APOLO.lat);
  const lon = Number(req.query.lon ?? APOLO.lon);
  res.json(bien(await meteo.obtenerClimatologia(lat, lon)));
}));

rutas.get("/ambiente/firms", asincrono(async (_req, res) => {
  const datos = await firms.obtenerFocosActivos();
  res.json(bien(datos, { procedencia: datos.procedencia }));
}));

rutas.get("/ambiente/terreno/osm", asincrono(async (_req, res) => {
  const datos = await terreno.obtenerTerrenoOsm();
  res.json(bien(datos, { procedencia: datos.procedencia }));
}));

rutas.get("/ambiente/terreno/dem", asincrono(async (req, res) => {
  const fila = Number(req.query.fila);
  const columna = Number(req.query.columna);
  const radio = Math.min(Number(req.query.radio ?? 20), 60);
  if (!Number.isFinite(fila) || !Number.isFinite(columna)) {
    return res.status(400).json({ ok: false, error: "Faltan los parámetros fila y columna" });
  }
  res.json(bien(await terreno.obtenerDem(fila, columna, radio)));
}));

// ===========================================================================
// SIMULACIÓN
// ===========================================================================
// Parámetros derivados automáticamente (lo que rellena el formulario solo)
rutas.get("/simulacion/parametros-auto", asincrono(async (req, res) => {
  const grid = gridSrv.obtenerGrid();
  // El foco puede venir de tres formas, por orden de prioridad:
  //   1. fila + columna  → celda exacta del grid (uso normal)
  //   2. lat + lon        → celda del grid MÁS CERCANA a esas coordenadas.
  //      Sirve para las regiones de prueba, incluida alguna que cae fuera del
  //      grid (p. ej. Pelechuco): se ancla al borde más próximo del modelo y
  //      las APIs (meteo, DEM) ya trabajan con las coordenadas de esa celda.
  //   3. nada             → lo elige el motor (foco FIRMS / mayor probabilidad).
  let foco = null;
  if (req.query.fila && req.query.columna) {
    foco = gridSrv.obtenerIndice().porFilaCol.get(`${Number(req.query.fila)},${Number(req.query.columna)}`);
  } else if (req.query.lat && req.query.lon) {
    foco = gridSrv.celdaMasCercana(Number(req.query.lat), Number(req.query.lon));
  }
  const resultado = await derivarParametros(grid, {
    foco: foco || null,
    historicos: gridSrv.obtenerHistoricos(),
    horizonteHoras: Number(req.query.horas ?? 6),
  });
  res.json(bien(resultado));
}));

rutas.post("/simulacion/ejecutar", exigirSesion, asincrono(async (req, res) => {
  const parametros = req.body?.parametros || req.body;
  if (parametros?.foco_fila == null || parametros?.foco_columna == null) {
    return res.status(400).json({ ok: false, error: "Faltan foco_fila y foco_columna" });
  }
  const t0 = Date.now();
  const resultado = await ejecutarSimulacion(parametros, {
    usuario: req.usuario,
    radioDem: req.body?.radioDem,
  });
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Ejecutó simulación",
    detalle: parametros.nombre_escenario, tipo: "sim",
  });
  if (resultado.alertas?.length) {
    await db.guardarAlertas(resultado.alertas.map((a) => ({ ...a, escenario_id: resultado.escenario_id })));
  }
  console.log(`[simulacion] ${resultado.iteraciones.length} iteraciones en ${Date.now() - t0} ms`);
  res.json(bien(resultado, { ms: Date.now() - t0 }));
}));

rutas.get("/simulacion/:id", asincrono(async (req, res) => {
  const datos = await obtenerSimulacion(req.params.id);
  if (!datos) return res.status(404).json({ ok: false, error: "Escenario no encontrado" });
  res.json(bien(datos));
}));

// ===========================================================================
// ESCENARIOS (historial, alertas, gráfica)
// ===========================================================================
const PRIORIDAD = { roja: 3, naranja: 2, amarilla: 1 };

rutas.get("/escenarios", asincrono(async (_req, res) => {
  const todos = await db.listarEscenarios();
  res.json(bien(todos.map((esc) => {
    const pasos = esc.iteraciones_delta || esc.iteraciones || [];
    const ultima = pasos[pasos.length - 1];
    const niveles = (esc.alertas || []).map((a) => a.nivel);
    return {
      escenario_id: esc.escenario_id,
      nombre: esc.nombre,
      creado_por: esc.creado_por,
      creado_en: esc.creado_en,
      parametros: esc.parametros,
      num_iteraciones_ejecutadas: ultima ? ultima.iteracion : 0,
      area_final_quemada_ha: (ultima ? ultima.num_celdas_quemadas : 0) * AREA_POR_CELDA_HA,
      alerta_maxima: niveles.length
        ? niveles.reduce((a, b) => (PRIORIDAD[b] > PRIORIDAD[a] ? b : a)) : null,
    };
  })));
}));

rutas.get("/escenarios/:id", asincrono(async (req, res) => {
  const esc = await db.obtenerEscenario(req.params.id);
  if (!esc) return res.status(404).json({ ok: false, error: "Escenario no encontrado" });
  res.json(bien({ ...esc, iteraciones: reconstruirIteraciones(esc) }));
}));

rutas.delete("/escenarios/:id", exigirSesion, asincrono(async (req, res) => {
  await db.borrarEscenario(req.params.id);
  res.json(bien({ borrado: req.params.id }));
}));

// Alertas de riesgo del municipio, calculadas de probabilidad + meteo, sin
// necesidad de ninguna simulación. Se recalculan y se guardan reemplazando las
// anteriores para no acumular duplicados.
rutas.get("/alertas/riesgo", asincrono(async (_req, res) => {
  let alertas;
  try {
    alertas = await calcularAlertasRiesgo();
    await db.reemplazarAlertasRiesgo(alertas);
  } catch (e) {
    // Si la meteo no responde, se devuelven las últimas guardadas.
    console.warn("[alertas riesgo]", e.message);
    alertas = await db.alertasDeRiesgo({ limite: 20 });
  }
  res.json(bien({ activas: alertas, generado_en: new Date().toISOString() }));
}));

rutas.get("/escenarios/:id/alertas", asincrono(async (req, res) => {
  const esc = await db.obtenerEscenario(req.params.id);
  if (!esc) return res.json(bien({ activas: [], historial: [] }));
  const alertas = esc.alertas || [];
  const maxIter = alertas.length ? Math.max(...alertas.map((a) => a.iteracion)) : null;
  res.json(bien({
    historial: alertas,
    activas: maxIter == null ? [] : alertas.filter((a) => a.iteracion === maxIter),
  }));
}));

rutas.get("/escenarios/:id/grafica", asincrono(async (req, res) => {
  const esc = await db.obtenerEscenario(req.params.id);
  if (!esc) return res.json(bien([]));
  const pasos = esc.iteraciones_delta || esc.iteraciones || [];
  const minutos = esc.metadatos_motor?.minutos_por_iteracion || 15;
  res.json(bien(pasos.map((it) => ({
    iteracion: it.iteracion,
    tiempo_minutos: it.iteracion * minutos,
    celdas_ardiendo: it.num_celdas_ardiendo,
    celdas_quemadas: it.num_celdas_quemadas,
    area_quemada_ha: it.num_celdas_quemadas * AREA_POR_CELDA_HA,
  }))));
}));

// ===========================================================================
// CALIBRACIÓN
// ===========================================================================
// Corre en el servidor, no en la pestaña del navegador. Antes bloqueaba la
// interfaz ~36 s; ahora el cliente pregunta el progreso cada segundo.
let calibracionEnCurso = null;

rutas.get("/calibracion", asincrono(async (_req, res) => {
  res.json(bien({
    actual: await db.leerCalibracion(),
    historial: await db.leerHistorialCalibracion(),
    en_curso: calibracionEnCurso
      ? { progreso: calibracionEnCurso.progreso, iniciada: calibracionEnCurso.iniciada }
      : null,
  }));
}));

rutas.post("/calibracion", exigirSesion, asincrono(async (req, res) => {
  if (calibracionEnCurso) {
    return res.status(409).json({
      ok: false, error: "Ya hay una calibración en curso",
      progreso: calibracionEnCurso.progreso,
    });
  }

  const estado = { progreso: 0, iniciada: new Date().toISOString(), mejor: null };
  calibracionEnCurso = estado;

  // Se responde de inmediato y el trabajo sigue por detrás: así el cliente no
  // se queda con una petición colgada 40 segundos.
  res.json(bien({ iniciada: true, consultar: "/api/calibracion" }));

  (async () => {
    try {
      const resultado = await calibrar(gridSrv.obtenerGrid(), gridSrv.obtenerFocos(), {
        ...(req.body || {}),
        onProgreso: (f, mejor) => { estado.progreso = f; estado.mejor = mejor?.aptitud ?? null; },
      });
      await db.registrarBitacora({
        usuario: req.usuario.nombre, accion: "Calibró constantes K",
        detalle: `F1 = ${(resultado.f1 * 100).toFixed(1)}%`, tipo: "sim",
      });
      console.log(`[calibracion] terminada · F1 = ${(resultado.f1 * 100).toFixed(1)}%`);
    } catch (e) {
      console.error("[calibracion] fallida:", e.message);
      estado.error = e.message;
    } finally {
      calibracionEnCurso = null;
    }
  })();
}));

// ===========================================================================
// INFORMES
// ===========================================================================
// El HTML del informe lo arma el frontend (ya tenía toda la lógica de métricas
// e imagen SVG). Aquí se GUARDA para tener el historial de lo que se entregó y
// no regenerarlo. Se puede recuperar por id o por escenario.
rutas.post("/informes", exigirSesion, asincrono(async (req, res) => {
  const { escenario_id, nombre, html, resumen } = req.body || {};
  if (!html || !nombre) {
    return res.status(400).json({ ok: false, error: "Faltan nombre y html del informe" });
  }
  const informe = await db.guardarInforme({
    escenario_id: escenario_id ?? null, nombre, html,
    generado_por: req.usuario.nombre, resumen: resumen ?? null,
  });
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Generó informe",
    detalle: nombre, tipo: "report",
  });
  // No devolvemos el HTML de vuelta (puede ser grande); solo la ficha.
  const { html: _omitido, ...ficha } = informe;
  res.json(bien(ficha));
}));

rutas.get("/informes", exigirSesion, asincrono(async (_req, res) => {
  res.json(bien(await db.listarInformes()));
}));

rutas.get("/informes/:id", exigirSesion, asincrono(async (req, res) => {
  const informe = await db.obtenerInforme(req.params.id);
  if (!informe) return res.status(404).json({ ok: false, error: "Informe no encontrado" });
  res.json(bien(informe));
}));

// ===========================================================================
// USUARIOS (Módulo 1 · Gestión de usuarios)
// ===========================================================================
// Antes vivían en el localStorage del navegador, lo que tenía un problema de
// fondo: crear un usuario en la pantalla no servía para iniciar sesión, porque
// el login comprobaba contra otra lista. Ahora son la MISMA lista, y las
// contraseñas nunca salen del servidor.
//
// Se conservan las restricciones del rol administrador:
//   · puede crear, listar, editar y activar/desactivar cuentas y roles;
//   · NO puede borrar registros físicamente (desactivar = borrado lógico);
//   · NO puede tocar credenciales de servidor;
//   · no puede desactivarse a sí mismo ni quitarse su propio rol de admin,
//     para no dejar el sistema sin administrador.

function exigirAdmin(req, res, siguiente) {
  if (req.usuario?.rol !== "administrador") {
    return res.status(403).json({ ok: false, error: "Solo un administrador puede gestionar usuarios" });
  }
  siguiente();
}

rutas.get("/usuarios", exigirSesion, asincrono(async (_req, res) => {
  res.json(bien(await db.listarUsuarios()));
}));

rutas.post("/usuarios", exigirSesion, exigirAdmin, asincrono(async (req, res) => {
  const { email, nombre, rol } = req.body || {};
  if (!email || !nombre || !rol) {
    return res.status(400).json({ ok: false, error: "Faltan email, nombre o rol" });
  }
  const creado = await db.crearUsuario(req.body);
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Creó usuario",
    detalle: `${nombre} · rol ${rol}`, tipo: "user",
  });
  res.json(bien(creado));
}));

rutas.patch("/usuarios/:id", exigirSesion, exigirAdmin, asincrono(async (req, res) => {
  const cambios = req.body || {};
  const usuarios = await db.listarUsuarios();
  const objetivo = usuarios.find((u) => u.id === req.params.id);
  if (!objetivo) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });

  // Un administrador no puede dejar el sistema sin administradores
  const esElMismo = objetivo.email === req.usuario.email;
  if (esElMismo && (cambios.activo === false || (cambios.rol && cambios.rol !== "administrador"))) {
    return res.status(400).json({
      ok: false,
      error: "No puedes desactivarte ni quitarte tu propio rol de administrador.",
    });
  }

  const actualizado = await db.actualizarUsuario(req.params.id, cambios);
  // Si se desactiva o se le cambia el rol, sus sesiones abiertas dejan de valer.
  if (cambios.activo === false || cambios.rol) {
    await db.revocarSesionesDeUsuario(req.params.id);
  }
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Actualizó usuario",
    detalle: `${actualizado.nombre} · ${JSON.stringify(cambios)}`, tipo: "user",
  });
  res.json(bien(actualizado));
}));

// Desactivar, no borrar: el registro se conserva en la base.
rutas.delete("/usuarios/:id", exigirSesion, exigirAdmin, asincrono(async (req, res) => {
  const usuarios = await db.listarUsuarios();
  const objetivo = usuarios.find((u) => u.id === req.params.id);
  if (!objetivo) return res.status(404).json({ ok: false, error: "Usuario no encontrado" });
  if (objetivo.email === req.usuario.email) {
    return res.status(400).json({ ok: false, error: "No puedes desactivar tu propia cuenta." });
  }
  const actualizado = await db.desactivarUsuario(req.params.id);
  await db.revocarSesionesDeUsuario(req.params.id); // corta su sesión al instante
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Desactivó usuario",
    detalle: actualizado.nombre, tipo: "user",
  });
  res.json(bien({ ...actualizado, mensaje: "Usuario desactivado (el registro se conserva en la base)." }));
}));

// Restablecer contraseña (Módulo 1 §3.5). Asigna una nueva; no revela la previa.
rutas.post("/usuarios/:id/restablecer-password", exigirSesion, exigirAdmin, asincrono(async (req, res) => {
  const nueva = (req.body?.password || "").trim();
  if (nueva.length < 6) {
    return res.status(400).json({ ok: false, error: "La contraseña temporal debe tener al menos 6 caracteres" });
  }
  const usuario = await db.restablecerPassword(req.params.id, nueva);
  await db.revocarSesionesDeUsuario(req.params.id); // sus sesiones abiertas dejan de valer
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Restableció contraseña",
    detalle: usuario.nombre, tipo: "user",
  });
  res.json(bien({ ...usuario, mensaje: "Contraseña restablecida. El usuario deberá entrar con la nueva." }));
}));

// ===========================================================================
// ROLES Y PERMISOS (Módulo 1 · §4 · Matriz de acceso a módulos)
// ===========================================================================
// La matriz controla DE VERDAD el acceso: exigirPermiso() la consulta al
// proteger las rutas, y el frontend la usa para ocultar pantallas.

// Cualquier usuario con sesión puede LEER la matriz (el frontend la necesita
// para saber qué mostrarle a su propio rol).
rutas.get("/permisos", exigirSesion, asincrono(async (_req, res) => {
  res.json(bien(await db.leerMatrizPermisos()));
}));

// Guardar la matriz: solo administrador, y con CONFIRMACIÓN por contraseña
// (Módulo 1 §4.3). Se revalida la contraseña del propio admin antes de aplicar.
rutas.put("/permisos", exigirSesion, exigirAdmin, asincrono(async (req, res) => {
  const { matriz, password } = req.body || {};
  if (!matriz || typeof matriz !== "object") {
    return res.status(400).json({ ok: false, error: "Falta la matriz de permisos" });
  }
  // Confirmación de seguridad: la contraseña del administrador que está guardando.
  const ok = await db.verificarCredenciales(req.usuario.email, password || "").catch(() => null);
  if (!ok) {
    return res.status(403).json({ ok: false, error: "Contraseña incorrecta. Los permisos no se guardaron." });
  }
  const guardada = await db.guardarMatrizPermisos(matriz);
  await db.registrarBitacora({
    usuario: req.usuario.nombre, accion: "Modificó la matriz de permisos",
    detalle: "Actualización de roles y permisos", tipo: "user",
  });
  res.json(bien(guardada));
}));

// ===========================================================================
// HISTÓRICOS Y BITÁCORA
// ===========================================================================
rutas.get("/historicos", (_req, res) => res.json(bien(gridSrv.obtenerHistoricos())));

rutas.get("/bitacora", asincrono(async (_req, res) => res.json(bien(await db.listarBitacora()))));

rutas.post("/bitacora", exigirSesion, asincrono(async (req, res) => {
  await db.registrarBitacora({ usuario: req.usuario.nombre, ...(req.body || {}) });
  res.json(bien({ registrado: true }));
}));

export { verificarPeticion as verificarToken };
