import { useCallback, useEffect, useMemo, useState } from 'react';
import { fechaHoraHN, numero } from '@grupo/shared';
import { get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, ErrorCaja, Modal, descargarCsv, useAviso } from '../ui/kit.jsx';
import { colorDe } from '../ui/sucursales.js';

// Etiquetas de las acciones que registra la plataforma (cualquier otra se muestra legible por su nombre).
const ACCIONES = {
  venta_cobrada: 'Emitió factura', venta_anulada: 'Anuló factura', nota_credito_emitida: 'Emitió nota de crédito', factura_reimpresa: 'Reimprimió factura',
  turno_abierto: 'Abrió turno', turno_cerrado: 'Cerró caja', movimiento_caja: 'Movimiento de caja',
  cotizacion_creada: 'Creó cotización', cotizacion_editada: 'Editó cotización', cotizacion_estado: 'Cambió estado de cotización', cotizacion_aceptada: 'Aceptó y agendó cotización',
  cotizacion_facturada: 'Facturó cotización', cotizacion_eliminada: 'Eliminó cotización', evento_seguimiento: 'Seguimiento de evento', evento_reprogramado: 'Reprogramó evento',
  cai_activado: 'Activó CAI real (SAR)', punto_emision_editado: 'Modificó CAI / correlativo', cai_vuelto_a_borrador: 'Volvió a modo borrador',
  usuario_creado: 'Creó usuario', usuario_editado: 'Editó usuario', password_restablecida: 'Restableció contraseña', pin_asignado: 'Asignó PIN', pin_quitado: 'Quitó PIN', acceso_asignado: 'Dio acceso a la empresa',
  sucursal_creada: 'Creó sucursal', sucursal_editada: 'Editó sucursal', empresa_editada: 'Editó datos de la empresa', modulo_encendido: 'Encendió módulo', modulo_apagado: 'Apagó módulo',
  login: 'Inició sesión', login_fallido: 'Intento de entrada fallido', pin_fallido: 'PIN incorrecto', reglas_antifraude: 'Cambió reglas antifraude',
  producto_creado: 'Creó producto', producto_editado: 'Editó producto', grupo_creado: 'Creó grupo de opciones', grupo_editado: 'Editó grupo de opciones',
  compra_registrada: 'Registró compra', merma_registrada: 'Registró merma', conteo_inventario: 'Conteo de inventario', traslado: 'Traslado entre sucursales', insumo_creado: 'Creó insumo', receta_editada: 'Editó receta',
  gasto_registrado: 'Registró gasto', gasto_anulado: 'Anuló gasto', intercompania_registrada: 'Operación intercompañía', tercero_creado: 'Creó cliente/proveedor', tercero_editado: 'Editó cliente/proveedor',
  empleado_alta: 'Alta de empleado', empleado_editado: 'Editó empleado', empleado_baja: 'Baja de empleado', marcacion_manual: 'Marcación manual',
};
const etiquetaAccion = (a) => ACCIONES[a] ?? (a.charAt(0).toUpperCase() + a.slice(1).replaceAll('_', ' ').replaceAll('.', ' · '));

// Acciones que merecen atención inmediata al revisar la bitácora.
const SENSIBLES = new Set(['venta_anulada', 'nota_credito_emitida', 'factura_reimpresa', 'cai_activado', 'punto_emision_editado', 'cai_vuelto_a_borrador', 'password_restablecida',
  'pin_asignado', 'pin_quitado', 'usuario_creado', 'login_fallido', 'pin_fallido', 'reglas_antifraude', 'modulo_apagado', 'cotizacion_facturada', 'administrador_general_asignado']);

const FILTROS_ACCION = [
  ['', 'Todas las acciones'], ['venta_', 'Todo sobre ventas'], ['venta_anulada', 'Anulaciones'], ['nota_credito', 'Notas de crédito'], ['factura_', 'Reimpresiones'],
  ['cotizacion_', 'Cotizaciones'], ['evento_', 'Seguimiento de eventos'], ['cai_', 'Activación de CAI'], ['punto_emision', 'Cambios de CAI / correlativo'],
  ['usuario_', 'Cambios de usuarios'], ['pin_', 'PIN'], ['password_', 'Contraseñas'], ['sucursal_', 'Sucursales'], ['turno_', 'Turnos y cierres'],
  ['producto_', 'Productos y precios'], ['login', 'Inicios de sesión'], ['pin_fallido', 'PIN incorrectos'],
];

function documento(r) {
  const d = r.detalle ?? {};
  if (d.numero_factura || d.factura) return d.numero_factura ?? d.factura;
  if (d.numero_cotizacion != null) return `Cotización #${d.numero_cotizacion}`;
  if (r.entidad === 'cotizacion' && d.numero != null) return `Cotización #${d.numero}`;
  if (d.numero_orden) return `Orden #${d.numero_orden}`;
  return d.nombre ?? d.evento ?? '—';
}
const valor = (v) => (v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function resumen(r) {
  const d = r.detalle ?? {};
  if (d.cambios && Object.keys(d.cambios).length) return Object.entries(d.cambios).map(([k, c]) => `${k}: ${valor(c?.antes)} → ${valor(c?.despues)}`).join(' · ');
  if (d.de !== undefined && d.a !== undefined) return `${valor(d.de)} → ${valor(d.a)}${d.total != null ? ` · L ${d.total}` : ''}`;
  if (d.reprogramado) return `Reprogramado: ${d.reprogramado.de} → ${d.reprogramado.a}`;
  if (d.paso) return `${d.paso.item}: ${d.paso.hecho ? 'hecho' : 'pendiente'}`;
  return Object.entries(d).filter(([k, v]) => v !== null && k !== 'nombre').map(([k, v]) => `${k.replaceAll('_', ' ')}: ${valor(v)}`).join(' · ');
}

const HOY = () => new Date().toISOString().slice(0, 10);

function Detalle({ r, onCerrar }) {
  return (
    <Modal titulo={etiquetaAccion(r.accion)} onCerrar={onCerrar} tam="ancho">
      <div className="rejilla cols-3">
        <Campo etiqueta="Fecha y hora"><b>{fechaHoraHN(r.created_at)}</b></Campo>
        <Campo etiqueta="Usuario"><b>{r.usuario_nombre ?? 'Sistema'}</b></Campo>
        <Campo etiqueta="Sucursal"><b>{r.sucursal ?? '—'}</b></Campo>
        <Campo etiqueta="Documento"><b>{documento(r)}</b></Campo>
        <Campo etiqueta="Entidad"><b>{r.entidad || '—'}{r.entidad_id ? ` · ${r.entidad_id.slice(0, 8)}` : ''}</b></Campo>
        <Campo etiqueta="IP"><b className="num">{r.ip ?? '—'}</b></Campo>
      </div>
      <div><h3 style={{ marginBottom: 6 }}>Detalle</h3>
        <pre style={{ margin: 0, padding: 12, background: 'var(--panel-2)', borderRadius: 'var(--radio-s)', overflow: 'auto', fontSize: '.82rem', whiteSpace: 'pre-wrap' }}>{JSON.stringify(r.detalle ?? {}, null, 2)}</pre></div>
      <div><h3 style={{ marginBottom: 6 }}>Cadena de integridad #{r.id}</h3>
        <small className="num" style={{ display: 'block', wordBreak: 'break-all' }}>Hash anterior: {r.hash_anterior ?? 'GENESIS (primer registro)'}</small>
        <small className="num" style={{ display: 'block', wordBreak: 'break-all' }}>Hash: {r.hash}</small>
        <small>Cada registro incluye el hash del anterior: si alguien altera o borra uno, la verificación lo detecta.</small></div>
    </Modal>
  );
}

export function ContenidoBitacora() {
  const { sucursales } = useSesion();
  const avisar = useAviso();
  const [f, setF] = useState({ accion: '', usuario_id: '', sucursal_id: '', desde: '', hasta: '', q: '' });
  const [regs, setRegs] = useState([]);
  const [hayMas, setHayMas] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [ver, setVer] = useState(null);          // verificación de integridad
  const [detalle, setDetalle] = useState(null);
  const LIM = 300;

  const buscar = useCallback(async (filtros, antes = null) => {
    setCargando(true); setError(null);
    try {
      const l = await get(`/admin/auditoria${qs({ ...filtros, limite: LIM, antes_de: antes })}`);
      setRegs((x) => (antes ? [...x, ...l] : l));
      setHayMas(l.length === LIM);
    } catch (e) { setError(e.message); } finally { setCargando(false); }
  }, []);
  const verificar = useCallback(async () => {
    setVer({ cargando: true });
    try { setVer(await get('/admin/auditoria/verificar')); } catch (e) { setVer(null); setError(e.message); }
  }, []);

  useEffect(() => { buscar({}); verificar(); get('/admin/auditoria/usuarios').then(setUsuarios).catch(() => {}); }, [buscar, verificar]);

  const filas = useMemo(() => regs.map((r) => ({ ...r, _fecha: fechaHoraHN(r.created_at), _accion: etiquetaAccion(r.accion), _doc: documento(r), _resumen: resumen(r) })), [regs]);
  const exportar = () => descargarCsv(`bitacora-${HOY()}.csv`, filas, [['_fecha', 'Fecha'], ['usuario_nombre', 'Usuario'], ['_accion', 'Acción'], ['accion', 'Código de acción'], ['_doc', 'Documento'],
    ['sucursal', 'Sucursal'], ['_resumen', 'Detalle'], ['ip', 'IP'], ['hash', 'Hash']]);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const enviar = (e) => { e?.preventDefault(); buscar(f); };

  return (
    <>
      <div className="fila espacio" style={{ alignItems: 'flex-start' }}>
        <small style={{ maxWidth: 560 }}>Registro permanente de quién creó, editó, facturó, anuló o cambió cada cosa. Nadie puede modificarlo ni borrarlo, ni siquiera un administrador: cada registro lleva el hash del anterior.</small>
        {ver && (ver.cargando ? <span className="chip">Verificando integridad…</span>
          : ver.integra ? <span className="chip ok">✓ Íntegra · {numero(ver.total)} registros encadenados</span>
            : <span className="chip mal">⚠ Registro alterado detectado (#{ver.primer_id_alterado})</span>)}
      </div>
      <form className="tarjeta" onSubmit={enviar} style={{ display: 'grid', gap: 12 }}>
        <div className="rejilla cols-4">
          <Campo etiqueta="Buscar"><input placeholder="Usuario, factura, texto del detalle…" value={f.q} onChange={set('q')} /></Campo>
          <Campo etiqueta="Acción"><select value={f.accion} onChange={set('accion')}>{FILTROS_ACCION.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></Campo>
          <Campo etiqueta="Usuario"><select value={f.usuario_id} onChange={set('usuario_id')}><option value="">Todos los usuarios</option>{usuarios.map((u) => <option key={u.id} value={u.id}>{u.nombre}</option>)}</select></Campo>
          <Campo etiqueta="Sucursal"><select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">Todas las sucursales</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
          <Campo etiqueta="Desde"><input type="date" value={f.desde} onChange={set('desde')} /></Campo>
          <Campo etiqueta="Hasta"><input type="date" value={f.hasta} onChange={set('hasta')} /></Campo>
        </div>
        <div className="fila">
          <button className="btn primario" type="submit" disabled={cargando}>{cargando ? 'Buscando…' : 'Buscar'}</button>
          <button className="btn fantasma" type="button" onClick={() => { const v = { accion: '', usuario_id: '', sucursal_id: '', desde: '', hasta: '', q: '' }; setF(v); buscar(v); }}>Limpiar</button>
          <button className="btn" type="button" onClick={verificar}>Verificar integridad</button>
          <button className="btn" type="button" disabled={!filas.length} onClick={() => { exportar(); avisar(`Exportadas ${filas.length} filas`); }}>Exportar CSV</button>
          <small>{numero(filas.length)} registros cargados</small>
        </div>
      </form>
      <ErrorCaja error={error} />
      <div className="tarjeta pad0"><div className="tabla-wrap"><table>
        <thead><tr><th>Fecha y hora</th><th>Usuario</th><th>Acción</th><th>Documento</th><th>Detalle</th></tr></thead>
        <tbody>
          {filas.map((r) => {
            const suc = sucursales.find((s) => s.id === r.sucursal_id);
            return (
              <tr key={r.id} className="clic" onClick={() => setDetalle(r)} style={SENSIBLES.has(r.accion) ? { boxShadow: 'inset 3px 0 0 var(--aviso)' } : undefined}>
                <td style={{ whiteSpace: 'nowrap' }}>{r._fecha}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{suc && <i title={suc.nombre} style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: colorDe(suc), marginRight: 6 }} />}{r.usuario_nombre ?? 'Sistema'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{SENSIBLES.has(r.accion) ? <span className="chip aviso">{r._accion}</span> : r._accion}</td>
                <td style={{ whiteSpace: 'nowrap' }} className="num">{r._doc}</td>
                <td><small title={`IP ${r.ip ?? '—'} · hash ${r.hash}`}>{r._resumen.length > 140 ? `${r._resumen.slice(0, 140)}…` : r._resumen}</small></td>
              </tr>
            );
          })}
          {!filas.length && !cargando && <tr><td colSpan={5} className="centro tenue" style={{ padding: 30 }}>Sin registros con esos filtros.</td></tr>}
        </tbody>
      </table></div></div>
      {hayMas && <div className="centro"><button className="btn" disabled={cargando} onClick={() => buscar(f, regs[regs.length - 1].id)}>Cargar más antiguos</button></div>}
      {detalle && <Detalle r={detalle} onCerrar={() => setDetalle(null)} />}
    </>
  );
}

export default function Bitacora() {
  return <div className="pagina"><div className="encabezado-pagina"><h1>Bitácora de auditoría</h1></div><ContenidoBitacora /></div>;
}
