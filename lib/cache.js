// ============================================================================
// CACHÉ EN DOS NIVELES + DEDUPLICACIÓN
// ============================================================================
// Tres cosas, y las tres bajan el tiempo de carga:
//
//  1. MEMORIA: lo consultado hace poco se responde en microsegundos.
//  2. DISCO: sobrevive a reiniciar el servidor. El DEM (alturas del terreno)
//     no cambia nunca, así que se guarda sin caducidad: la primera vez cuesta,
//     el resto de la vida del proyecto es instantáneo.
//  3. VUELO ÚNICO (single-flight): si llegan diez peticiones idénticas mientras
//     la primera todavía está en el aire, NO se lanzan diez llamadas externas;
//     las diez esperan a la misma promesa. Esto por sí solo evitaba buena parte
//     de los 429, porque el frontend pedía lo mismo desde varios sitios a la vez.
// ============================================================================

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { CACHE_DIR } from "../config.js";

const memoria = new Map();   // clave → { valor, expira }
const enVuelo = new Map();   // clave → Promise

function rutaDisco(clave) {
  const hash = crypto.createHash("sha1").update(clave).digest("hex");
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function leerDisco(clave) {
  try {
    const crudo = await fs.readFile(rutaDisco(clave), "utf8");
    const d = JSON.parse(crudo);
    if (d.expira && Date.now() > d.expira) return null;
    return d;
  } catch {
    return null;
  }
}

async function escribirDisco(clave, valor, expira) {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    await fs.writeFile(rutaDisco(clave), JSON.stringify({ clave, valor, expira, guardado: Date.now() }));
  } catch (e) {
    console.warn("[cache] no se pudo escribir en disco:", e.message);
  }
}

/**
 * Devuelve el valor cacheado o lo calcula con `productor`.
 * @param {string}   clave
 * @param {number}   ttlMs      milisegundos de validez (0 o null = para siempre)
 * @param {Function} productor  async () => valor
 * @param {Object}   opciones   { disco = true }
 */
export async function conCache(clave, ttlMs, productor, opciones = {}) {
  const { disco = true } = opciones;

  // 1) memoria
  const enMemoria = memoria.get(clave);
  if (enMemoria && (!enMemoria.expira || Date.now() < enMemoria.expira)) {
    return { valor: enMemoria.valor, origen: "memoria", edadMs: Date.now() - enMemoria.guardado };
  }

  // 2) ya hay una petición idéntica en curso → esperar a esa
  if (enVuelo.has(clave)) {
    const valor = await enVuelo.get(clave);
    return { valor, origen: "en-vuelo", edadMs: 0 };
  }

  // 3) disco
  if (disco) {
    const enDisco = await leerDisco(clave);
    if (enDisco) {
      memoria.set(clave, { valor: enDisco.valor, expira: enDisco.expira, guardado: enDisco.guardado });
      return { valor: enDisco.valor, origen: "disco", edadMs: Date.now() - enDisco.guardado };
    }
  }

  // 4) producirlo de verdad
  const promesa = (async () => {
    const valor = await productor();
    const expira = ttlMs ? Date.now() + ttlMs : null;
    memoria.set(clave, { valor, expira, guardado: Date.now() });
    if (disco) await escribirDisco(clave, valor, expira);
    return valor;
  })();

  enVuelo.set(clave, promesa);
  try {
    const valor = await promesa;
    return { valor, origen: "red", edadMs: 0 };
  } finally {
    enVuelo.delete(clave);
  }
}

/**
 * Igual que conCache, pero si el productor falla y hay una copia CADUCADA,
 * devuelve la caducada en lugar de fallar. Es lo que permite que el frontend
 * siga viendo datos (marcados como "no recientes") cuando Open-Meteo está
 * limitando o caído, en vez de un error rojo.
 */
export async function conCacheTolerante(clave, ttlMs, productor, opciones = {}) {
  try {
    return await conCache(clave, ttlMs, productor, opciones);
  } catch (error) {
    const rancio = memoria.get(clave) || (await leerDiscoIgnorandoCaducidad(clave));
    if (rancio) {
      return {
        valor: rancio.valor,
        origen: "cache-caducada",
        edadMs: Date.now() - (rancio.guardado || 0),
        error,
      };
    }
    throw error;
  }
}

async function leerDiscoIgnorandoCaducidad(clave) {
  try {
    const crudo = await fs.readFile(rutaDisco(clave), "utf8");
    return JSON.parse(crudo);
  } catch {
    return null;
  }
}

export function invalidar(prefijo) {
  for (const clave of memoria.keys()) {
    if (clave.startsWith(prefijo)) memoria.delete(clave);
  }
}

export function estadoCache() {
  return { entradas_en_memoria: memoria.size, peticiones_en_vuelo: enVuelo.size };
}
