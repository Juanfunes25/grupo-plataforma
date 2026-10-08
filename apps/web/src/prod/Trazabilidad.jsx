import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { get, qs } from '../api.js';
import { Estado, Modal, Tabs, useAviso, useDatos } from '../ui/kit.jsx';
import { hoyIso, kg, nf, textoDesviacion } from './util.js';
import EtiquetaTanda from './EtiquetaTanda.jsx';

const gKg = (g) => kg(Number(g) / 1000, 2);

/** Lector de QR con la cámara (BarcodeDetector). Si el equipo no lo trae, se escribe el código. */
function Escaner({ onCodigo, onCerrar }) {
  const video = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let vivo = true, flujo, t;
    (async () => {
      if (!('BarcodeDetector' in window)) { setError('Este equipo no puede leer códigos con la cámara: escribe el código del lote.'); return; }
      try {
        const det = new window.BarcodeDetector({ formats: ['qr_code', 'code_128'] });
        flujo = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        video.current.srcObject = flujo; await video.current.play();
        const leer = async () => { if (!vivo) return; try { const r = await det.detect(video.current); if (r[0]) { onCodigo(r[0].rawValue); return; } } catch { /* */ } t = setTimeout(leer, 300); };
        leer();
      } catch { setError('No se pudo abrir la cámara.'); }
    })();
    return () => { vivo = false; clearTimeout(t); flujo?.getTracks().forEach((x) => x.stop()); };
  }, [onCodigo]);
  return <Modal titulo="Escanear etiqueta" onCerrar={onCerrar}>{error ? <div className="aviso-caja">{error}</div> : <video ref={video} className="pg-visor-cam" playsInline muted />}</Modal>;
}

// El QR trae la dirección de la ficha; el código impreso es solo el lote. Se acepta cualquiera de los dos.
const loteDeTexto = (t) => { try { return new URL(t).searchParams.get('lote') ?? t; } catch { return t; } };

export default function Trazabilidad() {
  const [params] = useSearchParams();
  const [modo, setModo] = useState(params.get('lote') ? 'tanda' : 'tanda');
  return (
    <>
      <Tabs tabs={[['tanda', 'Buscar tanda'], ['lote', 'Lotes de materia prima'], ['tienda', 'Qué recibió una tienda']]} valor={modo} onCambio={setModo} />
      {modo === 'tanda' && <PorTanda inicial={params.get('lote') ?? ''} />}
      {modo === 'lote' && <PorLote />}
      {modo === 'tienda' && <PorTienda />}
    </>
  );
}

function PorTanda({ inicial }) {
  const avisar = useAviso();
  const [q, setQ] = useState(inicial);
  const [res, setRes] = useState([]);
  const [abierto, setAbierto] = useState(null);
  const [esc, setEsc] = useState(false);
  async function buscar(texto) {
    const t = loteDeTexto((texto ?? q).trim());
    if (t.length < 3) { avisar('Escribe al menos 3 caracteres', 'mal'); return; }
    try { const r = await get(`/prod/traza/buscar${qs({ q: t })}`); setRes(r); if (texto && r.length === 1) setAbierto({ tipo: 'tanda', id: r[0].id }); } catch (e) { avisar(e.message, 'mal'); }
  }
  useEffect(() => { if (inicial) buscar(inicial); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (abierto?.tipo === 'tanda') return <DetalleTanda id={abierto.id} onVolver={() => setAbierto(null)} onLote={(id) => setAbierto({ tipo: 'lote', id })} />;
  if (abierto?.tipo === 'lote') return <DetalleLote id={abierto.id} onVolver={() => setAbierto(null)} onTanda={(id) => setAbierto({ tipo: 'tanda', id })} />;
  return (
    <>
      <form className="tarjeta pg-ctl" onSubmit={(e) => { e.preventDefault(); buscar(); }}>
        <input type="search" placeholder="Código de lote o sabor" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className="btn" onClick={() => setEsc(true)}>Escanear</button><button className="btn primario" type="submit">Buscar</button>
      </form>
      {esc && <Escaner onCerrar={() => setEsc(false)} onCodigo={(c) => { setEsc(false); const l = loteDeTexto(c); setQ(l); buscar(l); }} />}
      {res.length > 0 && <div className="tarjeta"><b>{res.length} tanda{res.length === 1 ? '' : 's'}</b>{res.map((t) => (
        <div className="pg-fila" key={t.id}><div className="info"><b>{t.sabor_nombre}</b><span className="pg-sub">{t.lote} · {t.fecha} · {kg(t.kg)}{t.operario ? ` · ${t.operario}` : ''}</span></div><button className="btn chico" onClick={() => setAbierto({ tipo: 'tanda', id: t.id })}>Abrir</button></div>))}</div>}
    </>
  );
}

function DetalleTanda({ id, onVolver, onLote }) {
  const d = useDatos(() => get(`/prod/traza/tanda/${id}`), [id]);
  const [etq, setEtq] = useState(false);
  return (
    <>
      <button className="btn chico fantasma" onClick={onVolver}>← Volver</button>
      <Estado d={d}>{({ tanda, insumos, destinos, consumo_registrado: reg }) => (
        <>
          <div className="tarjeta"><h2 style={{ margin: 0 }}>{tanda.sabor_nombre}</h2><small className="pg-sub">Lote {tanda.lote} · producida el {tanda.fecha}{tanda.operario ? ` por ${tanda.operario}` : ''}</small>
            <div className="pg-chips"><span className="chip">{kg(tanda.kg)} producidos</span><span className="chip">{gKg(destinos.reduce((a, x) => a + x.gramos, 0))} despachados</span>{tanda.kg_restante > 0 && <span className="chip aviso">{kg(tanda.kg_restante)} en cámara</span>}</div>
            {tanda.notas && <div className="aviso-caja" style={{ marginTop: 8 }}>{tanda.notas}</div>}
            <button className="btn chico" style={{ marginTop: 8 }} onClick={() => setEtq(!etq)}>{etq ? 'Ocultar etiqueta' : 'Reimprimir etiqueta'}</button>
            {etq && <EtiquetaTanda tanda={tanda} onCerrar={() => setEtq(false)} />}</div>
          <div className="tarjeta"><b>Hecha con</b>
            {!reg ? <div className="aviso-caja" style={{ marginTop: 8 }}>Todavía no se confirmó la materia prima de esta tanda (pestaña «Materia prima»). Para rastrear un lote, búscalo en «Lotes de materia prima» y mira en qué días salió de bodega.</div> : insumos.map((i) => (
              <div className="pg-fila" key={i.insumo_id}><div className="info"><b>{i.nombre}</b><span className="pg-sub">{nf(i.real, 2)} {i.unidad}{i.sugerida !== null ? ` · receta: ${nf(i.sugerida, 2)} (${textoDesviacion(i.desviacion)})` : ''}</span>
                {i.lotes.length > 0 && <span className="pg-chips">{i.lotes.map((l) => <button key={l.lote_id} className="chip" onClick={() => onLote(l.lote_id)}>Lote …{String(l.lote_id).slice(-6)} · {nf(l.cantidad, 2)} ›</button>)}</span>}
                {i.sin_lote > 0 && <span className="pg-sub">{nf(i.sin_lote, 2)} sin lote de origen registrado</span>}</div>
                {i.desviacion_notable && <span className="chip mal">{textoDesviacion(i.desviacion)}</span>}</div>))}</div>
          <div className="tarjeta"><b>Fue a</b>{destinos.length === 0 ? <div className="vacio">Todavía no salió de fábrica.</div> : destinos.map((x) => (
            <div className="pg-fila" key={`${x.despacho_id}`}><div className="info"><b>{x.sucursal_nombre}</b><span className="pg-sub">{gKg(x.gramos)} el {x.fecha}{x.estado === 'recibido' ? ' · confirmado por la tienda' : ' · sin confirmar'}</span></div>{x.discrepancia && <span className="chip mal">discrepancia</span>}</div>))}</div>
        </>)}</Estado>
    </>
  );
}

function PorLote() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const lotes = useDatos(() => get(`/prod/traza/lotes${qs({ q })}`), [q]);
  const [tanda, setTanda] = useState(null);
  if (tanda) return <DetalleTanda id={tanda} onVolver={() => setTanda(null)} onLote={(id) => { setTanda(null); setSel(id); }} />;
  if (sel) return <DetalleLote id={sel} onVolver={() => setSel(null)} onTanda={setTanda} />;
  return (
    <>
      <div className="tarjeta"><input type="search" placeholder="Buscar insumo (ej.: pistacho)" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <Estado d={lotes}>{(l) => l.length === 0 ? <div className="vacio">Sin lotes de materia prima.</div> : (
        <div className="tarjeta">{l.map((x) => (
          <div className="pg-fila" key={x.id}><div className="info"><b>{x.insumo_nombre}</b><span className="pg-sub">llegó el {x.fecha_ingreso} · vence el {x.fecha_vencimiento} · quedan {nf(x.cantidad_restante, 2)} de {nf(x.cantidad_inicial, 2)} {x.unidad} · {x.tandas} tanda{x.tandas === 1 ? '' : 's'}</span></div><button className="btn chico" onClick={() => setSel(x.id)}>Rastrear</button></div>))}</div>
      )}</Estado>
    </>
  );
}

function DetalleLote({ id, onVolver, onTanda }) {
  const d = useDatos(() => get(`/prod/traza/lote/${id}`), [id]);
  return (
    <>
      <button className="btn chico fantasma" onClick={onVolver}>← Volver</button>
      <Estado d={d}>{({ lote, tandas, tiendas_afectadas: tiendas, salidas, tandas_de_esos_dias: dias }) => (
        <>
          <div className="tarjeta"><h2 style={{ margin: 0 }}>{lote.insumo_nombre}</h2><small className="pg-sub">Llegó el {lote.fecha_ingreso} · vence el {lote.fecha_vencimiento}</small>
            <div className="pg-chips"><span className="chip">{nf(lote.cantidad_inicial, 2)} {lote.unidad} entraron</span><span className="chip">{nf(lote.cantidad_restante, 2)} quedan</span></div></div>
          {/* Primero a propósito: si este lote salió malo, esto es la lista de a quién llamar. */}
          <div className="tarjeta"><b>Tiendas que lo recibieron</b>{tiendas.length === 0 ? <div className="vacio">Nada de este lote salió todavía hacia las tiendas.</div> : tiendas.map((t) => (
            <div className="pg-fila" key={t.sucursal_id}><div className="info"><b>{t.nombre}</b><span className="pg-sub">{gKg(t.gramos)} · {t.fechas.join(', ')}</span></div></div>))}</div>
          <div className="tarjeta"><b>Cuándo salió de bodega</b>{salidas.length === 0 ? <div className="vacio">Todavía no salió de bodega.</div> : salidas.map((s) => <div className="pg-fila" key={s.fecha}><span>{s.fecha}</span><b>{nf(s.cantidad, 2)} {lote.unidad}</b></div>)}</div>
          {dias.length > 0 && <div className="tarjeta"><b>Tandas producidas esos días</b><small className="pg-sub">No es seguro que todas hayan usado este lote: es la lista corta donde hay que mirar.</small>{dias.map((t) => (
            <div className="pg-fila" key={t.id}><div className="info"><b>{t.sabor_nombre}</b><span className="pg-sub">{t.lote} · {t.fecha} · {kg(t.kg)}{t.destinos?.length ? ` · fue a ${t.destinos.map((x) => x.sucursal_nombre).join(', ')}` : ''}</span></div><button className="btn chico" onClick={() => onTanda(t.id)}>Abrir</button></div>))}</div>}
          {tandas.length > 0 && <div className="tarjeta"><b>{tandas.length === 1 ? 'La tanda que lo usó' : `Las ${tandas.length} tandas que lo usaron`}</b>{tandas.map((t) => (
            <div className="pg-fila" key={t.id}><div className="info"><b>{t.sabor_nombre}</b><span className="pg-sub">{t.lote} · {t.fecha} · usó {nf(t.cantidad, 2)} de este lote</span></div><button className="btn chico" onClick={() => onTanda(t.id)}>Abrir</button></div>))}</div>}
        </>)}</Estado>
    </>
  );
}

function PorTienda() {
  const suc = useDatos(() => get('/prod/traza/sucursales'), []);
  const [s, setS] = useState('');
  const [fecha, setFecha] = useState(hoyIso());
  const id = s || suc.datos?.[0]?.id;
  const d = useDatos(() => (id ? get(`/prod/traza/sucursal/${id}/${fecha}`) : Promise.resolve(null)), [id, fecha]);
  return (
    <>
      <div className="tarjeta pg-ctl"><label>Tienda<select value={id ?? ''} onChange={(e) => setS(e.target.value)}>{(suc.datos ?? []).map((x) => <option key={x.id} value={x.id}>{x.nombre}</option>)}</select></label>
        <label>Día<input type="date" value={fecha} max={hoyIso()} onChange={(e) => e.target.value && setFecha(e.target.value)} /></label></div>
      <Estado d={d}>{(r) => r && (
        <div className="tarjeta"><b>Lo que recibió ese día</b>{r.recibido.length === 0 ? <div className="vacio">No hay tandas registradas para ese día: puede que no se despachó nada, o que el despacho es anterior a que se registrara de qué tanda salía cada envío.</div> : r.recibido.map((x, i) => (
          <div className="pg-fila" key={i}><div className="info"><b>{x.sabor_nombre}</b><span className="pg-sub">{gKg(x.gramos)} · tanda {x.lote} (producida el {x.fecha_produccion}{x.operario ? ` por ${x.operario}` : ''})</span>
            {x.lotes.length > 0 && <span className="pg-chips">{x.lotes.map((l) => <span key={l.lote_id} className="chip">{l.insumo_nombre} · lote …{String(l.lote_id).slice(-6)}</span>)}</span>}</div></div>))}</div>
      )}</Estado>
    </>
  );
}
