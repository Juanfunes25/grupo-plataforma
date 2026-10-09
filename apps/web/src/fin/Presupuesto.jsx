import { useEffect, useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { Estado, Kpi, useAccion, useConfirmar, useDatos } from '../ui/kit.jsx';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BotonExcel, Semaforo, fmt, neg } from './comun.jsx';
import { GRUPOS } from './Resultados.jsx';

const mesAnterior = (mes) => { const [y, m] = mes.split('-').map(Number); const d = new Date(Date.UTC(y, m - 2, 1)); return d.toISOString().slice(0, 7); };

export default function Presupuesto() {
  const { puede } = useSesion();
  const [mes, setMes] = useState(fechaHN().slice(0, 7));
  const d = useDatos(() => get(`/fin/presupuesto${qs({ mes })}`), [mes]);
  const [edit, setEdit] = useState({});
  const [ejecutar, ocupado] = useAccion();
  const confirmar = useConfirmar();
  useEffect(() => setEdit({}), [d.datos]);
  const puedeEditar = puede('fin:presupuesto');
  const sucio = Object.keys(edit).length > 0;
  const guardar = async () => {
    const lineas = Object.entries(edit).map(([clave, v]) => ({ clave, monto: parseFloat(String(v).replace(/,/g, '')) || 0 }));
    if (await ejecutar(() => put('/fin/presupuesto', { mes, lineas }), 'Presupuesto guardado')) d.recargar();
  };
  const copiar = async () => {
    const o = mesAnterior(mes);
    if (!(await confirmar({ titulo: 'Copiar presupuesto', mensaje: `Se copian al mes ${mes} las líneas de ${o} que aún no tengan monto. ¿Seguir?`, textoOk: 'Copiar' }))) return;
    if (await ejecutar(() => post('/fin/presupuesto/copiar', { desde_mes: o, mes }), 'Presupuesto copiado')) d.recargar();
  };
  const valor = (l) => edit[l.clave] ?? (l.presupuesto || '');
  const fila = (l) => {
    const pct = l.pct ?? 0;
    return (
      <tr key={l.clave}>
        <td data-etq="">{l.nombre}{l.grupo !== 'ventas' && <small> · {GRUPOS[l.grupo] ?? l.grupo}</small>}</td>
        <td className="der" data-etq="Presupuesto">{puedeEditar ? <input className="fin-input-num" inputMode="decimal" aria-label={`Presupuesto de ${l.nombre}`} value={valor(l)} placeholder="0" onChange={(e) => setEdit({ ...edit, [l.clave]: e.target.value })} /> : <span className="num">{fmt(l.presupuesto)}</span>}</td>
        <td className="der num" data-etq="Real">{fmt(l.real)}</td>
        <td data-etq="Avance"><div className="fin-pres-barra" title={l.pct == null ? '' : `${l.pct} %`}><i className={l.estado} style={{ width: `${Math.min(100, pct)}%` }} /></div></td>
        <td className="der num" data-etq="Proyección">{l.presupuesto > 0 ? fmt(l.proyeccion) : '—'}</td>
        <td data-etq="Situación"><Semaforo estado={l.estado} /></td>
      </tr>
    );
  };
  return (
    <Estado d={d}>{(p) => (
      <>
        <div className="fila espacio">
          <div className="fin-barra"><label>Mes<input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} /></label></div>
          <div className="fila">
            {puedeEditar && <button className="btn" onClick={copiar} disabled={ocupado}>Copiar del mes anterior</button>}
            {puedeEditar && <button className="btn primario" onClick={guardar} disabled={ocupado || !sucio}>Guardar presupuesto</button>}
            <BotonExcel ruta={`/fin/exportar${qs({ reporte: 'presupuesto', mes })}`} nombre={`presupuesto-${mes}.xlsx`} />
          </div>
        </div>
        <div className="rejilla cols-4">
          <Kpi etiqueta="Ventas: presupuesto" valor={fmt(p.ventas.presupuesto)} sub={`Real ${fmt(p.ventas.real)}${p.ventas.pct != null ? ` (${p.ventas.pct} %)` : ''}`} />
          <Kpi etiqueta="Gastos: presupuesto" valor={fmt(p.totales.gastos_presupuesto)} sub={`Real ${fmt(p.totales.gastos_real)}`} tono={p.totales.gastos_real > p.totales.gastos_presupuesto && p.totales.gastos_presupuesto > 0 ? 'mal' : undefined} />
          <Kpi etiqueta="Resultado presupuestado" valor={fmt(p.totales.resultado_presupuesto)} sub="Ventas menos gastos" />
          <Kpi etiqueta="Resultado real" tono={p.totales.resultado_real < 0 ? 'mal' : undefined} valor={fmt(p.totales.resultado_real)} sub={`Día ${p.transcurridos} de ${p.dias}`} />
        </div>
        {!p.totales.hay_presupuesto && <div className="aviso-caja info">Aún no hay presupuesto para este mes. {puedeEditar ? 'Escribe los montos en la columna «Presupuesto» (o cópialos del mes anterior) y guarda.' : 'Pídele a dirección o a contabilidad que lo defina.'}</div>}
        <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
          <thead><tr><th>Concepto</th><th className="der">Presupuesto</th><th className="der">Real</th><th>Avance</th><th className="der">Proyección al cierre</th><th>Situación</th></tr></thead>
          <tbody>
            <tr className="fin-separador"><td colSpan={6}>Ventas</td></tr>{fila(p.ventas)}
            <tr className="fin-separador"><td colSpan={6}>Gastos (sin ISV)</td></tr>{p.gastos.map(fila)}
            <tr className="fin-total"><td data-etq="">Resultado (ventas menos gastos)</td><td className="der num" data-etq="Presupuesto">{fmt(p.totales.resultado_presupuesto)}</td><td className={`der num ${neg(p.totales.resultado_real) ?? ''}`} data-etq="Real">{fmt(p.totales.resultado_real)}</td><td></td><td></td><td></td></tr>
          </tbody>
        </table></div></div>
        <p className="fin-nota">La proyección extrapola el ritmo del mes. «En riesgo» en un gasto: si sigue así se pasará del presupuesto; en ventas: se quedará por debajo.</p>
      </>
    )}</Estado>
  );
}
