import { useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { rget, rpatch, rpost, qs } from './api.js';
import { Chip, cuando } from './comun.jsx';
import { reducirFoto } from './foto.js';

const TIPOS = [['producto', '🍨', 'El producto'], ['equipo', '🔧', 'Un equipo'], ['temperatura', '🌡️', 'Temperatura'], ['higiene', '🧼', 'Limpieza'], ['otro', '📝', 'Otra cosa']];
const GRAVEDADES = [['baja', 'Anotarlo nomás'], ['media', 'Hay que revisarlo'], ['alta', 'Urgente']];
const ICONO = Object.fromEntries(TIPOS.map(([id, i]) => [id, i]));
const TONO = { alta: 'mal', media: 'aviso', baja: '' };
const ESTADO = { abierta: 'Abierta', en_revision: 'En revisión', cerrada: 'Cerrada' };
const MAX_FOTOS = 3;
const clave = (u) => `rinv.quien.${u}`;

/**
 * Reportar algo que salió mal, en el momento en que se ve. Pensado para quien está frente a la vitrina con una mano ocupada:
 * elegir qué pasó y qué tan grave es son toques; lo único que se escribe es la descripción. La foto es opcional pero es lo
 * que más sirve después, y se reduce en el celular antes de subirla.
 */
export function Reportar({ onListo, onCancelar }) {
  const { sucursales, sucursalId, usuario } = useSesion();
  const avisar = useAviso();
  const [tipo, setTipo] = useState('producto'); const [gravedad, setGravedad] = useState('media'); const [desc, setDesc] = useState('');
  const [quien, setQuien] = useState(() => { try { return localStorage.getItem(clave(usuario?.id)) || usuario?.nombre || ''; } catch { return usuario?.nombre || ''; } });
  const [suc, setSuc] = useState(sucursalId || ''); const [fotos, setFotos] = useState([]);
  const [ejecutar, ocupado] = useAccion();
  async function agregar(e) {
    const archivos = [...e.target.files].slice(0, MAX_FOTOS - fotos.length); e.target.value = '';
    try { const nuevas = await Promise.all(archivos.map((a) => reducirFoto(a))); setFotos((f) => [...f, ...nuevas]); } catch (x) { avisar(x.message, 'mal'); }
  }
  async function enviar() {
    if (desc.trim().length < 5) return avisar('Cuenta un poco más de qué pasó', 'mal');
    try { localStorage.setItem(clave(usuario?.id), quien.trim()); } catch { /* sin almacenamiento */ }
    const r = await ejecutar(() => rpost('/incidencias', { tipo, gravedad, descripcion: desc.trim(), reportado_por: quien.trim(), sucursal_id: suc || null, fotos }), '✓ Reportado');
    if (r) onListo?.();
  }
  return (
    <div className="tarjeta rejilla">
      <h2>¿Qué pasó?</h2>
      <div className="rv-pills">{TIPOS.map(([id, i, n]) => <button key={id} className={`btn ${tipo === id ? 'primario' : ''}`} onClick={() => setTipo(id)}>{i} {n}</button>)}</div>
      <div className="rv-pills">{GRAVEDADES.map(([id, n]) => <button key={id} className={`btn ${gravedad === id ? (id === 'alta' ? 'peligro' : 'primario') : ''}`} onClick={() => setGravedad(id)}>{n}</button>)}</div>
      <Campo etiqueta="Dónde pasó"><select value={suc} onChange={(e) => setSuc(e.target.value)}><option value="">Fábrica</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
      <textarea rows={4} placeholder="Cuenta qué pasó: qué viste, cuándo, con qué producto…" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <Campo etiqueta="Quién reporta"><input value={quien} onChange={(e) => setQuien(e.target.value)} placeholder="Tu nombre" /></Campo>
      {fotos.length > 0 && <div className="rv-fotos">{fotos.map((f, i) => <div className="rv-foto" key={i}><img src={`data:image/jpeg;base64,${f}`} alt={`Foto ${i + 1}`} /><button className="btn chico" aria-label="Quitar foto" onClick={() => setFotos((l) => l.filter((_, j) => j !== i))}>✕</button></div>)}</div>}
      {fotos.length < MAX_FOTOS && <label className="btn">📷 Agregar foto<input type="file" accept="image/*" capture="environment" multiple hidden onChange={agregar} /></label>}
      <div className="fila"><button className="btn primario grande" disabled={ocupado} onClick={enviar}>Reportar</button>{onCancelar && <button className="btn" onClick={onCancelar}>Cancelar</button>}</div>
    </div>
  );
}

function Detalle({ id, onVolver, onCambio }) {
  const { usuario } = useSesion();
  const avisar = useAviso();
  const d = useDatos(() => rget(`/incidencias/${id}`), [id]);
  const [res, setRes] = useState(null); const [quien, setQuien] = useState(usuario?.nombre || '');
  const [ejecutar, ocupado] = useAccion();
  const x = d.datos;
  async function cambiar(estado) {
    const r = await ejecutar(() => rpatch(`/incidencias/${id}`, { estado, resolucion: res ?? x.resolucion ?? '', cerrado_por: quien.trim() }), estado === 'cerrada' ? 'Cerrada ✓' : 'Actualizada ✓');
    if (r) onCambio();
  }
  return (
    <div className="rejilla">
      <button className="btn fantasma" onClick={onVolver}>‹ Volver</button>
      <Estado d={d}>{() => x && (
        <>
          <div className="tarjeta rejilla">
            <h3 style={{ textTransform: 'none' }}>{ICONO[x.tipo]} {x.descripcion}</h3>
            <div className="tenue">#{x.numero} · {[x.sucursal_nombre || 'Fábrica', x.reportado_por && `reportó ${x.reportado_por}`, cuando(x.creado_en)].filter(Boolean).join(' · ')}</div>
            <div className="fila"><Chip tono={TONO[x.gravedad]}>{ESTADO[x.estado]} · {x.gravedad}</Chip>{x.tanda_lote && <Chip>Tanda {x.tanda_lote}</Chip>}{x.sabor_nombre && <Chip>{x.sabor_nombre}</Chip>}{x.insumo_nombre && <Chip>Lote de {x.insumo_nombre}</Chip>}</div>
          </div>
          {x.fotos?.length > 0 && <div className="tarjeta rejilla"><h3>Fotos</h3><div className="rv-fotos">{x.fotos.map((f) => <img key={f.id} className="grande" src={`data:${f.mime};base64,${f.imagen}`} alt="Foto de la incidencia" />)}</div></div>}
          <div className="tarjeta rejilla">
            <h3>Qué se hizo</h3>
            {x.estado === 'cerrada' ? <><p>{x.resolucion}</p><div className="tenue">{[x.cerrado_por, cuando(x.cerrado_en)].filter(Boolean).join(' · ')}</div></> : (
              <>
                <textarea rows={3} placeholder="Qué se hizo para resolverlo" value={res ?? x.resolucion ?? ''} onChange={(e) => setRes(e.target.value)} />
                <Campo etiqueta="Quién"><input value={quien} onChange={(e) => setQuien(e.target.value)} /></Campo>
                <div className="fila">{x.estado === 'abierta' && <button className="btn" disabled={ocupado} onClick={() => cambiar('en_revision')}>Estoy en eso</button>}<button className="btn primario" disabled={ocupado} onClick={() => cambiar('cerrada')}>Cerrar</button></div>
                <div className="tenue">Para cerrarla hay que escribir qué se hizo.</div>
              </>
            )}
          </div>
        </>
      )}</Estado>
    </div>
  );
}

/** Lo que salió mal y qué se hizo al respecto. Las graves primero, no las más nuevas. */
export function Lista({ onReportar }) {
  const [todas, setTodas] = useState(false); const [abierta, setAbierta] = useState(null);
  const d = useDatos(() => rget(`/incidencias${qs({ todas: todas ? 1 : '' })}`), [todas]);
  if (abierta) return <Detalle id={abierta} onVolver={() => setAbierta(null)} onCambio={() => { setAbierta(null); d.recargar(); }} />;
  return (
    <div className="rejilla">
      <div className="fila"><button className="btn primario" onClick={onReportar}>+ Reportar algo</button><button className="btn" onClick={() => setTodas((t) => !t)}>{todas ? 'Ver solo pendientes' : 'Ver también las cerradas'}</button></div>
      <Estado d={d}>{(l) => (l.length === 0 ? <div className="aviso-caja ok">{todas ? 'Todavía no hay nada reportado.' : '✅ No hay nada pendiente de resolver.'}</div> : (
        <div className="tarjeta pad0">{l.map((i) => (
          <div key={i.id} className="rv-fila clic" onClick={() => setAbierta(i.id)}>
            <span style={{ fontSize: '1.5rem' }}>{ICONO[i.tipo]}</span>
            <div className="info"><b>{i.descripcion}</b><span className="tenue">{[i.sucursal_nombre || 'Fábrica', i.sabor_nombre, i.tanda_lote && `tanda ${i.tanda_lote}`, i.reportado_por, cuando(i.creado_en)].filter(Boolean).join(' · ')}</span></div>
            <Chip tono={TONO[i.gravedad]}>{ESTADO[i.estado]}</Chip>{i.fotos > 0 && <Chip>📷 {i.fotos}</Chip>}<span>›</span>
          </div>))}</div>
      ))}</Estado>
    </div>
  );
}
