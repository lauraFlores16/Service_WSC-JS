// ============================================================================
// ADAPTADOR SUPABASE — mismo contrato que db-json.js, sobre PostgreSQL
// ============================================================================
// Se usa cuando backend/.env trae SUPABASE_URL y SUPABASE_SERVICE_KEY. Habla con
// las tablas del esquema `sipro` (ver sql/01_esquema.sql) a través del cliente
// REST de almacen/supabase.js.
//
// Cada función tiene la MISMA firma y el MISMO tipo de retorno que su gemela en
// db-json.js, para que db.js pueda intercambiarlas sin tocar el resto.
// ============================================================================
import crypto from "node:crypto";
import { sb } from "./supabase.js";
import { hashear, verificar as verificarHash, esHash } from "./hash.js";
import { MATRIZ_DEFECTO, normalizarMatriz } from "./permisos_defecto.js";

const enc = encodeURIComponent;

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------
// El escenario llega como un objeto grande; se reparte entre columnas indexables
// (para poder ordenar y listar) y una columna `datos` con el resto.
function aFilaEscenario(e) {
  const { escenario_id, nombre, creado_por, creado_en, parametros, foco_coordenadas,
    variables_promedio, metadatos_motor, area_final_ha, num_iteraciones, iteraciones,
    ...resto } = e;
  return {
    escenario_id, nombre, creado_por,
    creado_en: creado_en || new Date().toISOString(),
    parametros, foco_coordenadas, variables_promedio, metadatos_motor,
    area_final_ha: area_final_ha ?? null,
    num_iteraciones: num_iteraciones ?? (iteraciones?.length ?? null),
    iteraciones, datos: resto,
  };
}
function deFilaEscenario(f) {
  if (!f) return null;
  const { datos, ...columnas } = f;
  return { ...columnas, ...(datos || {}) };
}

export async function guardarEscenario(escenario) {
  await sb.upsert("escenarios", aFilaEscenario(escenario), "escenario_id");
  return escenario;
}
export async function listarEscenarios() {
  const filas = await sb.select("escenarios", "select=*&order=creado_en.desc&limit=200");
  return (filas || []).map(deFilaEscenario);
}
export async function obtenerEscenario(id) {
  return deFilaEscenario(await sb.selectUno("escenarios", `select=*&escenario_id=eq.${enc(id)}`));
}
export async function borrarEscenario(id) {
  await sb.eliminar("escenarios", `escenario_id=eq.${enc(id)}`);
}

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------
export async function guardarAlertas(lista) {
  if (!lista?.length) return;
  await sb.insertar("alertas", lista.map((a) => ({ origen: "simulacion", ...a })));
}
export async function alertasDeEscenario(escenarioId) {
  return sb.select("alertas",
    `select=*&escenario_id=eq.${enc(escenarioId)}&order=iteracion.asc`) || [];
}
export async function alertasDeRiesgo({ limite = 50 } = {}) {
  return sb.select("alertas",
    `select=*&origen=eq.riesgo&order=creada_en.desc&limit=${limite}`) || [];
}
export async function reemplazarAlertasRiesgo(lista) {
  await sb.eliminar("alertas", "origen=eq.riesgo");
  if (!lista?.length) return [];
  return sb.insertar("alertas", lista.map((a) => ({ origen: "riesgo", ...a })));
}

// ---------------------------------------------------------------------------
// Calibración
// ---------------------------------------------------------------------------
export async function guardarCalibracion(resultado) {
  // La nueva pasa a ser la vigente; las demás dejan de serlo.
  await sb.actualizar("calibraciones", "vigente=eq.true", { vigente: false });
  await sb.insertar("calibraciones", {
    fecha: resultado.fecha || new Date().toISOString(),
    vigente: true,
    f1: resultado.f1 ?? null,
    metodo: resultado.metodo ?? null,
    p_base: resultado.p_base ?? null,
    constantes: resultado.constantes ?? null,
    detalle: resultado.detalle ?? null,
    resultado,
  });
  return resultado;
}
export async function leerCalibracion() {
  const fila = await sb.selectUno("calibraciones", "select=resultado&vigente=eq.true");
  return fila?.resultado ?? null;
}
export async function leerHistorialCalibracion() {
  const filas = await sb.select("calibraciones",
    "select=fecha,f1,metodo,p_base,constantes&order=fecha.desc&limit=50");
  return filas || [];
}

// ---------------------------------------------------------------------------
// Bitácora
// ---------------------------------------------------------------------------
export async function registrarBitacora(entrada) {
  await sb.insertar("bitacora", {
    fecha: new Date().toISOString(),
    usuario: entrada.usuario ?? null,
    accion: entrada.accion,
    detalle: entrada.detalle ?? null,
    tipo: entrada.tipo || "data",
  });
}
export async function listarBitacora() {
  return sb.select("bitacora", "select=*&order=fecha.desc&limit=500") || [];
}

// ---------------------------------------------------------------------------
// Informes
// ---------------------------------------------------------------------------
export async function guardarInforme(informe) {
  const fila = await sb.insertar("informes", {
    escenario_id: informe.escenario_id ?? null,
    nombre: informe.nombre,
    html: informe.html,
    generado_por: informe.generado_por ?? null,
    generado_en: new Date().toISOString(),
    resumen: informe.resumen ?? null,
  });
  return fila;
}
export async function listarInformes() {
  return sb.select("informes",
    "select=id,escenario_id,nombre,generado_por,generado_en,resumen&order=generado_en.desc&limit=200") || [];
}
export async function obtenerInforme(id) {
  return sb.selectUno("informes", `select=*&id=eq.${enc(id)}`);
}
export async function informeDeEscenario(escenarioId) {
  return sb.selectUno("informes",
    `select=*&escenario_id=eq.${enc(escenarioId)}&order=generado_en.desc`);
}

// ---------------------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------------------
export async function crearSesion(sesion) {
  await sb.insertar("sesiones", {
    id: sesion.id,
    usuario_id: sesion.usuario_id,
    emitida_en: sesion.emitida_en || new Date().toISOString(),
    expira_en: sesion.expira_en,
    revocada: false,
    user_agent: sesion.user_agent ?? null,
    ip: sesion.ip ?? null,
  });
  return sesion;
}
export async function obtenerSesion(id) {
  return sb.selectUno("sesiones", `select=*&id=eq.${enc(id)}`);
}
export async function revocarSesion(id) {
  await sb.actualizar("sesiones", `id=eq.${enc(id)}`, { revocada: true });
}
export async function revocarSesionesDeUsuario(usuarioId) {
  await sb.actualizar("sesiones", `usuario_id=eq.${enc(usuarioId)}&revocada=eq.false`, { revocada: true });
}
export async function limpiarSesiones() {
  const ahora = new Date().toISOString();
  await sb.eliminar("sesiones", `or=(revocada.eq.true,expira_en.lt.${ahora})`);
  return 0;
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

// Siembra la primera vez (por si no corriste 02_semilla.sql) y hashea las
// contraseñas que sigan en claro.
export async function migrarPasswords() {
  let usuarios = await sb.select("usuarios", "select=*&order=orden.asc");
  if (!usuarios || !usuarios.length) {
    await sb.upsert("usuarios", SEMILLA_USUARIOS.map((u) => ({ ...u, password: hashear(u.password) })), "id");
    return SEMILLA_USUARIOS.length;
  }
  let cambiadas = 0;
  for (const u of usuarios) {
    if (!esHash(u.password)) {
      await sb.actualizar("usuarios", `id=eq.${enc(u.id)}`, { password: hashear(u.password) });
      cambiadas++;
    }
  }
  return cambiadas;
}

export async function listarUsuarios({ conPassword = false } = {}) {
  const cols = conPassword ? "*" : "id,email,nombre,rol,activo,creado_en,orden";
  const filas = await sb.select("usuarios", `select=${cols}&order=orden.asc.nullslast&order=creado_en.asc`);
  return filas || [];
}

export async function crearUsuario(datos) {
  const existe = await sb.selectUno("usuarios", `select=id&email=eq.${enc(datos.email)}`);
  if (existe) { const e = new Error("Ya existe un usuario con ese correo."); e.estadoHttp = 400; throw e; }
  const nuevo = {
    id: "u-" + Date.now(), email: datos.email,
    password: hashear(datos.password || "demo1234"),
    nombre: datos.nombre, rol: datos.rol,
    activo: datos.activo !== undefined ? Boolean(datos.activo) : true,
    creado_en: new Date().toISOString(),
  };
  await sb.insertar("usuarios", nuevo);
  const { password, ...sinPassword } = nuevo;
  return sinPassword;
}

export async function actualizarUsuario(id, cambios) {
  const permitidos = {};
  if (cambios.nombre != null) permitidos.nombre = cambios.nombre;
  if (cambios.rol != null) permitidos.rol = cambios.rol;
  if (cambios.activo != null) permitidos.activo = cambios.activo;
  const fila = await sb.actualizar("usuarios", `id=eq.${enc(id)}`, permitidos);
  if (!fila) { const e = new Error("Usuario no encontrado"); e.estadoHttp = 404; throw e; }
  const { password, ...sinPassword } = fila;
  return sinPassword;
}

export const desactivarUsuario = (id) => actualizarUsuario(id, { activo: false });

export async function verificarCredenciales(email, password) {
  const u = await sb.selectUno("usuarios", `select=*&email=eq.${enc(email)}`);
  if (!u || !verificarHash(password, u.password)) return null;
  if (u.activo === false) {
    const e = new Error("Esta cuenta está desactivada. Contacta con el administrador.");
    e.estadoHttp = 403; throw e;
  }
  return { id: u.id, usuario_id: u.email, nombre: u.nombre, rol: u.rol, email: u.email };
}

export async function marcarUltimoAcceso(id) {
  await sb.actualizar("usuarios", `id=eq.${enc(id)}`, { ultimo_acceso: new Date().toISOString() });
}

export async function restablecerPassword(id, nuevaPassword) {
  const fila = await sb.actualizar("usuarios", `id=eq.${enc(id)}`, { password: hashear(nuevaPassword) });
  if (!fila) { const e = new Error("Usuario no encontrado"); e.estadoHttp = 404; throw e; }
  const { password, ...sinPassword } = fila;
  return sinPassword;
}

// ---------------------------------------------------------------------------
// Matriz de permisos por rol (una sola fila JSONB en la tabla `permisos`)
// ---------------------------------------------------------------------------
export async function leerMatrizPermisos() {
  const fila = await sb.selectUno("permisos", "select=matriz&id=eq.actual");
  return normalizarMatriz(fila?.matriz || MATRIZ_DEFECTO);
}
export async function guardarMatrizPermisos(matriz) {
  const normalizada = normalizarMatriz(matriz);
  await sb.upsert("permisos", { id: "actual", matriz: normalizada, actualizado_en: new Date().toISOString() }, "id");
  return normalizada;
}
