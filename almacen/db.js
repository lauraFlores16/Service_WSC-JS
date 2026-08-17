// ============================================================================
// ALMACÉN — selector de adaptador
// ============================================================================
// Este archivo ya no implementa nada: elige entre dos almacenes con el MISMO
// contrato y reexporta el que toque.
//
//   · Supabase   → si backend/.env trae SUPABASE_URL + SUPABASE_SERVICE_KEY
//   · JSON local → en cualquier otro caso (funciona sin configurar nada)
//
// El resto del backend importa siempre desde aquí y no sabe cuál está detrás.
// Migrar a la nube es, literalmente, rellenar dos variables en el .env.
// ============================================================================
import { USAR_SUPABASE } from "../config.js";

const adaptador = USAR_SUPABASE
  ? await import("./db-supabase.js")
  : await import("./db-json.js");

export const MODO_ALMACEN = USAR_SUPABASE ? "supabase" : "json";

// Reexporta todo el contrato del adaptador elegido
export const {
  // escenarios
  guardarEscenario, listarEscenarios, obtenerEscenario, borrarEscenario,
  // alertas
  guardarAlertas, alertasDeEscenario, alertasDeRiesgo, reemplazarAlertasRiesgo,
  // calibración
  guardarCalibracion, leerCalibracion, leerHistorialCalibracion,
  // bitácora
  registrarBitacora, listarBitacora,
  // informes
  guardarInforme, listarInformes, obtenerInforme, informeDeEscenario,
  // sesiones
  crearSesion, obtenerSesion, revocarSesion, revocarSesionesDeUsuario, limpiarSesiones,
  // usuarios
  USUARIOS_DEMO, migrarPasswords, listarUsuarios, crearUsuario,
  actualizarUsuario, desactivarUsuario, verificarCredenciales,
  marcarUltimoAcceso, restablecerPassword,
  // permisos
  leerMatrizPermisos, guardarMatrizPermisos,
} = adaptador;
