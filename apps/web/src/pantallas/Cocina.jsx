import { useCallback, useEffect, useState } from 'react';
import { horaHN } from '@grupo/shared';
import { get, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { ErrorCaja, useAccion } from '../ui/kit.jsx';

const COLS = [['pendiente', 'Pendientes'], ['preparando', 'Preparando'], ['listo', 'Listos para entregar']];
const SIGUIENTE = { pendiente: ['preparando', 'Empezar'], preparando: ['listo', 'Listo'], listo: ['entregado', 'Entregado'] };

export default function Cocina() {
  const { sucursalId } = useSesion();
  const [ordenes, setOrdenes] = useState([]);
  const [error, setError] = useState('');
  const [ahora, setAhora] = useState(Date.now());
  const [ejecutar] = useAccion();

  const cargar = useCallback(async () => {
    try { setOrdenes(await get(`/pos/kds${qs({ sucursal_id: sucursalId })}`)); setError(''); } catch (e) { setError(e.message); }
  }, [sucursalId]);
  useEffect(() => { cargar(); const t = setInterval(cargar, 6000); const r = setInterval(() => setAhora(Date.now()), 20000); return () => { clearInterval(t); clearInterval(r); }; }, [cargar]);

  const mover = (o) => ejecutar(async () => { await put(`/pos/ventas/${o.id}/prep`, { estado: SIGUIENTE[o.estado_prep][0] }); await cargar(); });
  const mins = (o) => Math.max(0, Math.round((ahora - new Date(o.fecha_emision).getTime()) / 60000));

  return (
    <div className="pagina" style={{ maxWidth: 1500 }}>
      <div className="encabezado-pagina"><h1>Cocina</h1><small>Se actualiza sola cada 6 segundos</small></div>
      <ErrorCaja error={error} />
      <div className="rejilla cols-3" style={{ alignItems: 'start' }}>
        {COLS.map(([estado, nombre]) => {
          const lista = ordenes.filter((o) => o.estado_prep === estado);
          return (
            <section key={estado} className="rejilla" style={{ alignContent: 'start' }}>
              <h2>{nombre} <span className="chip">{lista.length}</span></h2>
              {lista.length === 0 && <div className="vacio tarjeta">—</div>}
              {lista.map((o) => (
                <article key={o.id} className="tarjeta" style={{ borderColor: mins(o) > 10 && estado !== 'listo' ? 'var(--peligro)' : undefined }}>
                  <div className="fila espacio">
                    <b className="titulo" style={{ fontSize: '1.7rem' }}>#{o.ticket_dia} {o.nombre_orden}</b>
                    <span className={`chip ${mins(o) > 10 && estado !== 'listo' ? 'mal' : ''}`}>{mins(o)} min · {horaHN(o.fecha_emision)}</span>
                  </div>
                  <small>{o.tipo_orden === 'llevar' ? 'PARA LLEVAR' : 'AQUÍ'} · {o.canal}</small>
                  <ul style={{ margin: '8px 0', paddingLeft: 18, display: 'grid', gap: 4, fontSize: '1.05rem' }}>
                    {o.lineas?.map((l, i) => (
                      <li key={i}><b>{Number(l.cantidad)}×</b> {l.nombre}
                        {l.opciones?.map((x) => <small key={x.id} className="tenue" style={{ display: 'block' }}>+ {x.nombre}</small>)}
                        {l.notas && <small style={{ display: 'block', color: 'var(--aviso)' }}>“{l.notas}”</small>}</li>
                    ))}
                  </ul>
                  {o.notas && <div className="aviso-caja">{o.notas}</div>}
                  <button className="btn primario grande bloque" onClick={() => mover(o)} style={{ marginTop: 8 }}>{SIGUIENTE[estado][1]}</button>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
