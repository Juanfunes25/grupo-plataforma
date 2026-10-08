import { useState } from 'react';
import { get, qs } from '../api.js';
import { Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { ESTADO_INFO, fechaCorta, textoVence } from './cliente.js';
import Ficha from './Ficha.jsx';

/** Dirección → Documentos: vencimientos próximos y vencidos de todo el grupo, y faltantes por empresa. */
export default function GrupoDocumentos() {
  const [dias, setDias] = useState(90);
  const [empresa, setEmpresa] = useState('');
  const [abierto, setAbierto] = useState(null);      // { id, empresa }
  const d = useDatos(() => get(`/grupo/documentos${qs({ dias })}`), [dias]);
  return (
    <Estado d={d}>{(r) => {
      const prox = r.proximos.filter((x) => !empresa || x.empresa === empresa);
      return (
        <>
          <div className="rejilla cols-4">
            <Kpi etiqueta="Vencidos en el grupo" valor={r.total.vencidos} acento={r.total.vencidos > 0} />
            <Kpi etiqueta="Vencen en 30 días" valor={r.total.d30} />
            <Kpi etiqueta="Entre 31 y 90 días" valor={r.total.d60 + r.total.d90} />
            <Kpi etiqueta="Faltan por registrar" valor={r.total.faltan + r.total.sin_vigente} sub="según el checklist de cada empresa" acento={r.total.faltan + r.total.sin_vigente > 0} />
          </div>
          <div className="rejilla cols-4">
            {r.empresas.map((e) => (
              <section key={e.codigo} className="tarjeta" style={{ borderTop: `4px solid ${e.color}`, display: 'grid', gap: 6 }}>
                <div className="fila espacio"><h3 style={{ margin: 0 }}>{e.nombre}</h3><button className="btn chico fantasma" onClick={() => setEmpresa(empresa === e.codigo ? '' : e.codigo)}>{empresa === e.codigo ? 'Ver todas' : 'Filtrar'}</button></div>
                <small>{e.kpis.vigentes} vigentes · <b style={{ color: e.kpis.vencidos ? 'var(--peligro)' : undefined }}>{e.kpis.vencidos} vencidos</b> · {e.kpis.d30} en 30 días</small>
                {e.checklist.faltantes.length === 0 ? <small className="chip ok">Checklist completo</small> : (
                  <div style={{ display: 'grid', gap: 3 }}><small className="tenue">Faltan ({e.checklist.faltantes.length}):</small>
                    {e.checklist.faltantes.slice(0, 5).map((i) => <small key={`${i.tipo}-${i.sucursal_id}`}>• {i.tipo_nombre}{i.sucursal ? ` — ${i.sucursal}` : ''}{i.estado === 'vencido' ? ' (vencido)' : ''}</small>)}
                    {e.checklist.faltantes.length > 5 && <small className="tenue">y {e.checklist.faltantes.length - 5} más</small>}
                  </div>)}
              </section>))}
          </div>
          <div className="fila espacio"><h3 style={{ margin: 0 }}>Vencimientos y vencidos</h3>
            <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Horizonte"><option value={30}>Próximos 30 días</option><option value={60}>Próximos 60 días</option><option value={90}>Próximos 90 días</option><option value={180}>Próximos 180 días</option></select></div>
          {prox.length === 0 ? <div className="vacio">Nada vencido ni por vencer en este horizonte.</div> : (
            <div className="tarjeta pad0"><div className="tabla-wrap"><table>
              <thead><tr><th>Empresa</th><th>Documento</th><th>Sucursal</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
              <tbody>{prox.map((x) => (
                <tr key={x.id}>
                  <td><span style={{ color: x.empresa_color }}>●</span> {x.empresa_nombre}</td>
                  <td><b>{x.titulo}</b>{x.confidencialidad === 'restringido' && ' 🔒'}<div><small className="tenue">{x.tipo_nombre}</small></div></td>
                  <td>{x.sucursal ?? '—'}</td><td className="num">{fechaCorta(x.fecha_vencimiento)}</td>
                  <td><span className={`chip ${ESTADO_INFO[x.estado].clase}`}>{textoVence(x)}</span></td>
                  <td className="der"><button className="btn chico fantasma" onClick={() => setAbierto({ id: x.id, empresa: x.empresa })}>Abrir</button></td>
                </tr>))}</tbody>
            </table></div></div>)}
          {abierto && <Ficha id={abierto.id} empresa={abierto.empresa} soloLectura onCerrar={() => setAbierto(null)} />}
        </>
      );
    }}</Estado>
  );
}
