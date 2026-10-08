import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, patch, ErrorApi } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Modal, useAccion, useAviso, useDatos, Estado } from '../ui/kit.jsx';
import { del, hoyIso, horaDe, idCliente, kg as fkg } from './util.js';
import EtiquetaTanda from './EtiquetaTanda.jsx';

const CLAVE_OPERARIO = 'prod.operario';
const CLAVE_COLA = 'prod.cola';
const leer = (k, d) => { try { return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d; } catch { return d; } };
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* modo privado */ } };

/** Teclado numérico grande para capturar los kg con el dedo, con atajo de «+1 pana». */
function Teclado({ sabor, valor, onCambio, onListo, onCerrar }) {
  const [txt, setTxt] = useState(valor?.kg ? String(valor.kg) : '');
  const [panas, setPanas] = useState(valor?.panas ?? 0);
  const tocar = (d) => setTxt((t) => {
    if (d === '.') return t.includes('.') ? t : (t || '0') + '.';
    if ((t.split('.')[1] ?? '').length >= 2 || t.length >= 6) return t;
    return t === '0' ? d : t + d;
  });
  const pana = (sabor.gramos_pana || 3000) / 1000;
  const sumarPana = () => { setTxt((t) => String(Math.round(((Number(t) || 0) + pana) * 100) / 100)); setPanas((p) => p + 1); };
  const n = Number(txt) || 0;
  const confirmar = () => { onCambio(sabor.id, n > 0 ? { kg: n, panas: panas || undefined } : undefined); onListo(); };
  return (
    <Modal titulo={sabor.nombre} onCerrar={onCerrar} tam="angosto"
      pie={<><button className="btn" onClick={() => { setTxt(''); setPanas(0); }}>Borrar</button><button className="btn primario grande" onClick={confirmar}>Listo</button></>}>
      <div className="pg-visor">{txt || '0'} <small>kg</small></div>
      <div className="pg-atajos">
        <button className="btn" onClick={sumarPana}>+ 1 pana ({pana} kg)</button>
        <button className="btn" onClick={() => setTxt((t) => String(Math.round(((Number(t) || 0) + 1) * 100) / 100))}>+ 1 kg</button>
      </div>
      {panas > 0 && <small className="pg-sub" style={{ textAlign: 'center', marginBottom: 8 }}>{panas} pana{panas === 1 ? '' : 's'} sumada{panas === 1 ? '' : 's'}</small>}
      <div className="pg-pad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0'].map((d) => <button key={d} onClick={() => tocar(d)}>{d}</button>)}
        <button onClick={() => setTxt((t) => t.slice(0, -1))} aria-label="Borrar un dígito">⌫</button>
      </div>
    </Modal>
  );
}

/** Registro diario de producción: cuántos kg se hicieron de cada sabor, con lote automático para rastrear la tanda. */
export default function Captura({ alRegistrar }) {
  const { puede } = useSesion();
  const avisar = useAviso();
  const fecha = hoyIso();
  const sabores = useDatos(() => get('/prod/sabores'), []);
  const hoy = useDatos(() => get(`/prod/tandas?fecha=${fecha}`), [fecha]);
  const [valores, setValores] = useState({});
  const [operario, setOperario] = useState(() => leer(CLAVE_OPERARIO, ''));
  const [busca, setBusca] = useState('');
  const [faltan, setFaltan] = useState(false);
  const [abierto, setAbierto] = useState(null);
  const [cola, setCola] = useState(() => leer(CLAVE_COLA, []));
  const [ocupado, setOcupado] = useState(false);
  const [nuevo, setNuevo] = useState(null);
  const enVuelo = useRef(false);

  useEffect(() => guardar(CLAVE_OPERARIO, operario), [operario]);
  useEffect(() => guardar(CLAVE_COLA, cola), [cola]);

  // Lo guardado sin señal se envía solo cuando vuelve internet (cada ítem lleva su cliente_id: no se duplica).
  async function enviarCola() {
    if (enVuelo.current || !cola.length) return;
    enVuelo.current = true;
    try {
      const resto = [];
      for (const lote of cola) {
        try { await post('/prod/tandas/lote', lote); } catch (e) { if (e.status === 0) resto.push(lote); /* otro error: se descarta para no trabar la cola */ }
      }
      if (resto.length < cola.length) { avisar('Se enviaron las tandas guardadas sin señal'); hoy.recargar(); }
      setCola(resto);
    } finally { enVuelo.current = false; }
  }
  useEffect(() => { enviarCola(); window.addEventListener('online', enviarCola); return () => window.removeEventListener('online', enviarCola); }); // eslint-disable-line react-hooks/exhaustive-deps

  const kgYa = useMemo(() => { const m = new Map(); for (const e of hoy.datos ?? []) m.set(e.sabor_id, (m.get(e.sabor_id) || 0) + e.kg); return m; }, [hoy.datos]);
  const lista = useMemo(() => {
    const q = busca.trim().toUpperCase();
    return (sabores.datos ?? []).filter((s) => (!q || s.nombre.includes(q)) && (!faltan || (!valores[s.id] && !kgYa.get(s.id))));
  }, [sabores.datos, busca, faltan, valores, kgYa]);
  const items = Object.entries(valores).map(([sabor_id, v]) => ({ sabor_id, kg: v.kg, panas: v.panas, cliente_id: v.cliente_id }));
  const sinTocar = (sabores.datos ?? []).filter((s) => !valores[s.id] && !kgYa.get(s.id)).length;
  const totalHoy = (hoy.datos ?? []).reduce((a, e) => a + e.kg, 0);
  const faltaOperario = operario.trim() === '';

  const poner = (id, v) => setValores((x) => { const c = { ...x }; if (v) c[id] = { ...v, cliente_id: x[id]?.cliente_id ?? idCliente() }; else delete c[id]; return c; });

  // Si no hay red, la captura se guarda en el equipo (cola) y se envía sola al volver internet.
  async function registrarConCola() {
    if (!items.length || ocupado) return;
    if (faltaOperario) { avisar('Escribe quién está registrando', 'mal'); return; }
    const cuerpo = { fecha, operario: operario.trim(), items };
    setOcupado(true);
    try {
      const r = await post('/prod/tandas/lote', cuerpo);
      avisar(`${r.guardados} sabor${r.guardados === 1 ? '' : 'es'} registrado${r.guardados === 1 ? '' : 's'} (${items.reduce((a, i) => a + i.kg, 0)} kg)`);
      setValores({}); hoy.recargar(); alRegistrar?.();
    } catch (e) {
      if (e instanceof ErrorApi && e.status === 0) { setCola((c) => [...c, cuerpo]); setValores({}); avisar('Sin señal: la producción quedó guardada en este equipo y se envía sola al volver internet'); }
      else avisar(e.message, 'mal');
    } finally { setOcupado(false); }
  }

  async function crearSabor(nombre, forzar = false) {
    try { await post('/rep/sabores', { nombre, forzar }); setNuevo(null); sabores.recargar(); avisar('Sabor agregado. Actívalo por sucursal desde Reposición.'); }
    catch (e) {
      if (!forzar && ['sabor_parecido', 'nombre_con_peso'].includes(e.codigo) && window.confirm(`${e.message}\n\n¿Crearlo de todos modos?`)) return crearSabor(nombre, true);
      avisar(e.message, 'mal');
    }
  }

  return (
    <>
      {cola.length > 0 && <div className="aviso-caja">{cola.length} registro{cola.length === 1 ? '' : 's'} guardado{cola.length === 1 ? '' : 's'} sin señal: se envía{cola.length === 1 ? '' : 'n'} solo{cola.length === 1 ? '' : 's'} cuando vuelva el internet. <button className="btn chico" onClick={enviarCola}>Reintentar</button></div>}
      <div className="tarjeta pg-ctl">
        <label>Quién registra<input className={faltaOperario ? 'pg-req' : ''} placeholder="Tu nombre" value={operario} onChange={(e) => setOperario(e.target.value)} /></label>
        <label>Buscar sabor<input type="search" placeholder="Buscar sabor…" value={busca} onChange={(e) => setBusca(e.target.value)} /></label>
        <button className={`btn ${faltan ? 'primario' : ''}`} onClick={() => setFaltan((v) => !v)}>{faltan ? 'Solo los que faltan' : `Solo los que faltan (${sinTocar})`}</button>
        {items.length > 0 && <button className="btn fantasma" onClick={() => setValores({})}>Limpiar lo escrito</button>}
      </div>
      {totalHoy > 0 && <div className="aviso-caja ok">{fkg(totalHoy, 1)} registrados hoy en {hoy.datos.length} tanda{hoy.datos.length === 1 ? '' : 's'}. Puedes seguir agregando.</div>}
      <Estado d={sabores}>{() => (
        lista.length === 0 ? <div className="vacio">Sin resultados</div> : (
          <div className="pg-grid">
            {lista.map((s) => {
              const v = valores[s.id], ya = kgYa.get(s.id);
              return (
                <button key={s.id} className={`pg-celda ${v ? 'on' : ya ? 'ya' : ''}`} onClick={() => setAbierto(s)}>
                  <b>{s.nombre}</b>
                  <span className="kg">{v ? `${v.kg} kg` : '—'}</span>
                  <small className="tenue">{ya ? `ya ${ya} kg hoy` : `pana ${s.gramos_pana / 1000} kg`}{v?.panas ? ` · ${v.panas} pana${v.panas === 1 ? '' : 's'}` : ''}</small>
                </button>
              );
            })}
          </div>
        )
      )}</Estado>
      {puede('rep:producir') && (nuevo === null
        ? <button className="btn bloque fantasma" onClick={() => setNuevo('')}>+ Agregar sabor nuevo al catálogo</button>
        : (
          <form className="tarjeta" onSubmit={(e) => { e.preventDefault(); if (nuevo.trim()) crearSabor(nuevo.trim()); }}>
            <label>Nombre del sabor nuevo<input value={nuevo} onChange={(e) => setNuevo(e.target.value)} placeholder="Ej.: TIRAMISU" autoFocus /></label>
            <small className="pg-sub">Después hay que activarlo por sucursal: recién creado no lo pesa nadie.</small>
            <div className="pg-ctl" style={{ marginTop: 8 }}><button className="btn primario" type="submit">Agregar</button><button type="button" className="btn" onClick={() => setNuevo(null)}>Cancelar</button></div>
          </form>
        ))}
      {abierto && <Teclado sabor={abierto} valor={valores[abierto.id]} onCambio={poner} onListo={() => setAbierto(null)} onCerrar={() => setAbierto(null)} />}
      {items.length > 0 && (
        <div className="pg-barra"><div>
          <button className="btn primario grande bloque" disabled={ocupado || faltaOperario} onClick={registrarConCola}>
            {faltaOperario ? 'Escribe quién registra' : `Registrar producción (${items.length}) · ${items.reduce((a, i) => a + i.kg, 0)} kg`}
          </button>
        </div></div>
      )}
    </>
  );
}

/** Lo producido hoy: corregir los kg, borrar una tanda cargada por error y sacar la etiqueta. */
export function TandasDeHoy({ recargarClave }) {
  const fecha = hoyIso();
  const hoy = useDatos(() => get(`/prod/tandas?fecha=${fecha}`), [fecha, recargarClave]);
  const [editando, setEditando] = useState(null);
  const [kgEd, setKgEd] = useState('');
  const [etq, setEtq] = useState(null);
  const [ejecutar] = useAccion();
  const guardarKg = async (id) => { if (await ejecutar(() => patch(`/prod/tandas/${id}`, { kg: Number(kgEd) }), 'Corregido')) { setEditando(null); hoy.recargar(); } };
  const borrar = async (e) => { if (window.confirm(`¿Borrar la tanda ${e.lote}? No se puede deshacer.`) && await ejecutar(() => del(`/prod/tandas/${e.id}`), 'Borrado')) hoy.recargar(); };
  return (
    <Estado d={hoy}>{(lista) => lista.length === 0 ? <div className="vacio">Todavía no se cargó ninguna tanda hoy.</div> : (
      <div className="tarjeta">
        <b>Producción de hoy · {lista.length} tanda{lista.length === 1 ? '' : 's'}</b>
        {lista.map((e) => (
          <div className="pg-fila" key={e.id} style={{ display: 'block' }}>
            <div className="pg-fila" style={{ border: 0, padding: 0 }}>
              <div className="info"><b>{e.sabor_nombre}</b><span className="pg-sub">lote {e.lote} · {horaDe(e.creado_en)}{e.operario ? ` · ${e.operario}` : ''}{e.despachada ? ' · ya salió en un despacho' : ''}</span></div>
              {editando !== e.id && <button className="btn" disabled={e.despachada} title={e.despachada ? 'Ya salió: no se corrige' : 'Corregir los kg'} onClick={() => { setEditando(e.id); setKgEd(String(e.kg)); }}>{e.kg} kg</button>}
            </div>
            {editando === e.id ? (
              <div className="pg-ctl" style={{ marginTop: 8 }}>
                <input type="number" inputMode="decimal" min="0" step="0.1" autoFocus value={kgEd} onChange={(ev) => setKgEd(ev.target.value)} onKeyDown={(ev) => ev.key === 'Enter' && guardarKg(e.id)} />
                <button className="btn primario" onClick={() => guardarKg(e.id)}>Guardar</button><button className="btn" onClick={() => setEditando(null)}>Cancelar</button>
              </div>
            ) : (
              <div className="pg-chips">
                <button className="btn chico" onClick={() => setEtq(etq === e.id ? null : e.id)}>Etiqueta</button>
                {!e.despachada && <button className="btn chico peligro" onClick={() => borrar(e)}>Borrar</button>}
              </div>
            )}
            {etq === e.id && <EtiquetaTanda tanda={{ ...e, fecha }} onCerrar={() => setEtq(null)} />}
          </div>
        ))}
      </div>
    )}</Estado>
  );
}
