// ============================================================================
// CLIENTE SUPABASE — vía API REST (PostgREST), sin SDK
// ============================================================================
// No usamos @supabase/supabase-js a propósito: para lo que necesita el backend
// (unos cuantos CRUD sobre el esquema `sipro`) basta con la API REST que
// Supabase expone, y así mantenemos la promesa de `npm i express cors` sin más
// dependencias.
//
// El backend se conecta con la SERVICE ROLE KEY, que omite RLS. Esa clave NUNCA
// sale del servidor. El navegador habla con el backend por HTTP; jamás con
// Supabase directamente.
// ============================================================================
import { SUPABASE } from "../config.js";

const HEADERS = () => ({
  apikey: SUPABASE.serviceKey,
  Authorization: `Bearer ${SUPABASE.serviceKey}`,
  "Content-Type": "application/json",
});

export const supabaseConfigurado = () =>
  Boolean(SUPABASE.url && SUPABASE.serviceKey);

function url(tabla, query = "") {
  return `${SUPABASE.url}/rest/v1/${tabla}${query ? `?${query}` : ""}`;
}

async function ejecutar(metodo, tabla, { query = "", cuerpo = null, cabeceras = {} } = {}) {
  const r = await fetch(url(tabla, query), {
    method: metodo,
    headers: { ...HEADERS(), ...cabeceras },
    body: cuerpo != null ? JSON.stringify(cuerpo) : undefined,
  });
  if (!r.ok) {
    const texto = await r.text().catch(() => "");
    throw new Error(`Supabase ${metodo} ${tabla} → ${r.status}: ${texto.slice(0, 300)}`);
  }
  if (r.status === 204) return null;
  const texto = await r.text();
  return texto ? JSON.parse(texto) : null;
}

// --- Operaciones de alto nivel -------------------------------------------
export const sb = {
  // SELECT. `query` es una cadena PostgREST: "order=creado_en.desc&limit=10"
  select: (tabla, query = "") => ejecutar("GET", tabla, { query }),

  // SELECT de una sola fila (o null)
  async selectUno(tabla, query = "") {
    const filas = await ejecutar("GET", tabla, { query: `${query}&limit=1` });
    return filas && filas.length ? filas[0] : null;
  },

  // INSERT. Devuelve la fila insertada.
  async insertar(tabla, fila) {
    const filas = await ejecutar("POST", tabla, {
      cuerpo: Array.isArray(fila) ? fila : [fila],
      cabeceras: { Prefer: "return=representation" },
    });
    return Array.isArray(fila) ? filas : filas?.[0];
  },

  // UPSERT (INSERT o UPDATE por conflicto de clave)
  async upsert(tabla, fila, onConflict = "id") {
    const filas = await ejecutar("POST", tabla, {
      query: `on_conflict=${onConflict}`,
      cuerpo: Array.isArray(fila) ? fila : [fila],
      cabeceras: { Prefer: "resolution=merge-duplicates,return=representation" },
    });
    return Array.isArray(fila) ? filas : filas?.[0];
  },

  // UPDATE con filtro PostgREST ("id=eq.u-123")
  async actualizar(tabla, filtro, cambios) {
    const filas = await ejecutar("PATCH", tabla, {
      query: filtro,
      cuerpo: cambios,
      cabeceras: { Prefer: "return=representation" },
    });
    return filas?.[0] ?? null;
  },

  // DELETE con filtro
  eliminar: (tabla, filtro) => ejecutar("DELETE", tabla, { query: filtro }),
};

// Prueba de conexión al arrancar: una consulta trivial que confirma que la URL
// y la clave son correctas y que el esquema existe.
export async function comprobarConexion() {
  await ejecutar("GET", "usuarios", { query: "select=id&limit=1" });
  return true;
}
