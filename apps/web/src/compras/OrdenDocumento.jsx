// Documento imprimible de la orden de compra (Imprimir / Guardar como PDF desde el navegador).
import { useState } from 'react';
import { useAccion } from '../ui/kit.jsx';
import { post } from '../api.js';
import { cant, dinero } from './comun.jsx';

export default function OrdenDocumento({ orden: o, onCerrar }) {
  const [ejecutar, ocupado] = useAccion();
  const [correo, setCorreo] = useState(o.proveedor_correo ?? '');
  const [msg, setMsg] = useState(null);
  const e = o.empresa;
  const enviarCorreo = async () => {
    setMsg(null);
    try {
      const r = await ejecutar(() => post(`/compras/ordenes/${o.id}/correo`, { para: correo || null }));
      if (r) setMsg(r.ok ? `Correo enviado a ${correo}.` : r.pendiente ? 'El correo quedó pendiente: se enviará cuando Gmail esté configurado en el servidor.' : (r.error ?? 'No se pudo enviar el correo.'));
    } catch { /* useAccion ya avisó */ }
  };
  return (
    <div className="oc-velo" role="dialog" aria-modal="true" aria-label={`Orden de compra ${o.numero}`}>
      <div className="oc-barra">
        {o.estado !== 'anulada' && (
          <>
            <input type="email" placeholder="Correo del proveedor" value={correo} onChange={(ev) => setCorreo(ev.target.value)} style={{ flex: '1 1 220px', maxWidth: 300 }} aria-label="Correo del proveedor" />
            <button className="btn" disabled={ocupado || !correo} onClick={enviarCorreo}>Enviar por correo</button>
          </>
        )}
        <button className="btn primario" onClick={() => window.print()}>Imprimir / PDF</button>
        <button className="btn" onClick={onCerrar}>Cerrar</button>
      </div>
      {msg && <div className="oc-barra"><div className="aviso-caja info" style={{ flex: 1 }}>{msg}</div></div>}
      <article className="oc-hoja" style={{ '--color': e.color }}>
        <header className="oc-cab">
          <div>
            <h1>{e.razon_social || e.nombre}</h1>
            <div>{[e.rtn && `RTN ${e.rtn}`, e.telefono, e.correo].filter(Boolean).join(' · ')}</div>
            <div>{[e.direccion, e.ciudad].filter(Boolean).join(', ')}</div>
          </div>
          <div className="num"><h2>Orden de compra</h2><b>N.° {o.numero}</b>{o.estado === 'borrador' && <span className="oc-borrador">BORRADOR</span>}{o.estado === 'anulada' && <span className="oc-borrador">ANULADA</span>}<div>Fecha {o.fecha}</div></div>
        </header>
        <section className="oc-datos">
          <div><h2>Proveedor</h2><b>{o.proveedor}</b><div>{[o.proveedor_rtn && `RTN ${o.proveedor_rtn}`, o.proveedor_telefono].filter(Boolean).join(' · ')}</div><div>{o.proveedor_direccion}</div></div>
          <div><h2>Entrega y pago</h2>
            <div>Entrega esperada: <b>{o.fecha_esperada ?? 'por acordar'}</b></div>
            {o.sucursal && <div>Entregar en: <b>{o.sucursal}</b></div>}
            <div>Condición: <b>{o.condicion === 'credito' ? `crédito a ${o.dias_credito} días` : 'contado'}</b></div>
            <div>Moneda: <b>{o.moneda === 'USD' ? `dólares (cambio L ${o.tipo_cambio})` : 'lempiras'}</b></div></div>
        </section>
        <table>
          <thead><tr><th>#</th><th>Descripción</th><th className="der">Cantidad</th><th>Unidad</th><th className="der">Precio</th><th className="der">Importe</th></tr></thead>
          <tbody>{o.lineas.map((l, i) => <tr key={l.id}><td>{i + 1}</td><td>{l.descripcion}</td><td className="der num">{cant(l.cantidad)}</td><td>{l.unidad}</td><td className="der num">{dinero(l.precio_unitario, o.moneda)}</td><td className="der num">{dinero(Math.round(l.cantidad * l.precio_unitario * 100) / 100, o.moneda)}</td></tr>)}</tbody>
        </table>
        <div className="oc-tot">
          <div><span>Subtotal</span><span className="num">{dinero(o.subtotal, o.moneda)}</span></div>
          {o.isv_pct > 0 && <div><span>ISV {o.isv_pct} %</span><span className="num">{dinero(o.isv, o.moneda)}</span></div>}
          <div className="g"><span>Total</span><span className="num">{dinero(o.total, o.moneda)}</span></div>
        </div>
        {o.notas && <p><b>Notas:</b> {o.notas}</p>}
        <div className="oc-firmas"><div>Elaborado por</div><div>Autorizado por</div><div>Recibido por</div></div>
      </article>
    </div>
  );
}
