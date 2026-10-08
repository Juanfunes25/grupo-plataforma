import { useState } from 'react';
import { lempiras } from '@grupo/shared';
import { post, put } from '../api.js';
import { Campo, Modal, useAccion } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';

const VACIO = { nombre_cliente: '', rtn_cliente: '', telefono_cliente: '', email_cliente: '', nombre_evento: '', fecha_evento: '', hora_evento: '', lugar: '',
  cantidad_copitas: '', precio_copita: '', costo_servicio: '', descuento: '', anticipo: '', notas: '', sucursal_id: '', partidas: [] };

const n = (v) => Number(v || 0);

/** Alta y edición de cotización: copitas + servicio + partidas libres − descuento (precios con ISV incluido). */
export default function Formulario({ cotizacion, sucursales, sucursalIdDefecto, onCerrar, onGuardada }) {
  const editando = Boolean(cotizacion);
  const [f, setF] = useState(() => editando ? {
    ...VACIO, ...Object.fromEntries(Object.keys(VACIO).map((k) => [k, cotizacion[k] ?? VACIO[k]])),
    hora_evento: cotizacion.hora_evento?.slice(0, 5) ?? '', cantidad_copitas: String(cotizacion.cantidad_copitas), precio_copita: String(cotizacion.precio_copita),
    costo_servicio: cotizacion.costo_servicio ? String(cotizacion.costo_servicio) : '', descuento: cotizacion.descuento ? String(cotizacion.descuento) : '', anticipo: cotizacion.anticipo ? String(cotizacion.anticipo) : '',
    partidas: cotizacion.partidas.map((p) => ({ descripcion: p.descripcion, cantidad: String(p.cantidad), precio_unitario: String(p.precio_unitario) })),
  } : { ...VACIO, sucursal_id: sucursalIdDefecto ?? '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const extras = f.partidas.reduce((s, p) => s + n(p.cantidad) * n(p.precio_unitario), 0);
  const subtotal = n(f.cantidad_copitas) * n(f.precio_copita) + n(f.costo_servicio) + extras;
  const total = subtotal - n(f.descuento);
  const setPartida = (i, k, v) => setF({ ...f, partidas: f.partidas.map((p, j) => (j === i ? { ...p, [k]: v } : p)) });
  const valida = f.nombre_cliente.trim().length >= 2 && f.nombre_evento.trim().length >= 2 && (n(f.cantidad_copitas) > 0 || f.partidas.length > 0)
    && f.partidas.every((p) => p.descripcion.trim() && n(p.cantidad) > 0) && n(f.descuento) <= subtotal && n(f.anticipo) <= total + 0.001;

  const guardar = async () => {
    const cuerpo = {
      ...f, rtn_cliente: f.rtn_cliente.trim() || null, fecha_evento: f.fecha_evento || null, hora_evento: f.hora_evento || null, sucursal_id: f.sucursal_id || null,
      cantidad_copitas: n(f.cantidad_copitas), precio_copita: n(f.precio_copita), costo_servicio: n(f.costo_servicio), descuento: n(f.descuento), anticipo: n(f.anticipo),
      partidas: f.partidas.map((p) => ({ descripcion: p.descripcion.trim(), cantidad: n(p.cantidad), precio_unitario: n(p.precio_unitario) })),
    };
    const r = await ejecutar(() => (editando ? put(`/cotizaciones/${cotizacion.id}`, cuerpo) : post('/cotizaciones', cuerpo)), editando ? 'Cotización guardada' : 'Cotización creada');
    if (r && r !== true) onGuardada(r);
  };

  return (
    <Modal titulo={editando ? `Editar cotización #${String(cotizacion.numero).padStart(4, '0')}` : 'Nueva cotización de evento'} onCerrar={onCerrar} tam="ancho"
      pie={<><div style={{ marginRight: 'auto' }}><small>Total</small> <b className="titulo" style={{ fontSize: '1.4rem' }}>{lempiras(total)}</b></div>
        <button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={!valida || ocupado} onClick={guardar}>{ocupado ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear cotización'}</button></>}>
      <div className="aviso-caja">Cantidad de copitas + costo de servicio, igual que se cobra hoy; agrega partidas para carrito, toppings u otros extras. Precios con ISV incluido.</div>
      <h3>Cliente</h3>
      <div className="rejilla cols-2">
        <Campo etiqueta="Nombre del cliente *"><input value={f.nombre_cliente} onChange={set('nombre_cliente')} autoFocus /></Campo>
        <Campo etiqueta="RTN (si pedirá factura con RTN)"><input value={f.rtn_cliente} onChange={set('rtn_cliente')} inputMode="numeric" /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono_cliente} onChange={set('telefono_cliente')} inputMode="tel" /></Campo>
        <Campo etiqueta="Correo"><input type="email" value={f.email_cliente} onChange={set('email_cliente')} /></Campo>
      </div>
      <h3>Evento</h3>
      <div className="rejilla cols-2">
        <Campo etiqueta="Nombre del evento * (ej. Boda García)"><input value={f.nombre_evento} onChange={set('nombre_evento')} /></Campo>
        <Campo etiqueta="Lugar"><input value={f.lugar} onChange={set('lugar')} /></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha_evento} onChange={set('fecha_evento')} /></Campo>
        <Campo etiqueta="Hora"><input type="time" value={f.hora_evento} onChange={set('hora_evento')} /></Campo>
        <Campo etiqueta="Sucursal que atiende"><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">Sin asignar</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
      </div>
      <h3>Montos</h3>
      <div className="rejilla cols-4">
        <Campo etiqueta="Cantidad de copitas"><input type="number" min="0" value={f.cantidad_copitas} onChange={set('cantidad_copitas')} /></Campo>
        <Campo etiqueta="Precio por copita (L)"><input type="number" min="0" step="0.01" value={f.precio_copita} onChange={set('precio_copita')} /></Campo>
        <Campo etiqueta="Costo de servicio (L)"><input type="number" min="0" step="0.01" value={f.costo_servicio} onChange={set('costo_servicio')} /></Campo>
        <Campo etiqueta="Descuento (L)"><input type="number" min="0" step="0.01" value={f.descuento} onChange={set('descuento')} /></Campo>
      </div>
      <div className="cot-partidas">
        <div className="fila espacio"><h3>Partidas extra</h3><button className="btn chico" onClick={() => setF({ ...f, partidas: [...f.partidas, { descripcion: '', cantidad: '1', precio_unitario: '' }] })}><Icono n="mas" tam={14} /> Agregar partida</button></div>
        {f.partidas.map((p, i) => (
          <div className="cot-partida" key={i}>
            <input placeholder="Descripción (ej. Carrito de gelato)" value={p.descripcion} onChange={(e) => setPartida(i, 'descripcion', e.target.value)} />
            <input type="number" min="0" step="any" placeholder="Cant." value={p.cantidad} onChange={(e) => setPartida(i, 'cantidad', e.target.value)} />
            <input type="number" min="0" step="0.01" placeholder="Precio (L)" value={p.precio_unitario} onChange={(e) => setPartida(i, 'precio_unitario', e.target.value)} />
            <button className="btn chico peligro" aria-label="Quitar partida" onClick={() => setF({ ...f, partidas: f.partidas.filter((_, j) => j !== i) })}><Icono n="borrar" tam={14} /></button>
          </div>
        ))}
      </div>
      <div className="cot-resumen">
        <div><span>Copitas</span><span>{lempiras(n(f.cantidad_copitas) * n(f.precio_copita))}</span></div>
        {n(f.costo_servicio) > 0 && <div><span>Servicio</span><span>{lempiras(n(f.costo_servicio))}</span></div>}
        {extras > 0 && <div><span>Partidas extra</span><span>{lempiras(extras)}</span></div>}
        {n(f.descuento) > 0 && <div><span>Descuento</span><span>− {lempiras(n(f.descuento))}</span></div>}
        <div className="total"><span>Total</span><span>{lempiras(total)}</span></div>
      </div>
      {n(f.descuento) > subtotal && <div className="aviso-caja mal">El descuento no puede ser mayor que el subtotal.</div>}
      <div className="rejilla cols-2">
        <Campo etiqueta="Anticipo recibido (L)" ayuda="Se marca en la lista de control al aceptar la cotización."><input type="number" min="0" step="0.01" value={f.anticipo} onChange={set('anticipo')} /></Campo>
        <Campo etiqueta="Notas (sabores incluidos, requisitos del lugar…)"><textarea rows={3} value={f.notas} onChange={set('notas')} /></Campo>
      </div>
    </Modal>
  );
}
