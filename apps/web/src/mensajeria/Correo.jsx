import { useState } from 'react';
import { fechaHoraHN } from '@grupo/shared';
import { get, post, put } from '../api.js';
import { Campo, Estado, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import './mensajeria.css';

const ETIQUETA_TIPO = { general: 'General', factura: 'Factura', cotizacion: 'Cotización', resumen: 'Resumen diario', alerta: 'Alerta', prueba: 'Prueba' };
const CHIP_ESTADO = { enviado: ['ok', 'Enviado'], pendiente: ['aviso', 'Pendiente'], fallido: ['mal', 'Fallido'] };

/** Administración · Correo y avisos (dueño y administrador). La contraseña de Gmail nunca se guarda aquí: vive en Render. */
export function ContenidoCorreo() {
  const d = useDatos(() => get('/mensajeria/estado'), []);
  const [vista, setVista] = useState('avisos');
  return (
    <Estado d={d}>{(e) => (
      <div className="msg-pagina">
        <TarjetaConexion e={e} onCambio={d.recargar} />
        <Tabs tabs={[['avisos', 'Avisos y destinatarios'], ['historial', 'Historial de envíos']]} valor={vista} onCambio={setVista} />
        {vista === 'avisos' ? <Reglas e={e} onGuardado={d.recargar} /> : <Historial />}
      </div>
    )}</Estado>
  );
}

function TarjetaConexion({ e, onCambio }) {
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const [para, setPara] = useState('');
  const sieteDias = e.ultimos_7_dias ?? {};

  const probar = async () => {
    const r = await ejecutar(() => post('/mensajeria/prueba', para.trim() ? { para: para.trim() } : {}));
    if (!r || r === true) return;
    if (r.ok) avisar(`Correo de prueba enviado a ${r.para.join(', ')}`);
    else avisar(r.pendiente ? `Quedó pendiente: ${r.error}` : `No se pudo enviar: ${r.error}`, 'mal');
    onCambio();
  };

  return (
    <section className="tarjeta" aria-labelledby="msg-conexion">
      <div className="msg-estado">
        <div>
          <h2 id="msg-conexion" style={{ margin: 0, fontSize: '1.1rem' }}>Conexión con Gmail</h2>
          <p className="tenue" style={{ margin: '4px 0 0' }}>
            {e.configurado
              ? <>Los correos salen desde <b>{e.remitente ?? 'la cuenta configurada'}</b>. Límite: {e.maxPorMinuto} por minuto.</>
              : 'Todavía no hay una cuenta de Gmail conectada. Mientras tanto, los correos quedan guardados y salen solos cuando se configure.'}
          </p>
        </div>
        <span className={`chip punto ${e.configurado ? 'ok' : 'aviso'}`}>{e.configurado ? 'Configurado' : 'Pendiente de configurar'}</span>
      </div>

      {!e.configurado && (
        <div style={{ marginTop: 12 }}>
          <b>Cómo conectarlo (una sola vez)</b>
          <ol className="msg-pasos">{e.pasos.map((p) => <li key={p}>{p}</li>)}</ol>
          <p className="tenue" style={{ margin: '8px 0 0' }}>Variables: {e.variables.map((v) => <code key={v} className="msg-codigo" style={{ marginRight: 6 }}>{v}</code>)} La contraseña nunca se guarda en la base de datos ni se muestra en pantalla.</p>
        </div>
      )}

      <div className="fila" style={{ marginTop: 14, alignItems: 'flex-end' }}>
        <Campo etiqueta="Enviar correo de prueba a" ayuda={e.destinatarios_por_defecto?.length ? `Si lo dejas vacío: tu correo o ${e.destinatarios_por_defecto[0]}` : 'Si lo dejas vacío se usa tu correo'}>
          <input type="email" inputMode="email" value={para} onChange={(ev) => setPara(ev.target.value)} placeholder="tu@correo.com" />
        </Campo>
        <button className="btn primario" disabled={ocupado} onClick={probar}>{ocupado ? 'Enviando…' : 'Enviar correo de prueba'}</button>
      </div>

      <p className="tenue" style={{ margin: '12px 0 0', fontSize: '.85rem' }}>
        Últimos 7 días: {sieteDias.enviado ?? 0} enviados · {sieteDias.pendiente ?? 0} pendientes · {sieteDias.fallido ?? 0} fallidos
        {e.ultimo_envio ? ` · último envío ${fechaHoraHN(e.ultimo_envio)}` : ''}
      </p>
    </section>
  );
}

function Reglas({ e, onGuardado }) {
  const grupo = e.reglas.filter((r) => r.ambito === 'grupo');
  const empresa = e.reglas.filter((r) => r.ambito === 'empresa');
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <p className="tenue" style={{ margin: 0 }}>
        Si no escribes destinatarios, el aviso le llega al dueño{e.destinatarios_por_defecto?.length ? ` (${e.destinatarios_por_defecto.join(', ')})` : ''}.
        Para no llenar el correo, cada aviso se agrupa en un solo mensaje y se repite como máximo cada cierto número de horas.
      </p>
      {grupo.length > 0 && <><h2 style={{ margin: 0, fontSize: '1rem' }}>Avisos del grupo</h2><div className="msg-reglas">{grupo.map((r) => <Regla key={r.tipo} r={r} onGuardado={onGuardado} />)}</div></>}
      {empresa.length > 0 && <><h2 style={{ margin: 0, fontSize: '1rem' }}>Avisos de esta empresa</h2><div className="msg-reglas">{empresa.map((r) => <Regla key={r.tipo} r={r} onGuardado={onGuardado} />)}</div></>}
    </div>
  );
}

function Regla({ r, onGuardado }) {
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const [f, setF] = useState({ activo: r.activo, destinatarios: (r.destinatarios ?? []).join(', '), hora: r.hora ?? 7, horas_entre: r.horas_entre, umbral: r.umbral ?? 50 });
  const cambio = f.activo !== r.activo || f.destinatarios !== (r.destinatarios ?? []).join(', ') || Number(f.horas_entre) !== r.horas_entre || (r.usa_hora && Number(f.hora) !== (r.hora ?? 7)) || (r.usa_umbral && Number(f.umbral) !== (r.umbral ?? 50));

  const guardar = async () => {
    const ok = await ejecutar(() => put(`/mensajeria/avisos/${r.tipo}`, {
      activo: f.activo, destinatarios: f.destinatarios, horas_entre: Number(f.horas_entre),
      ...(r.usa_hora ? { hora: Number(f.hora) } : {}), ...(r.usa_umbral ? { umbral: Number(f.umbral) } : {}),
    }), 'Aviso guardado');
    if (ok) onGuardado();
  };
  const enviarAhora = async () => {
    const x = await ejecutar(() => post('/mensajeria/resumen/enviar-ahora', {}));
    if (!x || x === true) return;
    avisar(x.enviado ? `Resumen enviado a ${x.destinatarios.join(', ')}` : x.pendiente ? `Quedó pendiente: ${x.error}` : `No se envió: ${x.error || x.motivo}`, x.enviado ? 'ok' : 'mal');
  };

  return (
    <article className="tarjeta msg-regla">
      <div className="cab">
        <div><h3>{r.nombre}</h3><p className="tenue desc">{r.descripcion}</p></div>
        <label className="msg-interruptor"><input type="checkbox" checked={f.activo} onChange={(ev) => setF({ ...f, activo: ev.target.checked })} /> {f.activo ? 'Activo' : 'Apagado'}</label>
      </div>
      <Campo etiqueta="Destinatarios" ayuda="Separa con comas. Vacío = el dueño.">
        <input type="text" inputMode="email" value={f.destinatarios} onChange={(ev) => setF({ ...f, destinatarios: ev.target.value })} placeholder="correo1@x.com, correo2@x.com" />
      </Campo>
      <div className="dos">
        {r.usa_hora && (
          <Campo etiqueta="Hora de envío (Honduras)" ayuda={Number(f.hora) >= 17 ? 'Resumen del mismo día' : 'Resumen del día anterior'}>
            <select value={f.hora} onChange={(ev) => setF({ ...f, hora: ev.target.value })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{`${h % 12 || 12}:00 ${h < 12 ? 'a. m.' : 'p. m.'}`}</option>)}</select>
          </Campo>
        )}
        {!r.usa_hora && (
          <Campo etiqueta="Repetir como máximo cada (horas)">
            <input type="number" min="1" max="168" value={f.horas_entre} onChange={(ev) => setF({ ...f, horas_entre: ev.target.value })} />
          </Campo>
        )}
        {r.usa_umbral && (
          <Campo etiqueta="Avisar desde una diferencia de (L)">
            <input type="number" min="0" step="10" value={f.umbral} onChange={(ev) => setF({ ...f, umbral: ev.target.value })} />
          </Campo>
        )}
      </div>
      <div className="fila">
        <button className="btn primario" disabled={ocupado || !cambio} onClick={guardar}>Guardar</button>
        {r.tipo === 'resumen_diario' && <button className="btn" disabled={ocupado} onClick={enviarAhora}>Enviar resumen ahora</button>}
      </div>
    </article>
  );
}

function Historial() {
  const [estado, setEstado] = useState('');
  const d = useDatos(() => get(`/mensajeria/historial${estado ? `?estado=${estado}` : ''}`), [estado]);
  const [ejecutar, ocupado] = useAccion();
  const avisar = useAviso();

  const reintentar = async (c) => {
    const r = await ejecutar(() => post(`/mensajeria/historial/${c.id}/reintentar`));
    if (!r || r === true) return;
    avisar(r.ok ? 'Correo enviado' : (r.error || 'No se pudo enviar'), r.ok ? 'ok' : 'mal');
    d.recargar();
  };

  return (
    <section className="tarjeta">
      <div className="fila espacio" style={{ marginBottom: 8 }}>
        <Campo etiqueta="Mostrar">
          <select value={estado} onChange={(ev) => setEstado(ev.target.value)}>
            <option value="">Todos</option><option value="enviado">Enviados</option><option value="pendiente">Pendientes</option><option value="fallido">Fallidos</option>
          </select>
        </Campo>
        <button className="btn" onClick={d.recargar}>Actualizar</button>
      </div>
      <Estado d={d}>{(filas) => !filas.length ? <p className="tenue">Todavía no hay correos en el historial.</p> : (
        <div className="tabla-wrap"><table className="msg-historial">
          <thead><tr><th>Fecha</th><th>Tipo</th><th>Para</th><th>Asunto</th><th>Estado</th><th /></tr></thead>
          <tbody>{filas.map((c) => {
            const [clase, texto] = CHIP_ESTADO[c.estado] ?? ['', c.estado];
            return (
              <tr key={c.id}>
                <td>{fechaHoraHN(c.enviado_at ?? c.created_at)}</td>
                <td>{ETIQUETA_TIPO[c.tipo] ?? c.tipo}{c.con_adjunto && <small className="tenue" style={{ display: 'block' }}>con adjunto</small>}</td>
                <td>{c.para.join(', ')}</td>
                <td className="asunto">{c.asunto}{c.ultimo_error && c.estado !== 'enviado' && <div className="msg-error">{c.ultimo_error}</div>}</td>
                <td><span className={`chip ${clase}`}>{texto}</span>{c.estado !== 'enviado' && c.intentos > 0 && <small className="tenue" style={{ display: 'block' }}>{c.intentos} intento{c.intentos === 1 ? '' : 's'}</small>}</td>
                <td className="der">{c.estado !== 'enviado' && <button className="btn chico" disabled={ocupado} onClick={() => reintentar(c)}>Reintentar</button>}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}</Estado>
    </section>
  );
}

export default ContenidoCorreo;
