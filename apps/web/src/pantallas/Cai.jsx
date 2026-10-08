import { useState } from 'react';
import { fechaHN, numero } from '@grupo/shared';
import { get, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { colorDe, nombreCorto } from '../ui/sucursales.js';

const CAI_VALIDO = /^[0-9A-F]{6}(-[0-9A-F]{6}){4}-[0-9A-F]{2}$/;
// Acepta el CAI pegado con o sin guiones o espacios (mismo criterio que el servidor).
export function normalizarCai(v) {
  const t = String(v ?? '').toUpperCase().replace(/[\s-]/g, '');
  return /^[0-9A-F]{32}$/.test(t) ? t.match(/.{1,6}/g).join('-') : String(v ?? '').trim().toUpperCase();
}
const nroFactura = (f, c) => `${f.punto_emision_codigo}-${f.punto_venta_codigo}-${f.tipo_documento_codigo}-${String(c || 0).padStart(8, '0')}`;

/** Revisión en vivo del formulario: el botón dice exactamente qué falta en vez de fallar al guardar. */
function problemas(f) {
  const p = [];
  if (!CAI_VALIDO.test(normalizarCai(f.cai))) p.push('CAI: 32 caracteres, formato XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX');
  if (!/^\d{3}$/.test(f.punto_emision_codigo)) p.push('Establecimiento: 3 dígitos');
  if (!/^\d{3}$/.test(f.punto_venta_codigo)) p.push('Punto de emisión: 3 dígitos');
  if (!/^\d{2}$/.test(f.tipo_documento_codigo)) p.push('Tipo de documento: 2 dígitos');
  const d = Number(f.correlativo_desde), h = Number(f.correlativo_hasta), a = Number(f.correlativo_actual);
  if (!Number.isInteger(d) || d < 1) p.push('Rango desde: número mayor que 0');
  if (!Number.isInteger(h) || h < d) p.push('Rango hasta: mayor o igual que «desde»');
  if (!Number.isInteger(a) || a < d || a > h) p.push('Próxima factura: dentro del rango');
  if (!f.fecha_limite_emision) p.push('Fecha límite de emisión'); else if (f.fecha_limite_emision < fechaHN()) p.push('La fecha límite de emisión ya pasó');
  return p;
}

function FichaCai({ p, modo, onCerrar, onGuardado }) {
  const activar = modo === 'activar';
  const [f, setF] = useState({
    cai: activar ? '' : p.cai ?? '', punto_emision_codigo: p.punto_emision_codigo ?? '', punto_venta_codigo: p.punto_venta_codigo ?? '', tipo_documento_codigo: p.tipo_documento_codigo ?? '01',
    correlativo_desde: activar ? '' : String(p.correlativo_desde), correlativo_hasta: activar ? '' : String(p.correlativo_hasta), correlativo_actual: activar ? '' : String(p.correlativo_actual),
    fecha_limite_emision: activar ? '' : p.fecha_limite_emision ?? '',
  });
  const [ejecutar, ocupado] = useAccion();
  const cambiar = (k) => (e) => {
    const v = e.target.value;
    // Al activar, la primera factura real es el inicio del rango autorizado.
    setF((x) => ({ ...x, [k]: v, ...(activar && k === 'correlativo_desde' && (x.correlativo_actual === '' || x.correlativo_actual === x.correlativo_desde) ? { correlativo_actual: v } : {}) }));
  };
  const faltan = problemas(f);
  const guardar = async () => {
    const c = { ...f, cai: normalizarCai(f.cai), correlativo_desde: Number(f.correlativo_desde), correlativo_hasta: Number(f.correlativo_hasta), correlativo_actual: Number(f.correlativo_actual), es_borrador: false };
    const ok = window.confirm(activar
      ? [`ACTIVAR CAI REAL — ${p.sucursal}`, '', `CAI: ${c.cai}`, `Rango: ${nroFactura(f, c.correlativo_desde)} a ${nroFactura(f, c.correlativo_hasta)}`, `Primera factura: ${nroFactura(f, c.correlativo_actual)}`,
        `Fecha límite: ${f.fecha_limite_emision}`, '', 'Desde este momento las facturas de esta sucursal tienen validez fiscal ante el SAR.', '¿Los datos coinciden exactamente con la resolución?'].join('\n')
      : 'Vas a modificar datos fiscales del CAI. Queda registrado en la bitácora. ¿Continuar?');
    if (!ok) return;
    if (await ejecutar(() => put(`/pos/puntos-emision/${p.id}`, c), activar ? 'CAI real activado' : 'Cambios guardados')) onGuardado();
  };
  return (
    <Modal titulo={`${activar ? 'Activar CAI real' : 'Editar CAI'} · ${p.sucursal}`} onCerrar={onCerrar}
      pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={faltan.length > 0 || ocupado} onClick={guardar}>{ocupado ? 'Guardando…' : activar ? 'Activar CAI real' : 'Guardar cambios'}</button></>}>
      {activar && <div className="aviso-caja">Copia los datos tal cual aparecen en la resolución del SAR. Al activarlo, las facturas de esta sucursal dejan de ser borrador.</div>}
      <Campo etiqueta="CAI (32 caracteres; puedes pegarlo con o sin guiones)"><input className="num" value={f.cai} onChange={cambiar('cai')} onBlur={(e) => setF((x) => ({ ...x, cai: normalizarCai(e.target.value) }))} placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XX" autoCapitalize="characters" autoFocus /></Campo>
      <div className="rejilla cols-3">
        <Campo etiqueta="Establecimiento"><input value={f.punto_emision_codigo} onChange={cambiar('punto_emision_codigo')} maxLength={3} inputMode="numeric" /></Campo>
        <Campo etiqueta="Punto de emisión"><input value={f.punto_venta_codigo} onChange={cambiar('punto_venta_codigo')} maxLength={3} inputMode="numeric" /></Campo>
        <Campo etiqueta="Tipo de documento"><input value={f.tipo_documento_codigo} onChange={cambiar('tipo_documento_codigo')} maxLength={2} inputMode="numeric" /></Campo>
      </div>
      <div className="rejilla cols-3">
        <Campo etiqueta="Rango desde"><input type="number" min="1" value={f.correlativo_desde} onChange={cambiar('correlativo_desde')} /></Campo>
        <Campo etiqueta="Rango hasta"><input type="number" min="1" value={f.correlativo_hasta} onChange={cambiar('correlativo_hasta')} /></Campo>
        <Campo etiqueta="Próxima factura" ayuda={activar ? undefined : 'No puede retroceder en un CAI en uso'}><input type="number" min="1" value={f.correlativo_actual} onChange={cambiar('correlativo_actual')} /></Campo>
      </div>
      <Campo etiqueta="Fecha límite de emisión"><input type="date" value={f.fecha_limite_emision} onChange={cambiar('fecha_limite_emision')} /></Campo>
      {faltan.length === 0
        ? <div className="aviso-caja ok">Rango: <b className="num">{nroFactura(f, f.correlativo_desde)}</b> a <b className="num">{nroFactura(f, f.correlativo_hasta)}</b><br />Primera factura: <b className="num">{nroFactura(f, f.correlativo_actual)}</b></div>
        : <div className="aviso-caja"><b>Falta revisar:</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{faltan.map((x) => <li key={x}>{x}</li>)}</ul></div>}
    </Modal>
  );
}

function Alerta({ p }) {
  if (p.es_borrador || !p.alerta) return null;
  return (
    <div className="aviso-caja mal">
      {p.agotado && 'El rango de correlativos está agotado. '}
      {p.vencido && 'La fecha límite de emisión ya venció. '}
      {!p.agotado && !p.vencido && `Atención: quedan ${p.dias_restantes ?? '?'} días o ${Math.round((100 - p.porcentaje_usado) * 10) / 10} % del rango. `}
      Solicita un CAI nuevo al SAR antes de que se acabe.
    </div>
  );
}

export function ContenidoCai() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar] = useAccion();
  const d = useDatos(() => get('/pos/puntos-emision'), []);
  const [ficha, setFicha] = useState(null);   // { p, modo }
  const editar = puede('pos:fiscal');

  const volverBorrador = async (p) => {
    if (!window.confirm(`¿Volver ${p.sucursal} a MODO BORRADOR?\n\nLas facturas nuevas saldrán como «BORRADOR-…» sin validez fiscal. Úsalo solo si activaste el CAI por error.`)) return;
    if (await ejecutar(() => put(`/pos/puntos-emision/${p.id}`, { es_borrador: true }), 'Punto de emisión en modo borrador')) d.recargar();
  };

  return (
    <>
      <div className="aviso-caja">Mientras una sucursal esté en <b>modo borrador</b>, sus facturas salen numeradas como «BORRADOR-…» y sin validez fiscal. Cuando el contador te entregue la resolución del SAR, usa <b>Activar CAI real</b> y copia los datos tal cual. Con facturas ya emitidas el correlativo no puede retroceder.</div>
      <Estado d={d}>{(l) => (
        <div className="rejilla cols-2">{l.map((p) => (
          <div key={p.id} className="tarjeta" style={{ display: 'grid', gap: 10, borderLeft: `4px solid ${colorDe({ id: p.sucursal_id, color: p.sucursal_color })}` }}>
            <div className="fila espacio"><h3>{nombreCorto(p.sucursal)}</h3>
              {p.es_borrador ? <span className="chip aviso">Modo borrador</span> : p.alerta ? <span className="chip mal">CAI por vencer o agotarse</span> : <span className="chip ok">CAI real activo</span>}</div>
            <Alerta p={p} />
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', margin: 0, fontSize: '.9rem' }}>
              <dt className="tenue">CAI</dt><dd className="num" style={{ margin: 0, wordBreak: 'break-all' }}>{p.es_borrador ? 'de prueba (sin CAI)' : p.cai}</dd>
              <dt className="tenue">Próxima factura</dt><dd className="num" style={{ margin: 0 }}>{p.es_borrador && 'BORRADOR-'}{nroFactura(p, p.correlativo_actual)}</dd>
              {!p.es_borrador && <>
                <dt className="tenue">Rango autorizado</dt><dd style={{ margin: 0 }}>{numero(p.correlativo_desde)} – {numero(p.correlativo_hasta)} ({p.porcentaje_usado} % usado)</dd>
                <dt className="tenue">Fecha límite</dt><dd style={{ margin: 0 }}>{p.fecha_limite_emision ?? 'sin definir'}{p.dias_restantes !== null && ` (${p.dias_restantes < 0 ? `venció hace ${-p.dias_restantes} días` : `${p.dias_restantes} días`})`}</dd>
              </>}
            </dl>
            {!p.es_borrador && <div className="cal-progreso" style={{ height: 6, borderRadius: 999, background: 'var(--panel-3)', overflow: 'hidden' }}><div style={{ width: `${p.porcentaje_usado}%`, height: '100%', background: p.porcentaje_usado >= 90 ? 'var(--peligro)' : 'var(--ok)' }} /></div>}
            {editar && <div className="fila">
              {p.es_borrador
                ? <button className="btn primario" onClick={() => setFicha({ p, modo: 'activar' })}>Activar CAI real</button>
                : <><button className="btn" onClick={() => setFicha({ p, modo: 'editar' })}>Editar</button><button className="btn fantasma" onClick={() => volverBorrador(p)}>Volver a borrador</button></>}
            </div>}
          </div>))}
        </div>
      )}</Estado>
      {ficha && <FichaCai p={ficha.p} modo={ficha.modo} onCerrar={() => setFicha(null)} onGuardado={() => { setFicha(null); d.recargar(); avisar('Queda registrado en la bitácora'); }} />}
    </>
  );
}

export default function Cai() {
  return <div className="pagina"><div className="encabezado-pagina"><h1>CAI / Puntos de emisión</h1></div><ContenidoCai /></div>;
}
