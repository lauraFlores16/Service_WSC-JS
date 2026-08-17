// ============================================================================
// HASHEO DE CONTRASEÑAS — scrypt nativo de Node, sin dependencias
// ============================================================================
// Guardar contraseñas en claro (como hacía el prototipo) es justo lo que no se
// debe hacer al pasar a una base compartida. Aquí se hashean con scrypt, que
// viene en el módulo `crypto` de Node: no hace falta instalar bcrypt ni argon2.
//
// Formato del hash:  scrypt$<sal_hex>$<hash_hex>
// Así el propio string lleva su sal y se reconoce a simple vista.
// ============================================================================
import crypto from "node:crypto";

const N = 16384, r = 8, p = 1, LARGO = 32;

export function hashear(password) {
  const sal = crypto.randomBytes(16);
  const derivada = crypto.scryptSync(String(password), sal, LARGO, { N, r, p });
  return `scrypt$${sal.toString("hex")}$${derivada.toString("hex")}`;
}

export function esHash(valor) {
  return typeof valor === "string" && valor.startsWith("scrypt$");
}

export function verificar(password, guardado) {
  // Compatibilidad: si la fila aún tiene la contraseña en claro (usuario recién
  // sembrado), se compara directamente. El backend la re-hashea al arrancar.
  if (!esHash(guardado)) return String(password) === String(guardado);

  const [, salHex, hashHex] = guardado.split("$");
  const sal = Buffer.from(salHex, "hex");
  const esperado = Buffer.from(hashHex, "hex");
  const derivada = crypto.scryptSync(String(password), sal, esperado.length, { N, r, p });
  // Comparación en tiempo constante para no filtrar información por el tiempo
  return derivada.length === esperado.length && crypto.timingSafeEqual(derivada, esperado);
}
