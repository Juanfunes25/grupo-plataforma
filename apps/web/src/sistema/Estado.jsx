import { useState } from 'react';
import { fechaHoraHN } from '@grupo/shared';
import { get, almacen, empresaActual } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Estado, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import '../seguridad/seguridad.css';

const ETIQUETA = { ok: 'Bien', aviso: 'Atención', critico: 'Urgente' };

async function descargarRespaldo(conClaves) {
  const s = almacen.leer();
  const r = await fetch(`/api/sistema/respaldo?con_claves=${conClaves ? 1 : 0}`, { headers: { authorization: `Bearer ${s?.token}`, 'x-empresa': empresaActual() } });
  if (!r.ok) { let m = `Error ${r.status}`; try { m = (await r.json()).error || m; } catch { /* */ } throw new Error(m); }
  const blob = await r.blob();
  const nombre = /filename="([^"]+)"/.exec(r.headers.get('content-disposition') || '')?.[1] ?? 'respaldo.zip';
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: nombre });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function Respaldo({ e, recargar }) {
  const { contexto } = useSesion();
  const [ejecutar, ocupado] = useAccion();
  const [claves, setClaves] = useState(false);
  const aviso = useAviso();
  const mia = e.respaldos.find((r) => r.empresa === contexto?.empresa?.codigo);
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
      <h2>Copia exportable de {contexto?.empresa?.nombre}</h2>
      <p style={{ margin: 0 }}>Un ZIP con todos los datos de esta empresa (una tabla por archivo, en CSV para Excel y JSON para restaurar). Supabase ya hace sus propias copias de la base; esta es <b>tuya</b>, sirve fuera de Supabase y se restaura con el script de <code>docs/RESPALDOS.md</code>.</p>
      <label className="casilla"><input type="checkbox" checked={claves} onChange={(x) => setClaves(x.target.checked)} /> Incluir contraseñas y PIN cifrados (para restaurar todo sin reasignarlos; trátalo como secreto)</label>
      <div className="fila"><button className="btn primario" disabled={ocupado} onClick={async () => { if (await ejecutar(() => descargarRespaldo(claves).then(() => true), 'Copia descargada')) { aviso('Guárdala en un lugar seguro'); recargar(); } }}>{ocupado ? 'Generando…' : 'Descargar copia de la empresa'}</button></div>
      <small>{mia ? `Última copia de esta empresa: ${fechaHoraHN(mia.fecha)} por ${mia.por ?? '—'} (${mia.tablas} tablas).` : 'Todavía no has descargado una copia de esta empresa.'} Cambia de empresa para descargar las otras.</small>
    </div>
  );
}

function Errores({ e }) {
  const [origen, setOrigen] = useState('');
  const d = useDatos(() => get(`/sistema/errores${origen ? `?origen=${origen}` : ''}`), [origen]);
  return (
    <div className="tarjeta" style={{ display: 'grid', gap: 12 }}>
      <h2>Errores</h2>
      {e.errores.mas_repetidos.length > 0 && <>
        <b>Los más repetidos (7 días)</b>
        <div className="tabla-wrap"><table><thead><tr><th>Error</th><th>Dónde</th><th>Veces</th><th>Última</th></tr></thead>
          <tbody>{e.errores.mas_repetidos.map((x) => <tr key={x.huella + x.origen}><td>{x.mensaje}</td><td><span className="chip">{x.origen}</span> <small>{x.metodo} {x.ruta}</small></td><td>{x.veces}</td><td>{fechaHoraHN(x.ultima)}</td></tr>)}</tbody></table></div></>}
      <Tabs estilo="pildora" tabs={[['', 'Todos'], ['servidor', 'Servidor'], ['navegador', 'Navegador'], ['caida', 'Caídas'], ['aviso', 'Avisos sin enviar']]} valor={origen} onCambio={setOrigen} />
      <Estado d={d}>{(l) => l.length ? (
        <div className="tabla-wrap"><table><thead><tr><th>Cuándo</th><th>Tipo</th><th>Mensaje</th></tr></thead>
          <tbody>{l.map((x) => <tr key={x.id}><td>{fechaHoraHN(x.created_at)}</td><td><span className="chip">{x.origen}</span></td>
            <td>{x.mensaje}{x.extra?.repeticiones > 1 && <b> ×{x.extra.repeticiones}</b>}{x.ruta && <><br /><small>{x.metodo} {x.ruta}</small></>}</td></tr>)}</tbody></table></div>
      ) : <div className="aviso-caja ok">Sin registros.</div>}</Estado>
    </div>
  );
}

export default function EstadoSistema() {
  const d = useDatos(() => get('/sistema/estado'), []);
  const [tab, setTab] = useState('resumen');
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Estado del sistema</h1><button className="btn" onClick={d.recargar}>Actualizar</button></div>
      <Estado d={d}>{(e) => (
        <div style={{ display: 'grid', gap: 14 }}>
          <div className={`modo-banner ${e.general === 'ok' ? 'real' : e.general === 'aviso' ? 'prueba' : 'preparacion'}`} role="status">
            <div>{e.general === 'ok' ? 'Todo en orden' : e.general === 'aviso' ? 'Hay cosas por revisar' : 'Hay algo urgente'}<small>Revisado {fechaHoraHN(e.generado_at)} · versión {e.servidor.version || 'sin dato'} · {e.servidor.entorno}</small></div>
          </div>
          <Tabs estilo="pildora" tabs={[['resumen', 'Resumen'], ['errores', 'Errores y caídas'], ['respaldo', 'Copia exportable']]} valor={tab} onCambio={setTab} />
          {tab === 'resumen' && <>
            <div className="tarjeta"><h2>Chequeos</h2>
              {e.chequeos.map((c) => <div key={c.id} className="sesion-fila"><div className="quien"><b><span className={`semaforo ${c.estado}`} />{c.titulo}</b><small>{c.detalle}</small></div><span className={`chip ${c.estado === 'ok' ? 'ok' : c.estado === 'critico' ? 'mal' : 'aviso'}`}>{ETIQUETA[c.estado]}</span></div>)}</div>
            <div className="rejilla cols-2">
              <div className="tarjeta"><h2>Base de datos</h2>
                <small>{e.base.motor} · responde en {e.base.latencia_ms} ms</small>
                {e.base.tamano_mb !== null && <p style={{ margin: '6px 0' }}>{e.base.tamano_mb} MB de {e.base.limite_mb} MB</p>}
                {e.base.tablas_grandes.length > 0 && <small>Más grandes: {e.base.tablas_grandes.slice(0, 4).map((t) => `${t.tabla} (${t.mb} MB)`).join(' · ')}</small>}
                {e.base.conexiones && <small style={{ display: 'block' }}>Conexiones: {e.base.conexiones.total} abiertas, {e.base.conexiones.esperando} en espera</small>}</div>
              <div className="tarjeta"><h2>Servidor</h2>
                <small>Memoria {e.servidor.memoria_mb} MB · encendido hace {Math.round(e.servidor.arranque_hace_s / 60)} min · {e.servidor.node}</small>
                <small style={{ display: 'block' }}>Migraciones: {e.migraciones.aplicadas} aplicadas (última {e.migraciones.ultima})</small>
                <small style={{ display: 'block' }}>Sesiones abiertas: {e.sesiones_abiertas}</small></div>
            </div></>}
          {tab === 'errores' && <><Errores e={e} />
            {e.caidas.length > 0 && <div className="tarjeta"><h2>Caídas detectadas</h2>{e.caidas.map((c, i) => <div key={i} className="sesion-fila"><small>{fechaHoraHN(c.cuando)}</small><span style={{ flex: 1 }}>{c.mensaje}</span></div>)}</div>}</>}
          {tab === 'respaldo' && <Respaldo e={e} recargar={d.recargar} />}
        </div>
      )}</Estado>
    </div>
  );
}
