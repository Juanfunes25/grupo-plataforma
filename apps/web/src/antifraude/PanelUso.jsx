import { useState } from 'react';
import { get, qs } from '../api.js';
import { Estado, Kpi, useAccion, useDatos } from '../ui/kit.jsx';
import { ETIQUETA_EVENTO, fechaHora, resumenEvento } from './etiquetas.js';

export default function PanelUso({ desde, hasta, version }) {
  const uso = useDatos(() => get(`/antifraude/uso${qs({ desde, hasta })}`), [desde, hasta, version]);
  const disp = useDatos(() => get('/antifraude/dispositivos'), [version]);
  const [integridad, setIntegridad] = useState(null);
  const [ejecutar, ocupado] = useAccion();
  const verificar = async () => { const r = await ejecutar(() => get('/antifraude/integridad')); if (r && r !== true) setIntegridad(r); };

  return (
    <>
      <div className="tarjeta" style={{ display: 'grid', gap: 10 }}>
        <div className="fila espacio"><h3>Integridad de la bitácora</h3><button className="btn chico" onClick={verificar} disabled={ocupado}>{ocupado ? 'Verificando…' : 'Verificar ahora'}</button></div>
        <small>Cada acción queda encadenada con un sello (hash) a la anterior; si alguien modificara la base directamente, la cadena se rompe y aquí se detecta. El sistema también lo revisa solo cada pocas horas.</small>
        {integridad && (integridad.integra
          ? <div className="aviso-caja ok">Bitácora íntegra: {integridad.total} registros verificados, ninguno alterado.</div>
          : <div className="aviso-caja mal">La bitácora fue alterada: la cadena se rompe en el registro #{integridad.primer_id_alterado} (de {integridad.total}).</div>)}
      </div>

      <Estado d={uso}>{(u) => (
        <>
          <div className="tarjeta pad0">
            <div style={{ padding: '14px 16px 4px' }}><h3>Uso del sistema por persona</h3><small>Del {desde} al {hasta}. Qué tanto entra cada persona, a qué pantallas y si la sesión se bloqueó por inactividad.</small></div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Persona</th><th className="der">Inicios de sesión</th><th className="der">Pantallas abiertas</th><th className="der">Bloqueos</th><th className="der">Desbloqueos fallidos</th><th>Primer / último</th></tr></thead>
              <tbody>
                {u.sesiones.length === 0 && <tr><td colSpan={6} className="centro tenue">Sin actividad registrada.</td></tr>}
                {u.sesiones.map((s) => <tr key={s.usuario}><td><strong>{s.usuario}</strong></td><td className="der num">{s.inicios}</td><td className="der num">{s.pantallas}</td><td className="der num">{s.bloqueos}</td>
                  <td className="der num">{s.desbloqueos_fallidos}</td><td>{fechaHora(s.primero)} – {fechaHora(s.ultimo)}</td></tr>)}
              </tbody>
            </table></div>
          </div>
          <div className="rejilla cols-2">
            <div className="tarjeta pad0">
              <div style={{ padding: '14px 16px 4px' }}><h3>Bitácora de pantallas</h3></div>
              <div className="tabla-wrap"><table>
                <thead><tr><th>Persona</th><th>Pantalla</th><th className="der">Veces</th><th>Última</th></tr></thead>
                <tbody>
                  {u.pantallas.length === 0 && <tr><td colSpan={4} className="centro tenue">Nada registrado.</td></tr>}
                  {u.pantallas.map((p, i) => <tr key={i}><td>{p.usuario}</td><td>{p.pantalla}</td><td className="der num">{p.veces}</td><td>{fechaHora(p.ultima)}</td></tr>)}
                </tbody>
              </table></div>
            </div>
            <div className="tarjeta" style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
              <h3>Eventos recientes</h3>
              <div className="af-feed">
                {u.eventos.length === 0 && <div className="vacio">Nada registrado.</div>}
                {u.eventos.map((e) => <div key={e.id} className="af-evento"><span>{fechaHora(e.created_at)}</span>
                  <span><strong>{e.usuario_nombre ?? 'Sistema'}</strong> · {ETIQUETA_EVENTO[e.accion] ?? e.accion}{e.sucursal ? ` · ${e.sucursal}` : ''}<br /><small>{resumenEvento(e)}</small></span></div>)}
              </div>
            </div>
          </div>
          <div className="tarjeta pad0">
            <div style={{ padding: '14px 16px 4px' }}><h3>Intentos fallidos de entrar</h3><small>Correo o PIN incorrectos en este periodo.</small></div>
            <div className="tabla-wrap"><table>
              <thead><tr><th>Cuándo</th><th>Tipo</th><th>Intentó entrar como</th><th>IP</th></tr></thead>
              <tbody>
                {u.login_fallidos.length === 0 && <tr><td colSpan={4} className="centro tenue">Ninguno.</td></tr>}
                {u.login_fallidos.map((f) => <tr key={f.id}><td>{fechaHora(f.created_at)}</td><td>{f.accion === 'pin_fallido' ? 'PIN' : 'Correo y contraseña'}</td><td>{f.acceso ?? '—'}</td><td>{f.ip ?? ''}</td></tr>)}
              </tbody>
            </table></div>
          </div>
        </>
      )}</Estado>

      <div className="tarjeta pad0">
        <div style={{ padding: '14px 16px 4px' }}><h3>Dispositivos</h3><small>Navegadores desde los que ha entrado cada persona. Un dispositivo nuevo o dos equipos a la vez generan alerta.</small></div>
        <Estado d={disp}>{(rows) => (
          <div className="tabla-wrap"><table>
            <thead><tr><th>Persona</th><th>Dispositivo</th><th>Primera vez</th><th>Última vez</th><th>IP</th><th>Navegador</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="centro tenue">Todavía no hay dispositivos registrados.</td></tr>}
              {rows.map((x) => <tr key={`${x.usuario_id}${x.dispositivo_id}`}><td>{x.usuario}{x.dispositivos_usuario > 1 && <span className="chip aviso" style={{ marginLeft: 6 }}>{x.dispositivos_usuario} equipos</span>}</td><td className="num">{x.dispositivo_id}</td>
                <td>{fechaHora(x.primera_vez)}</td><td>{fechaHora(x.ultima_vez)}</td><td>{x.ip}</td><td title={x.navegador} style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{x.navegador}</td></tr>)}
            </tbody>
          </table></div>
        )}</Estado>
      </div>
    </>
  );
}
