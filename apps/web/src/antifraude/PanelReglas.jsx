import { useEffect, useState } from 'react';
import { get, put } from '../api.js';
import { Estado, useAccion, useDatos } from '../ui/kit.jsx';

const GRUPOS = [
  { grupo: 'Descuentos y tercera edad', campos: [
    ['descuento_pct_max', '% de descuento sobre ventas de un cajero que se considera alto'],
    ['descuento_min_facturas', 'Facturas mínimas para evaluar el % de descuento'],
    ['max_usos_carne_dia', 'Veces que un mismo carné puede usarse al día antes de alertar'],
    ['max_tercera_edad_dia', 'Facturas con 3ª edad por cajero al día antes de alertar'],
  ] },
  { grupo: 'Órdenes y facturas', campos: [
    ['monto_alerta_descarte', 'Monto (L) de orden descartada que genera alerta'],
    ['minutos_orden_estacionada', 'Minutos de una orden abierta sin cobrar antes de alertar'],
    ['minutos_doble_factura', 'Ventana (min) para detectar doble factura'],
    ['reimpresiones_max', 'Reimpresiones por persona en el periodo antes de alertar'],
    ['reimpresiones_por_factura', 'Copias de una misma factura antes de alertar'],
    ['anulaciones_pct_max', '% de facturas anuladas de un cajero que se considera alto'],
    ['anulaciones_min', 'Anulaciones mínimas para evaluar el %'],
  ] },
  { grupo: 'Caja', campos: [
    ['descuadre_max', 'Faltante o sobrante (L) tolerado en un cierre'],
    ['umbral_sobrante', 'Sobrante (L) que se considera relevante'],
    ['faltantes_reincidencia', 'Cierres con faltante en 7 días para alerta de reincidencia'],
    ['minutos_hueco', 'Minutos sin facturar que cuentan como hueco'],
    ['hueco_desde_hora', 'Hora desde la que se espera que haya ventas (0-23)'],
    ['hueco_hasta_hora', 'Hora hasta la que se espera que haya ventas (1-24)'],
  ] },
  { grupo: 'Sesiones', campos: [
    ['minutos_bloqueo_cajero', 'Bloquear la pantalla del cajero tras (min) sin uso (0 = nunca)'],
    ['minutos_bloqueo_otros', 'Bloquear la pantalla de los demás tras (min) sin uso (0 = nunca)'],
    ['intentos_login', 'Intentos fallidos de entrada (15 min) antes de alertar'],
    ['hora_apertura', 'Hora desde la que el uso del sistema es normal (0-23)'],
    ['hora_cierre', 'Hora hasta la que el uso es normal (1-24)'],
  ] },
];

export default function PanelReglas() {
  const d = useDatos(() => get('/antifraude/reglas'), []);
  const [vals, setVals] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  useEffect(() => { if (d.datos) setVals(d.datos); }, [d.datos]);
  const guardar = async () => { const r = await ejecutar(() => put('/antifraude/reglas', vals), 'Reglas guardadas. Aplican de inmediato.'); if (r && r !== true) setVals(r); };
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
      <h3>Reglas y umbrales</h3>
      <small>Ajusta qué tan estricto es el sistema en esta empresa. Cada cambio queda en la bitácora.</small>
      <Estado d={d}>{() => vals && (
        <>
          <div className="af-reglas">
            {GRUPOS.map((g) => (
              <fieldset key={g.grupo}><legend>{g.grupo}</legend>
                {g.campos.map(([k, etiqueta]) => (
                  <label key={k}><span>{etiqueta}</span><input type="number" min="0" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></label>
                ))}
              </fieldset>
            ))}
          </div>
          <div><button className="btn primario" disabled={ocupado} onClick={guardar}>Guardar reglas</button></div>
        </>
      )}</Estado>
    </div>
  );
}
