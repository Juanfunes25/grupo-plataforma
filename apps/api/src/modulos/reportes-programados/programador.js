// Disparo de los reportes programados SIN cron externo: un temporizador interno revisa cada minuto qué
// reportes ya tocan (día y hora de Honduras) y deja un renglón por reporte y por día en rprog.ejecuciones.
// Esa tabla (unique programado_id + fecha) hace el disparo idempotente: reiniciar el servidor o tener dos
// instancias nunca envía dos veces el mismo reporte del mismo día.
import { fechaHN } from '@grupo/shared';
import { auditar } from '../../lib/auditoria.js';
import { correrProgramado } from './servicio.js';

const MAX_INTENTOS = 3;
const TZ = 'America/Tegucigalpa';

/** Hora (0-23) de Honduras y día ISO de la semana (1 = lunes … 7 = domingo) de un instante. */
export function relojHN(ahora = new Date()) {
  const hora = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(ahora));
  const dow = new Date(`${fechaHN(ahora)}T12:00:00Z`).getUTCDay();
  return { hoy: fechaHN(ahora), hora, dia_semana: dow === 0 ? 7 : dow };
}

/**
 * Corre lo que toca en este momento. Devuelve la lista de ejecuciones hechas: [{ id, estado, ... }].
 * `ahora` y `enviar` se pueden inyectar (pruebas).
 */
export async function ejecutarPendientes(db, { ahora = new Date(), enviar, log = () => {} } = {}) {
  const { hoy, hora, dia_semana } = relojHN(ahora);
  // «Toca» = activo, ya pasó su hora hoy, es su día, y el momento programado de hoy es posterior a la última vez que se guardó
  // (un reporte creado a las 3 p. m. con hora 7 a. m. empieza mañana, no dispara de golpe).
  const { rows } = await db.query(
    `select p.* from rprog.programados p join core.empresas e on e.id = p.empresa_id
      where p.activo and e.activo and p.hora <= $1 and (p.frecuencia = 'diario' or p.dia_semana = $2)
        and (($3::date + p.hora * interval '1 hour') at time zone '${TZ}') >= p.updated_at
        and not exists (select 1 from rprog.ejecuciones x where x.programado_id = p.id and x.fecha = $3::date
                         and (x.estado in ('enviado', 'pendiente_correo', 'sin_datos') or x.intentos >= ${MAX_INTENTOS}
                              or (x.estado = 'procesando' and x.iniciado_at > now() - interval '10 minutes')))
      order by p.hora, p.created_at`, [hora, dia_semana, hoy]);
  const hechas = [];
  for (const p of rows) {
    // Reclamar el día: solo una instancia lo logra (insert nuevo, o reintento de un error / de un «procesando» abandonado).
    const reclamo = await db.query(
      `insert into rprog.ejecuciones (programado_id, empresa_id, fecha, estado, destinatarios) values ($1, $2, $3::date, 'procesando', $4)
       on conflict (programado_id, fecha) do update set estado = 'procesando', intentos = rprog.ejecuciones.intentos + 1, iniciado_at = now(), terminado_at = null, detalle = null
         where rprog.ejecuciones.intentos < ${MAX_INTENTOS}
           and (rprog.ejecuciones.estado = 'error' or (rprog.ejecuciones.estado = 'procesando' and rprog.ejecuciones.iniciado_at < now() - interval '10 minutes'))
       returning id`, [p.id, p.empresa_id, hoy, p.destinatarios]);
    if (!reclamo.rowCount) continue;
    const id = reclamo.rows[0].id;
    let r;
    try { r = await correrProgramado(db, p, { ahora, enviar }); }
    catch (e) { r = { estado: 'error', detalle: `Falló al generar el reporte: ${String(e.message).slice(0, 250)}`, archivos: [], destinatarios: p.destinatarios }; }
    await db.query(`update rprog.ejecuciones set estado = $2, detalle = $3, archivos = $4::jsonb, destinatarios = $5, terminado_at = now() where id = $1`,
      [id, r.estado, r.detalle, JSON.stringify(r.archivos), r.destinatarios]);
    await auditar(db, null, `reporte_programado.${r.estado}`, 'reporte_programado', p.id, { nombre: p.nombre, tipo: p.tipo, fecha: hoy, destinatarios: r.destinatarios.length }, { empresaId: p.empresa_id }).catch(() => {});
    log(`[reportes] ${p.nombre}: ${r.estado}`);
    hechas.push({ id, programado_id: p.id, ...r });
  }
  return hechas;
}

let temporizador = null;
/** Arranca el revisor (cada minuto). Idempotente. Lo llama index.js al iniciar el API. */
export function iniciarProgramadorReportes({ db, cada = 60_000, log = console.log } = {}) {
  if (temporizador) return temporizador;
  let corriendo = false;
  const tic = async () => {
    if (corriendo) return;
    corriendo = true;
    try { await ejecutarPendientes(db, { log }); } catch (e) { console.error('[reportes] programador:', e.message); } finally { corriendo = false; }
  };
  temporizador = setInterval(tic, cada);
  temporizador.unref?.();
  setTimeout(tic, 15_000).unref?.();   // primera revisión poco después de arrancar (por si el servidor estuvo apagado a la hora)
  return temporizador;
}
export function detenerProgramadorReportes() { if (temporizador) clearInterval(temporizador); temporizador = null; }
