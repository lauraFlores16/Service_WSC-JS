// ============================================================================
// PERMISOS DEL SISTEMA — catálogo y matriz por defecto
// ============================================================================
// Los 10 permisos del documento (Módulo 1 §4.1) y qué tiene cada rol al
// arrancar. El Administrador puede cambiar la matriz desde la pantalla de Roles
// y Permisos; esto es solo el punto de partida (y el respaldo si la BD aún no
// tiene una matriz guardada).
//
// La matriz vive en la base de datos y controla DE VERDAD el acceso: el backend
// la consulta al proteger cada ruta y el frontend la usa para ocultar pantallas.

export const PERMISOS = [
  { id: "ver_monitoreo",        etiqueta: "Ver monitoreo",          descripcion: "Acceso al módulo de monitoreo y datos espaciales" },
  { id: "ver_variables",        etiqueta: "Ver variables ambientales", descripcion: "Visualización de NDVI, temperatura, humedad, etc." },
  { id: "ver_focos",            etiqueta: "Ver focos",              descripcion: "Consulta de focos de calor históricos y activos" },
  { id: "consultar_probabilidad", etiqueta: "Consultar probabilidad", descripcion: "Acceso al mapa de probabilidad de incendio" },
  { id: "ejecutar_simulacion",  etiqueta: "Ejecutar simulación",    descripcion: "Lanzar simulaciones con autómatas celulares" },
  { id: "ver_simulaciones",     etiqueta: "Ver simulaciones",       descripcion: "Consulta del historial de simulaciones" },
  { id: "generar_reportes",     etiqueta: "Generar reportes",       descripcion: "Creación y descarga de reportes" },
  { id: "gestionar_usuarios",   etiqueta: "Gestionar usuarios",     descripcion: "Acceso al CRUD de usuarios" },
  { id: "configuracion",        etiqueta: "Configuración del sistema", descripcion: "Acceso a la configuración general" },
  { id: "ver_bitacora",         etiqueta: "Ver bitácora",           descripcion: "Acceso al registro de actividades" },
];

export const ROLES = ["administrador", "analista", "ugr", "brigada"];

// Matriz por defecto. El administrador tiene todo. Los demás, según el documento.
export const MATRIZ_DEFECTO = {
  administrador: Object.fromEntries(PERMISOS.map((p) => [p.id, true])),
  analista: {
    ver_monitoreo: true, ver_variables: true, ver_focos: true,
    consultar_probabilidad: true, ejecutar_simulacion: true, ver_simulaciones: true,
    generar_reportes: true, gestionar_usuarios: false, configuracion: false, ver_bitacora: false,
  },
  ugr: {
    ver_monitoreo: true, ver_variables: true, ver_focos: true,
    consultar_probabilidad: true, ejecutar_simulacion: false, ver_simulaciones: true,
    generar_reportes: true, gestionar_usuarios: false, configuracion: false, ver_bitacora: false,
  },
  // 'brigada' se conserva (además de los 3 del documento): rol de consulta básica.
  brigada: {
    ver_monitoreo: true, ver_variables: true, ver_focos: true,
    consultar_probabilidad: false, ejecutar_simulacion: false, ver_simulaciones: true,
    generar_reportes: false, gestionar_usuarios: false, configuracion: false, ver_bitacora: false,
  },
};

// Normaliza una matriz parcial contra el catálogo: garantiza que están todos los
// roles y permisos (rellena con false lo que falte), y descarta claves obsoletas.
export function normalizarMatriz(matriz = {}) {
  const salida = {};
  for (const rol of ROLES) {
    salida[rol] = {};
    for (const p of PERMISOS) {
      salida[rol][p.id] = Boolean(matriz?.[rol]?.[p.id]);
    }
  }
  return salida;
}
