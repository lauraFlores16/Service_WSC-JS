// Reglas de alerta — mismas del backend (services/alertas_service.py):
//   AMARILLA: > 50 celdas ardiendo en una iteración
//   NARANJA:  > 20% de crecimiento entre iteraciones consecutivas
//   ROJA:     celda con probabilidad XGBoost > 0.85 comprometida (ardiendo)
const UMBRAL_AMARILLA_CELDAS = 50;
const UMBRAL_NARANJA_CRECIMIENTO = 0.20;
const UMBRAL_ROJA_PROBABILIDAD = 0.85;

export function evaluarAlertas(escenarioId, iterActual, iterAnterior, probPorCelda) {
  const alertas = [];

  if (iterActual.num_celdas_ardiendo > UMBRAL_AMARILLA_CELDAS) {
    alertas.push({
      escenario_id: escenarioId, nivel: "amarilla",
      mensaje: `${iterActual.num_celdas_ardiendo} celdas ardiendo en la iteración ${iterActual.iteracion} (umbral: ${UMBRAL_AMARILLA_CELDAS})`,
      iteracion: iterActual.iteracion, creado_en: new Date().toISOString(),
    });
  }

  if (iterAnterior && iterAnterior.num_celdas_ardiendo > 0) {
    const crecimiento =
      (iterActual.num_celdas_ardiendo - iterAnterior.num_celdas_ardiendo) /
      iterAnterior.num_celdas_ardiendo;
    if (crecimiento > UMBRAL_NARANJA_CRECIMIENTO) {
      alertas.push({
        escenario_id: escenarioId, nivel: "naranja",
        mensaje: `Crecimiento de ${(crecimiento * 100).toFixed(0)}% respecto a la iteración anterior (umbral: ${UMBRAL_NARANJA_CRECIMIENTO * 100}%)`,
        iteracion: iterActual.iteracion, creado_en: new Date().toISOString(),
      });
    }
  }

  if (probPorCelda) {
    for (const c of iterActual.celdas) {
      if (c.estado !== "ardiendo") continue;
      const p = probPorCelda.get(c.celda_id);
      if (p !== undefined && p > UMBRAL_ROJA_PROBABILIDAD) {
        alertas.push({
          escenario_id: escenarioId, nivel: "roja",
          mensaje: `Celda ${String(c.celda_id).slice(0, 8)} comprometida con probabilidad ${p.toFixed(2)} (umbral: ${UMBRAL_ROJA_PROBABILIDAD})`,
          iteracion: iterActual.iteracion, celda_id: c.celda_id,
          creado_en: new Date().toISOString(),
        });
      }
    }
  }

  return alertas;
}
