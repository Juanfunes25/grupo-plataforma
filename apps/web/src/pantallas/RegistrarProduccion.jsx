import { useMemo, useState } from 'react';
import { get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { ErrorCaja, useDatos } from '../ui/kit.jsx';
import { diaCorto, horaCorta, n, ChipEstado } from '../fab/comun.jsx';
import { imprimirEtiqueta } from '../fab/etiqueta.js';

/**
 * Pantalla del productor (celular): 1) modelo 2) color 3) cuántas cajas 4) ENVIAR.
 * Fecha, hora y usuario se guardan solos; se descuenta la materia prima según la receta y el lote queda «en secado».
 */
export default function RegistrarProduccion() {
  const { contexto } = useSesion();
  const catalogoD = useDatos(() => get('/fab/registro/catalogo'), []);
  const recientesD = useDatos(() => get('/fab/registro/recientes'), []);
  const catalogo = catalogoD.datos ?? [];
  const recientes = recientesD.datos ?? [];
  const [modelo, setModelo] = useState('');
  const [color, setColor] = useState('');
  const [tipo, setTipo] = useState('plana');
  const [cantidad, setCantidad] = useState(0);
  const [confirmando, setConfirmando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [error, setError] = useState('');
  const [verRecientes, setVerRecientes] = useState(false);

  const modelos = useMemo(() => [...new Set(catalogo.map((p) => p.modelo))], [catalogo]);
  const colores = useMemo(() => [...new Set(catalogo.filter((p) => p.modelo === modelo).map((p) => p.color))], [catalogo, modelo]);
  const variantes = useMemo(() => catalogo.filter((p) => p.modelo === modelo && p.color === color), [catalogo, modelo, color]);
  const tieneEsquina = variantes.some((p) => p.esquina);
  const tienePlana = variantes.some((p) => !p.esquina);
  const producto = variantes.find((p) => (tipo === 'esquina') === p.esquina) ?? (variantes.length === 1 ? variantes[0] : null);
  const valida = producto && cantidad > 0;
  const sumar = (k) => setCantidad((c) => Math.max(0, Math.min(9999, c + k)));

  const elegirModelo = (m) => { setModelo(m); setColor(''); setTipo('plana'); setResultado(null); setError(''); };
  const elegirColor = (c) => { setColor(c); setResultado(null); setError(''); setTipo(catalogo.some((p) => p.modelo === modelo && p.color === c && !p.esquina) ? 'plana' : 'esquina'); };

  async function enviar() {
    setEnviando(true); setError('');
    try {
      const r = await post('/fab/registro', { producto_id: producto.id, cantidad });
      setResultado({ ...r, producto_id: producto.id });
      setCantidad(0); setConfirmando(false); setModelo(''); setColor('');
      recientesD.recargar();
    } catch (e) { setError(e.message); setConfirmando(false); } finally { setEnviando(false); }
  }
  function otraIgual() {
    const p = catalogo.find((x) => x.id === resultado.producto_id);
    if (p) { setModelo(p.modelo); setColor(p.color); setTipo(p.esquina ? 'esquina' : 'plana'); }
    setResultado(null);
  }

  return (
    <div className="reg">
      <h1 style={{ fontSize: '1.3rem', margin: '4px 0 0' }}>Registrar producción</h1>
      <ErrorCaja error={error || catalogoD.error} />

      {resultado && (
        <div className="tarjeta reg-listo" style={{ marginTop: 14 }}>
          <h2 style={{ marginTop: 0, color: 'var(--ok)', fontSize: '1.6rem' }}>Listo, registrado</h2>
          <p style={{ fontSize: '1.4rem', margin: '4px 0' }}><b>{n(resultado.cantidad, 0)} {resultado.unidad === 'm²' ? 'cajas' : resultado.unidad}</b></p>
          <p style={{ fontSize: '1.1rem', margin: '0 0 4px' }}>{resultado.producto}</p>
          <p className="fab-sub">Lote {resultado.lote} · {diaCorto(resultado.registrado_at)} {horaCorta(resultado.registrado_at)} · en secado</p>
          {resultado.avisos.map((a) => <div key={a} className="aviso-caja mal" style={{ marginTop: 8 }}>{a}</div>)}
          <div className="reg-rejilla" style={{ marginTop: 12 }}>
            <button className="reg-btn on" onClick={otraIgual}>Otra igual</button>
            <button className="reg-btn" onClick={() => setResultado(null)}>Nueva</button>
          </div>
          <button className="reg-btn" style={{ marginTop: 10, minHeight: 52, fontSize: '1rem' }} onClick={() => imprimirEtiqueta(resultado.lote).catch((e) => setError(e.message))}>Imprimir etiqueta del lote</button>
        </div>
      )}

      {!resultado && (
        <>
          <h3>1 · Modelo</h3>
          <div className="reg-rejilla">{modelos.map((m) => <button key={m} className={`reg-btn ${modelo === m ? 'on' : ''}`} onClick={() => elegirModelo(m)}>{m}</button>)}</div>
          {catalogo.length === 0 && !catalogoD.cargando && <p className="fab-sub">No hay piedra en el catálogo todavía. Avisa al administrador.</p>}

          {modelo && (
            <>
              <h3>2 · Color</h3>
              <div className="reg-rejilla">{colores.map((c) => <button key={c} className={`reg-btn ${color === c ? 'on' : ''}`} onClick={() => elegirColor(c)}>{c || 'Único'}</button>)}</div>
            </>
          )}

          {(color || (modelo && colores.length === 1 && colores[0] === '')) && tieneEsquina && tienePlana && (
            <div className="reg-rejilla" style={{ marginTop: 12 }}>
              <button className={`reg-btn ${tipo === 'plana' ? 'on' : ''}`} onClick={() => setTipo('plana')}>Piedra plana</button>
              <button className={`reg-btn ${tipo === 'esquina' ? 'on' : ''}`} onClick={() => setTipo('esquina')}>Caja de esquina</button>
            </div>
          )}

          {producto && (
            <>
              <h3>3 · Cuántas cajas</h3>
              <div className="reg-cant">
                <button className="reg-btn" onClick={() => sumar(-1)} aria-label="Menos">−</button>
                <input type="number" inputMode="numeric" min="0" step="1" value={cantidad || ''} placeholder="0" onChange={(e) => setCantidad(Math.max(0, Math.min(9999, Math.floor(Number(e.target.value) || 0))))} />
                <button className="reg-btn on" onClick={() => sumar(1)} aria-label="Más">+</button>
              </div>
              <div className="reg-atajos">{[5, 10, 20, 50].map((k) => <button key={k} className="reg-btn" onClick={() => sumar(k)}>+{k}</button>)}</div>
              {cantidad > 0 && <button className="reg-btn" style={{ minHeight: 44, fontSize: '.95rem', marginTop: 8 }} onClick={() => setCantidad(0)}>Borrar cantidad</button>}
              {!producto.con_receta && <p style={{ color: 'var(--aviso)' }}>Este modelo aún no tiene receta: se guarda la producción sin descontar materia prima.</p>}
            </>
          )}
        </>
      )}

      {!resultado && producto && (
        <div className="reg-barra"><div>
          <button className={`reg-btn ${valida ? 'ok' : ''}`} disabled={!valida || enviando} onClick={() => setConfirmando(true)}>{valida ? `ENVIAR · ${n(cantidad, 0)} cajas` : 'ENVIAR'}</button>
        </div></div>
      )}

      {confirmando && producto && (
        <div className="velo"><div className="modal" style={{ maxWidth: 420, textAlign: 'center' }}>
          <div className="modal-cuerpo">
            <h2 style={{ marginTop: 0 }}>¿Está bien?</h2>
            <p style={{ fontSize: '2.2rem', margin: '8px 0', fontWeight: 800 }}>{n(cantidad, 0)} {producto.unidad === 'm²' ? 'cajas' : producto.unidad}</p>
            <p style={{ fontSize: '1.2rem', margin: '0 0 16px' }}>{producto.nombre}</p>
            <div className="reg-rejilla">
              <button className="reg-btn" disabled={enviando} onClick={() => setConfirmando(false)}>Corregir</button>
              <button className="reg-btn ok" disabled={enviando} onClick={enviar}>{enviando ? 'Enviando…' : 'Sí, enviar'}</button>
            </div>
          </div>
        </div></div>
      )}

      {!resultado && recientes.length > 0 && (
        <div className="tarjeta" style={{ marginTop: 24 }}>
          <button type="button" className="btn fantasma" style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setVerRecientes((v) => !v)} aria-expanded={verRecientes}>
            <span>{contexto?.rol === 'produccion' ? 'Lo que registré' : 'Registros recientes'} ({Math.min(recientes.length, 8)})</span><span aria-hidden="true">{verRecientes ? '▲' : '▼'}</span>
          </button>
          {verRecientes && recientes.slice(0, 8).map((r) => (
            <div key={r.id} className="fab-linea" style={{ justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}><b>{r.producto}</b><span className="fab-sub">{diaCorto(r.registrado_at)} {horaCorta(r.registrado_at)} · {r.lote}{contexto?.rol !== 'produccion' && r.operario ? ` · ${r.operario}` : ''}</span></div>
              <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><b>{n(r.cantidad, 0)}</b><div><ChipEstado estado={r.estado} /></div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
