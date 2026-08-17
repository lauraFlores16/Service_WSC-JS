// ============================================================================
// ADAPTADOR JSON — almacenamiento en ficheros sobre disco
// ============================================================================
// Es el almacén por defecto: si no configuras Supabase, el backend usa esto y
// funciona igual que hasta ahora. Guarda cada "tabla" como un JSON en
// backend/almacen/datos/.
//
// Expone exactamente el mismo contrato que db-supabase.js, así que db.js puede
// elegir uno u otro sin que el resto del código se entere.
// ============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { DATOS_DIR } from "../config.js";
import { hashear, verificar as verificarHash, esHash } from "./hash.js";
import { MATRIZ_DEFECTO, normalizarMatriz } from "./permisos_defecto.js";

const cola = new Map();

async function ruta(nombre) {
  await fs.mkdir(DATOS_DIR, { recursive: true });
  return path.join(DATOS_DIR, `${nombre}.json`);
}
async function leer(nombre, porDefecto) {
  try { return JSON.parse(await fs.readFile(await ruta(nombre), "utf8")); }
  catch { return porDefecto; }
}
async function escribir(nombre, datos) {
  const anterior = cola.get(nombre) || Promise.resolve();
  const tarea = anterior.then(async () => {
    const destino = await ruta(nombre);
    const temporal = `${destino}.tmp`;
    await fs.writeFile(temporal, JSON.stringify(datos, null, 0));
    await fs.rename(temporal, destino);
  });
  cola.set(nombre, tarea.catch(() => {}));
  return tarea;
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------
const MAX_ESCENARIOS = 200;

export async function guardarEscenario(escenario) {
  const todos = await leer("escenarios", []);
  const sinDuplicado = todos.filter((e) => e.escenario_id !== escenario.escenario_id);
  sinDuplicado.unshift(escenario);
  await escribir("escenarios", sinDuplicado.slice(0, MAX_ESCENARIOS));
  return escenario;
}
export const listarEscenarios = () => leer("escenarios", []);
export async function obtenerEscenario(id) {
  return (await leer("escenarios", [])).find((e) => e.escenario_id === id) || null;
}
export async function borrarEscenario(id) {
  const todos = await leer("escenarios", []);
  await escribir("escenarios", todos.filter((e) => e.escenario_id !== id));
}

// ---------------------------------------------------------------------------
// Alertas (persistidas: sirven tanto para simulación como para riesgo)
// ---------------------------------------------------------------------------
export async function guardarAlertas(lista) {
  if (!lista?.length) return;
  const todas = await leer("alertas", []);
  for (const a of lista) {
    todas.unshift({ id: crypto.randomUUID(), creada_en: new Date().toISOString(), ...a });
  }
  await escribir("alertas", todas.slice(0, 2000));
}
export async function alertasDeEscenario(escenarioId) {
  return (await leer("alertas", [])).filter((a) => a.escenario_id === escenarioId);
}
export async function alertasDeRiesgo({ limite = 50 } = {}) {
  return (await leer("alertas", []))
    .filter((a) => a.origen === "riesgo")
    .slice(0, limite);
}
export async function reemplazarAlertasRiesgo(lista) {
  // Las alertas de riesgo se recalculan; se sustituyen las anteriores por las
  // nuevas para no acumular duplicados en cada refresco.
  const todas = await leer("alertas", []);
  const sinRiesgo = todas.filter((a) => a.origen !== "riesgo");
  const nuevas = (lista || []).map((a) => ({
    id: crypto.randomUUID(), creada_en: new Date().toISOString(), origen: "riesgo", ...a,
  }));
  await escribir("alertas", [...nuevas, ...sinRiesgo].slice(0, 2000));
  return nuevas;
}

// ---------------------------------------------------------------------------
// Calibración
// ---------------------------------------------------------------------------
export async function guardarCalibracion(resultado) {
  await escribir("calibracion", resultado);
  const historial = await leer("calibracion_historial", []);
  historial.unshift({
    fecha: resultado.fecha, f1: resultado.f1,
    metodo: resultado.metodo, constantes: resultado.constantes, p_base: resultado.p_base,
  });
  await escribir("calibracion_historial", historial.slice(0, 50));
  return resultado;
}
export const leerCalibracion = () => leer("calibracion", null);
export const leerHistorialCalibracion = () => leer("calibracion_historial", []);

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------
export async function registrarBitacora(entrada) {
  const todas = await leer("bitacora", []);
  todas.unshift({ id: crypto.randomUUID(), fecha: new Date().toISOString(), ...entrada });
  await escribir("bitacora", todas.slice(0, 500));
}
export const listarBitacora = () => leer("bitacora", []);

// ---------------------------------------------------------------------------
// Informes
// ---------------------------------------------------------------------------
export async function guardarInforme(informe) {
  const todos = await leer("informes", []);
  const fila = { id: crypto.randomUUID(), generado_en: new Date().toISOString(), ...informe };
  todos.unshift(fila);
  await escribir("informes", todos.slice(0, 200));
  return fila;
}
export const listarInformes = () => leer("informes", []);
export async function obtenerInforme(id) {
  return (await leer("informes", [])).find((r) => r.id === id) || null;
}
export async function informeDeEscenario(escenarioId) {
  const todos = await leer("informes", []);
  return todos.find((r) => r.escenario_id === escenarioId) || null;
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------
export async function crearSesion(sesion) {
  const todas = await leer("sesiones", []);
  todas.unshift(sesion);
  await escribir("sesiones", todas.slice(0, 1000));
  return sesion;
}
export async function obtenerSesion(id) {
  return (await leer("sesiones", [])).find((s) => s.id === id) || null;
}
export async function revocarSesion(id) {
  const todas = await leer("sesiones", []);
  const i = todas.findIndex((s) => s.id === id);
  if (i >= 0) { todas[i].revocada = true; await escribir("sesiones", todas); }
}
export async function revocarSesionesDeUsuario(usuarioId) {
  const todas = await leer("sesiones", []);
  let tocadas = 0;
  for (const s of todas) if (s.usuario_id === usuarioId && !s.revocada) { s.revocada = true; tocadas++; }
  if (tocadas) await escribir("sesiones", todas);
}
export async function limpiarSesiones() {
  const ahora = Date.now();
  const todas = await leer("sesiones", []);
  const vivas = todas.filter((s) => !s.revocada && new Date(s.expira_en).getTime() > ahora);
  if (vivas.length !== todas.length) await escribir("sesiones", vivas);
  return todas.length - vivas.length;
}

// ---------------------------------------------------------------------------
// Usuarios
// ---------------------------------------------------------------------------
export const USUARIOS_DEMO = [
  { email: "admin@demo.sipro.com",    password: "demo1234", nombre: "Administradora Demo", rol: "administrador" },
  { email: "analista@demo.sipro.com", password: "demo1234", nombre: "Analista Demo",       rol: "analista" },
  { email: "ugr@demo.sipro.com",      password: "demo1234", nombre: "UGR Demo",            rol: "ugr" },
  { email: "brigada@demo.sipro.com",  password: "demo1234", nombre: "Brigada Demo",        rol: "brigada" },
];
const SEMILLA_USUARIOS = USUARIOS_DEMO.map((u, i) => ({
  id: `u-${u.rol}`, email: u.email, password: u.password,
  nombre: u.nombre, rol: u.rol, activo: true,
  creado_en: "2025-01-01T00:00:00Z", orden: i,
}));

async function usuariosCrudos() {
  let usuarios = await leer("usuarios", null);
  if (!usuarios || !usuarios.length) {
    usuarios = SEMILLA_USUARIOS;
    await escribir("usuarios", usuarios);
  }
  return usuarios;
}

// Al arrancar: convierte a hash cualquier contraseña que siga en claro.
export async function migrarPasswords() {
  const usuarios = await usuariosCrudos();
  let cambiadas = 0;
  for (const u of usuarios) if (!esHash(u.password)) { u.password = hashear(u.password); cambiadas++; }
  if (cambiadas) await escribir("usuarios", usuarios);
  return cambiadas;
}

export async function listarUsuarios({ conPassword = false } = {}) {
  const usuarios = await usuariosCrudos();
  return conPassword ? usuarios : usuarios.map(({ password, ...u }) => u);
}

export async function crearUsuario(datos) {
  const usuarios = await usuariosCrudos();
  if (usuarios.some((u) => u.email === datos.email)) {
    const e = new Error("Ya existe un usuario con ese correo."); e.estadoHttp = 400; throw e;
  }
  const nuevo = {
    id: "u-" + Date.now(), email: datos.email,
    password: hashear(datos.password || "demo1234"),
    nombre: datos.nombre, rol: datos.rol,
    activo: datos.activo !== undefined ? Boolean(datos.activo) : true,
    creado_en: new Date().toISOString(),
  };
  await escribir("usuarios", [...usuarios, nuevo]);
  const { password, ...sinPassword } = nuevo;
  return sinPassword;
}

export async function actualizarUsuario(id, cambios) {
  const usuarios = await usuariosCrudos();
  const i = usuarios.findIndex((u) => u.id === id);
  if (i === -1) { const e = new Error("Usuario no encontrado"); e.estadoHttp = 404; throw e; }
  const permitidos = {};
  if (cambios.nombre != null) permitidos.nombre = cambios.nombre;
  if (cambios.rol != null) permitidos.rol = cambios.rol;
  if (cambios.activo != null) permitidos.activo = cambios.activo;
  usuarios[i] = { ...usuarios[i], ...permitidos };
  await escribir("usuarios", usuarios);
  const { password, ...sinPassword } = usuarios[i];
  return sinPassword;
}

export const desactivarUsuario = (id) => actualizarUsuario(id, { activo: false });

export async function verificarCredenciales(email, password) {
  const usuarios = await usuariosCrudos();
  const u = usuarios.find((x) => x.email === email);
  if (!u || !verificarHash(password, u.password)) return null;
  if (u.activo === false) {
    const e = new Error("Esta cuenta está desactivada. Contacta con el administrador.");
    e.estadoHttp = 403; throw e;
  }
  return { id: u.id, usuario_id: u.email, nombre: u.nombre, rol: u.rol, email: u.email };
}

// Registra el momento del último inicio de sesión correcto.
export async function marcarUltimoAcceso(id) {
  const usuarios = await usuariosCrudos();
  const i = usuarios.findIndex((u) => u.id === id);
  if (i >= 0) { usuarios[i].ultimo_acceso = new Date().toISOString(); await escribir("usuarios", usuarios); }
}

// Restablecer contraseña: asigna una nueva (hasheada). No revela la anterior.
export async function restablecerPassword(id, nuevaPassword) {
  const usuarios = await usuariosCrudos();
  const i = usuarios.findIndex((u) => u.id === id);
  if (i === -1) { const e = new Error("Usuario no encontrado"); e.estadoHttp = 404; throw e; }
  usuarios[i].password = hashear(nuevaPassword);
  await escribir("usuarios", usuarios);
  const { password, ...sinPassword } = usuarios[i];
  return sinPassword;
}

// ---------------------------------------------------------------------------
// Matriz de permisos por rol
// ---------------------------------------------------------------------------
export async function leerMatrizPermisos() {
  const guardada = await leer("permisos", null);
  return normalizarMatriz(guardada || MATRIZ_DEFECTO);
}
export async function guardarMatrizPermisos(matriz) {
  const normalizada = normalizarMatriz(matriz);
  await escribir("permisos", normalizada);
  return normalizada;
}
