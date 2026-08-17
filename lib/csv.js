// Lector de CSV mínimo. No hace falta papaparse en el servidor: los dos
// archivos del proyecto son CSV planos, sin comillas ni saltos dentro de campo.
export function leerCsv(texto) {
  const lineas = texto.trim().split(/\r?\n/);
  const cabeceras = lineas[0].split(",");
  const filas = new Array(lineas.length - 1);
  for (let i = 1; i < lineas.length; i++) {
    const partes = lineas[i].split(",");
    const fila = {};
    for (let j = 0; j < cabeceras.length; j++) {
      const v = partes[j];
      if (v === undefined || v === "") { fila[cabeceras[j]] = null; continue; }
      const n = Number(v);
      fila[cabeceras[j]] = Number.isNaN(n) || v.trim() === "" ? v : n;
    }
    filas[i - 1] = fila;
  }
  return filas;
}
