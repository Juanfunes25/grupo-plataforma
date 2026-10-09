import { useState } from 'react';
import { Estado, Kpi, useAccion, useDatos, usePedirTexto } from '../ui/kit.jsx';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BotonExcel, fmt } from './comun.jsx';

export default function EntreEmpresas() {
  const { empresas, contexto, puede } = useSesion();
  const lista = useDatos(() => get('/fin/intercompania'), []);
  const saldos = useDatos(() => get('/fin/intercompania/saldos'), []);
  const [ejecutar, ocupado] = useAccion();
  const pedir = usePedirTexto();
  const [f, setF] = useState({ destino: '', concepto: '', monto: '' });
  const yo = contexto.empresa;
  const otras = empresas.filter((e) => e.codigo !== yo.codigo);
  const recargar = () => { lista.recargar(); saldos.recargar(); };
  return (
    <>
      <div className="fila espacio"><span className="fin-nota">Lo que {yo.nombre} le vende o le cobra a otra empresa del grupo. Se resta en el consolidado para no contar la misma venta dos veces.</span><BotonExcel ruta={`/fin/exportar${qs({ reporte: 'interco' })}`} nombre="entre-empresas.xlsx" /></div>
      <Estado d={saldos}>{(s) => (
        <>
          <div className="rejilla cols-3">
            <Kpi etiqueta="Nos deben" tono={s.me_deben > 0 ? 'ok' : undefined} valor={fmt(s.me_deben)} sub="Saldo neto de las otras empresas" />
            <Kpi etiqueta="Debemos" tono={s.debo > 0 ? 'aviso' : undefined} valor={fmt(s.debo)} sub="Saldo neto a las otras empresas" />
            <Kpi etiqueta="Sin conciliar" tono={s.sin_conciliar > 0 ? 'aviso' : 'ok'} valor={s.sin_conciliar} sub="Operaciones que la otra empresa aún no confirma" />
          </div>
          {s.saldos.length > 0 && <div className="tarjeta"><h3>Saldos entre empresas</h3>{s.saldos.map((x) => <div key={x.deudor + x.acreedor} className="fila espacio"><span><b>{x.deudor_nombre}</b> le debe a <b>{x.acreedor_nombre}</b></span><b className="num">{fmt(x.saldo)}</b></div>)}</div>}
        </>
      )}</Estado>
      {puede('fin:gastos') && (
        <div className="tarjeta fila">
          <select value={f.destino} onChange={(e) => setF({ ...f, destino: e.target.value })} style={{ maxWidth: 220 }} aria-label="Empresa que debe"><option value="">Empresa que nos debe…</option>{otras.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select>
          <input placeholder="Concepto" value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} style={{ flex: 1, minWidth: 180 }} />
          <input placeholder="Monto" inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} style={{ maxWidth: 130 }} />
          <button className="btn primario" disabled={ocupado || !f.destino || f.concepto.trim().length < 3 || !(parseFloat(f.monto) > 0)} onClick={async () => { if (await ejecutar(() => post('/fin/intercompania', { destino: f.destino, concepto: f.concepto, monto: parseFloat(f.monto) }), 'Registrado')) { setF({ destino: '', concepto: '', monto: '' }); recargar(); } }}>Registrar</button>
        </div>
      )}
      <Estado d={lista}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap libre"><table data-tarjetas>
          <thead><tr><th>Fecha</th><th>Cobra</th><th>Debe</th><th>Concepto</th><th className="der">Monto</th><th className="der">Pendiente</th><th>Estado</th><th></th></tr></thead>
          <tbody>{l.map((i) => {
            const pend = Math.round((Number(i.monto) - Number(i.monto_pagado ?? 0)) * 100) / 100;
            const soyDestino = i.empresa_destino_id === yo.id;
            return (
              <tr key={i.id}>
                <td className="num" data-etq="">{String(i.fecha).slice(0, 10)}</td><td data-etq="Cobra">{i.origen}</td><td data-etq="Debe">{i.destino}</td><td data-etq="Concepto">{i.concepto}</td>
                <td className="der num" data-etq="Monto">{fmt(i.monto)}</td><td className="der num" data-etq="Pendiente">{pend > 0 ? fmt(pend) : <span className="chip ok">saldada</span>}</td>
                <td data-etq="Estado">{i.estado === 'conciliado' ? <span className="chip ok" title={i.nota ?? ''}>conciliada</span> : <span className="chip aviso">por conciliar</span>}</td>
                <td className="der" data-etq="">
                  <div className="fila" style={{ justifyContent: 'flex-end', flexWrap: 'nowrap' }}>
                    {puede('fin:gastos') && i.estado !== 'conciliado' && (soyDestino || contexto.permisos.includes('grupo:ver')) && <button className="btn chico" onClick={async () => { const nota = await pedir({ titulo: 'Conciliar operación', mensaje: `${i.origen} registró ${fmt(i.monto)} por «${i.concepto}». Confirma que ${i.destino} reconoce esta operación.`, etiqueta: 'Nota (opcional)', textoOk: 'Conciliar' }); if (nota !== null && await ejecutar(() => put(`/fin/intercompania/${i.id}/conciliar`, { nota: nota || null }), 'Conciliada')) recargar(); }}>Conciliar</button>}
                    {puede('fin:gastos') && pend > 0 && <button className="btn chico" onClick={async () => { const m = await pedir({ titulo: 'Registrar pago', mensaje: `Pendiente: ${fmt(pend)}`, etiqueta: 'Monto pagado (L)', obligatorio: true, inputMode: 'decimal', valor: String(pend), textoOk: 'Guardar' }); if (m && await ejecutar(() => post(`/fin/intercompania/${i.id}/pago`, { monto: parseFloat(m) }), 'Pago registrado')) recargar(); }}>Pago</button>}
                  </div>
                </td>
              </tr>);
          })}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin operaciones entre empresas.</div>}</div></div>
      )}</Estado>
    </>
  );
}
