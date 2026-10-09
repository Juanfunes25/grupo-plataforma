import { lazy, Suspense, useState } from 'react';
import { numero } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Modal, Tabs, useAccion, useAviso, useConfirmar, useDatos } from '../ui/kit.jsx';
// Carga perezosa: Cai.jsx también importa este asistente (evita una importación circular).
const ContenidoCai = lazy(() => import('../pantallas/Cai.jsx').then((m) => ({ default: m.ContenidoCai })));
import '../seguridad/seguridad.css';

const soloDigitos = (v) => String(v ?? '').replace(/\D/g, '');
/** 0801-1999-123456 */
export const formatoRtn = (v) => { const d = soloDigitos(v); return d.length === 14 ? `${d.slice(0, 4)}-${d.slice(4, 8)}-${d.slice(8)}` : (v ?? ''); };

export function BannerModo({ a, onCambiar, puedeCambiar }) {
  const cls = a.en_preparacion ? 'preparacion' : a.modo;
  return (
    <div className={`modo-banner ${cls}`} role="status">
      <div>
        {a.modo === 'real' && <>MODO REAL · las facturas tienen valor fiscal<small>En vivo desde {a.en_vivo_desde ? String(a.en_vivo_desde).slice(0, 10) : '—'}. Sobre L {numero(a.umbral_rtn)} se exige el RTN del cliente.</small></>}
        {a.modo === 'prueba' && !a.en_preparacion && <>MODO PRUEBA · «BORRADOR – SIN VALOR FISCAL»<small>Las facturas salen como borrador y no hace falta RTN sobre L {numero(a.umbral_rtn)}. Se pasa a modo real cuando la lista de abajo esté completa.</small></>}
        {a.en_preparacion && <>EN PREPARACIÓN · {a.sucursales_con_cai_real} de {a.sucursales_que_facturan} sucursales ya emiten con CAI real<small>Esas sucursales ya facturan con valor fiscal aunque la empresa siga en modo prueba. Completa la lista y pasa a modo real, o regresa a prueba.</small></>}
      </div>
      {puedeCambiar && <button className={`btn ${a.modo === 'prueba' ? 'primario' : ''}`} onClick={onCambiar}>{a.modo === 'prueba' ? 'Pasar a modo REAL…' : 'Volver a modo prueba…'}</button>}
    </div>
  );
}

function CambiarModo({ a, onCerrar, onHecho }) {
  const [frase, setFrase] = useState('');
  const [ejecutar, ocupado] = useAccion();
  const aReal = a.modo === 'prueba';
  const esperada = aReal ? 'MODO REAL' : 'MODO PRUEBA';
  return (
    <Modal titulo={aReal ? 'Pasar a modo REAL' : 'Volver a modo PRUEBA'} tam="angosto" onCerrar={onCerrar}
      pie={<button className="btn primario" disabled={ocupado || frase.trim().toUpperCase() !== esperada || (aReal && !a.listo_para_real)}
        onClick={async () => { if (await ejecutar(() => post('/fiscal/modo', { modo: aReal ? 'real' : 'prueba', confirmar: true }), aReal ? 'La empresa está en modo REAL' : 'La empresa volvió a modo prueba')) onHecho(); }}>{aReal ? 'Pasar a modo real' : 'Volver a prueba'}</button>}>
      {aReal
        ? <div className="aviso-caja">Desde este momento las facturas tienen <b>valor fiscal ante el SAR</b> y se exige el RTN del cliente en ventas sobre L {numero(a.umbral_rtn)}. {!a.listo_para_real && <b>Todavía falta completar la lista de verificación.</b>}</div>
        : <div className="aviso-caja mal">Todas las sucursales vuelven a <b>borrador</b>: las facturas nuevas saldrán «BORRADOR – SIN VALOR FISCAL» y gastarán números del rango del CAI. Úsalo solo si activaste el modo real por error.</div>}
      <Campo etiqueta={`Para confirmar escribe: ${esperada}`}><input value={frase} onChange={(e) => setFrase(e.target.value)} autoComplete="off" autoFocus /></Campo>
    </Modal>
  );
}

const ICONO = { ok: '✓', falta: '!', aviso: '!', manual: '?' };
const PESTANA = { datos: 'datos', cai: 'cai', usuarios: null, resumen: 'resumen' };

function Resumen({ a, ir, recargar }) {
  const [ejecutar] = useAccion();
  const confirmar = async (c, v) => { if (await ejecutar(() => post('/fiscal/confirmaciones', { id: c.id, confirmado: v }), v ? 'Confirmado' : 'Desmarcado')) recargar(); };
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
      <div className="fila espacio"><h2>Lo que falta para facturar en vivo</h2>
        <span className={`chip ${a.listo_para_real ? 'ok' : 'aviso'}`}>{a.listo_para_real ? 'Todo listo' : `${a.faltan + a.por_confirmar} pendiente(s)`}</span></div>
      <ul className="lista-verif">{a.verificacion.map((i) => (
        <li key={i.id}>
          <span className={`punto ${i.estado}`} aria-label={i.estado}>{ICONO[i.estado]}</span>
          <div><b>{i.titulo}</b><br /><small>{i.detalle}</small>
            {i.id === 'impresora' && i.confirmar?.length > 0 && <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>{i.confirmar.map((c) => (
              <label key={c.id} className="casilla"><input type="checkbox" onChange={(e) => confirmar(c, e.target.checked)} /> {c.sucursal}: ya imprimí una prueba y sale bien</label>))}</div>}
            {i.id === 'impresora' && i.estado === 'ok' && <div style={{ marginTop: 6 }}><button className="btn chico fantasma" onClick={async () => { for (const s of a.sucursales.filter((x) => x.factura)) await post('/fiscal/confirmaciones', { id: `impresora_${s.id}`, confirmado: false }); recargar(); }}>Desmarcar</button></div>}
          </div>
          {(PESTANA[i.pestana] ?? null) && i.estado !== 'ok' && <button className="btn chico" onClick={() => ir(PESTANA[i.pestana])}>Resolver</button>}
        </li>))}</ul>
      {a.alertas.length > 0 && <div className="aviso-caja mal"><b>CAI por vencer o agotarse</b><ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{a.alertas.map((x) => <li key={x.clave}>{x.mensaje}</li>)}</ul></div>}
    </div>
  );
}

function FormEmpresa({ a, recargar }) {
  const [f, setF] = useState({ razon_social: a.empresa.razon_social ?? '', nombre: a.empresa.nombre ?? '', rtn: formatoRtn(a.empresa.rtn), direccion: a.empresa.direccion ?? '', ciudad: a.empresa.ciudad ?? '', telefono: a.empresa.telefono ?? '', correo: a.empresa.correo ?? '', web: a.empresa.web ?? '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const rtnMal = f.rtn && soloDigitos(f.rtn).length !== 14;
  return (
    <form className="tarjeta" style={{ display: 'grid', gap: 12 }} onSubmit={async (e) => { e.preventDefault(); if (await ejecutar(() => put('/fiscal/empresa', f), 'Datos fiscales guardados')) recargar(); }}>
      <h2>Datos de la empresa (salen en la factura)</h2>
      <div className="rejilla cols-2">
        <Campo etiqueta="Razón social" requerido><input value={f.razon_social} onChange={set('razon_social')} required /></Campo>
        <Campo etiqueta="Nombre comercial" ayuda="Es el nombre que se ve en pantallas y tickets."><input value={f.nombre} onChange={set('nombre')} required /></Campo>
        <Campo etiqueta="RTN (14 dígitos)" error={rtnMal ? 'El RTN lleva 14 dígitos.' : null}><input className="num" inputMode="numeric" value={f.rtn} onChange={set('rtn')} placeholder="0801-1999-123456" /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono} onChange={set('telefono')} inputMode="tel" /></Campo>
        <Campo etiqueta="Dirección" requerido><input value={f.direccion} onChange={set('direccion')} /></Campo>
        <Campo etiqueta="Ciudad"><input value={f.ciudad} onChange={set('ciudad')} /></Campo>
        <Campo etiqueta="Correo"><input type="email" value={f.correo} onChange={set('correo')} /></Campo>
        <Campo etiqueta="Sitio web"><input value={f.web} onChange={set('web')} /></Campo>
      </div>
      <div><button className="btn primario" disabled={ocupado || rtnMal}>Guardar datos de la empresa</button></div>
    </form>
  );
}

function FilaSucursal({ s, recargar }) {
  const [f, setF] = useState({ nombre: s.nombre, direccion: s.direccion ?? '', telefono: s.telefono ?? '', correo: s.correo ?? '' });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const cambio = f.nombre !== s.nombre || f.direccion !== (s.direccion ?? '') || f.telefono !== (s.telefono ?? '') || f.correo !== (s.correo ?? '');
  return (
    <div className="sesion-fila" style={{ alignItems: 'flex-end' }}>
      <div className="rejilla cols-2" style={{ flex: 1, minWidth: 260 }}>
        <Campo etiqueta="Sucursal"><input value={f.nombre} onChange={set('nombre')} /></Campo>
        <Campo etiqueta="Dirección (si es distinta)"><input value={f.direccion} onChange={set('direccion')} /></Campo>
        <Campo etiqueta="Teléfono"><input value={f.telefono} onChange={set('telefono')} inputMode="tel" /></Campo>
        <Campo etiqueta="Correo"><input type="email" value={f.correo} onChange={set('correo')} /></Campo>
      </div>
      <button className="btn" disabled={!cambio || ocupado} onClick={async () => { if (await ejecutar(() => put(`/fiscal/sucursales/${s.id}`, f), 'Sucursal guardada')) recargar(); }}>Guardar</button>
    </div>
  );
}

/** Asistente fiscal completo: banner de modo, lista de verificación, datos y CAI. */
export default function ContenidoFiscal({ inicial = 'resumen' }) {
  const { puede, recargar: recargarSesion } = useSesion();
  const d = useDatos(() => get('/fiscal/asistente'), []);
  const [tab, setTab] = useState(inicial);
  const [cambiando, setCambiando] = useState(false);
  const avisar = useAviso();
  useConfirmar();
  return (
    <Estado d={d}>{(a) => (
      <div style={{ display: 'grid', gap: 14 }}>
        <BannerModo a={a} puedeCambiar={puede('pos:fiscal')} onCambiar={() => setCambiando(true)} />
        <Tabs estilo="pildora" tabs={[['resumen', 'Lista de verificación'], ['datos', 'Datos de empresa y sucursales'], ['cai', 'CAI y puntos de emisión']]} valor={tab} onCambio={setTab} />
        {tab === 'resumen' && <Resumen a={a} ir={setTab} recargar={d.recargar} />}
        {tab === 'datos' && <><FormEmpresa a={a} recargar={() => { d.recargar(); recargarSesion?.(); }} />
          <div className="tarjeta"><h2>Sucursales</h2>{a.sucursales.map((s) => <FilaSucursal key={s.id} s={s} recargar={d.recargar} />)}</div></>}
        {tab === 'cai' && <Suspense fallback={<small>Cargando…</small>}><ContenidoCai /></Suspense>}
        {cambiando && <CambiarModo a={a} onCerrar={() => setCambiando(false)} onHecho={() => { setCambiando(false); d.recargar(); avisar('Queda registrado en la bitácora'); }} />}
      </div>
    )}</Estado>
  );
}
