// Servicio de correo de la plataforma (Gmail por SMTP con nodemailer). Único canal de avisos: sin WhatsApp ni push.
//
//   import { enviarCorreo } from '../lib/correo.js';
//   const r = await enviarCorreo({ empresaId, para: 'cliente@x.com', asunto, html, texto, adjuntos: [{ nombre, mime, contenido: Buffer }] });
//   → { ok, pendiente, error, id }
//
//   ok        true si el correo salió.
//   pendiente true si quedó en la cola (Gmail sin configurar, límite por minuto o falla momentánea): se reintenta solo.
//   error     texto en español cuando no salió (nunca se lanza una excepción por problemas de envío).
//
// Credenciales SOLO en variables de entorno: GMAIL_USER y GMAIL_APP_PASSWORD (contraseña de aplicación de Gmail).
// Si faltan, el correo se registra como «pendiente de configurar» y sale solo cuando se configuren.
// Cada envío queda en msg.correos (enviado / pendiente / fallido) con reintentos espaciados y un límite por minuto.
import nodemailer from 'nodemailer';
import { fechaHN } from '@grupo/shared';

const MAX_INTENTOS = 5;
const ESPERAS_MIN = [2, 10, 30, 120, 360];        // minutos entre reintentos
const MAX_POR_MINUTO = Number(process.env.CORREO_MAX_POR_MINUTO) || 20;
const PENDIENTE_CONFIG = 'Pendiente de configurar: faltan GMAIL_USER y GMAIL_APP_PASSWORD';

const estado = { db: null, config: null, transporte: null, enviosRecientes: [], temporizador: null, procesando: false };

/** Conecta el servicio con la base y la configuración (lo llama el módulo de mensajería al montarse). */
export function configurarCorreo({ db, config, transporte } = {}) {
  if (db) estado.db = db;
  if (config) estado.config = config;
  if (transporte !== undefined) estado.transporte = transporte;       // pruebas: un transporte falso
  return estado;
}

function credenciales() {
  const user = estado.config?.smtp?.user || process.env.GMAIL_USER || '';
  const pass = estado.config?.smtp?.pass || process.env.GMAIL_APP_PASSWORD || '';
  return { user: user.trim(), pass: pass.replace(/\s+/g, '') };    // Google muestra la clave en bloques de 4 con espacios
}

export function correoConfigurado() {
  if (estado.transporte) return true;
  const c = credenciales();
  return Boolean(c.user && c.pass);
}

export function remitente() { return credenciales().user || null; }

function obtenerTransporte() {
  if (estado.transporte) return estado.transporte;
  const { user, pass } = credenciales();
  if (!user || !pass) return null;
  estado.transporte = nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, connectionTimeout: 15000, socketTimeout: 30000 });
  estado.transporteReal = true;
  return estado.transporte;
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]{2,}$/;
export const correoValido = (e) => typeof e === 'string' && EMAIL.test(e.trim()) && e.trim().length <= 160;

/** Acepta 'a@x.com', 'a@x.com, b@y.com' o un arreglo; devuelve { validos, invalidos } sin repetidos. */
export function normalizarDestinatarios(para) {
  const lista = (Array.isArray(para) ? para : String(para ?? '').split(/[,;\s]+/)).map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  const validos = [...new Set(lista.filter(correoValido))];
  return { validos, invalidos: lista.filter((e) => !correoValido(e)) };
}

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const escaparHtml = esc;

/**
 * Plantilla HTML sobria: banda con el color de la empresa, monograma + nombre, el contenido y un pie con sus datos.
 * `cuerpo` es HTML ya escapado por quien lo arma.
 */
export function plantillaCorreo({ empresa, titulo, cuerpo, pie }) {
  const color = /^#[0-9a-fA-F]{3,8}$/.test(empresa?.color ?? '') ? empresa.color : '#2f2a26';
  const nombre = empresa?.nombre ?? 'Grupo';
  const inicial = esc((nombre.trim()[0] ?? 'G').toUpperCase());
  const datos = [empresa?.razon_social, empresa?.rtn ? `RTN ${empresa.rtn}` : null, empresa?.telefono, empresa?.correo, [empresa?.direccion, empresa?.ciudad].filter(Boolean).join(', ')]
    .filter(Boolean).map(esc).join(' &middot; ');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(titulo ?? nombre)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ec;font-family:Arial,Helvetica,sans-serif;color:#2b2622">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e0d8">
<tr><td style="background:${color};padding:18px 24px">
 <table role="presentation" cellpadding="0" cellspacing="0"><tr>
  <td style="width:42px;height:42px;background:#ffffff;border-radius:50%;text-align:center;font-size:20px;font-weight:bold;color:${color};line-height:42px">${inicial}</td>
  <td style="padding-left:12px;color:#ffffff;font-size:20px;font-weight:bold">${esc(nombre)}</td>
 </tr></table>
</td></tr>
<tr><td style="padding:24px;font-size:15px;line-height:1.55">
 ${titulo ? `<h1 style="margin:0 0 14px;font-size:19px;color:#2b2622">${esc(titulo)}</h1>` : ''}
 ${cuerpo ?? ''}
</td></tr>
<tr><td style="padding:14px 24px;background:#faf8f5;border-top:1px solid #e6e0d8;font-size:12px;color:#7a716a;line-height:1.5">
 ${pie ? `${pie}<br>` : ''}${datos}
</td></tr>
</table></td></tr></table></body></html>`;
}

/** Texto plano a partir de HTML (respaldo para clientes sin HTML). */
export function htmlATexto(html) {
  return String(html ?? '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&middot;/g, '·').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function hayCupo() {
  const ahora = Date.now();
  estado.enviosRecientes = estado.enviosRecientes.filter((t) => ahora - t < 60_000);
  return estado.enviosRecientes.length < MAX_POR_MINUTO;
}

function textoError(e) {
  const m = String(e?.message ?? e ?? 'Error desconocido');
  if (/Invalid login|535|Username and Password not accepted|BadCredentials/i.test(m)) return 'Gmail rechazó el usuario o la contraseña de aplicación. Revisa GMAIL_USER y GMAIL_APP_PASSWORD.';
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket|timeout/i.test(m)) return 'No se pudo conectar con Gmail (red o tiempo agotado). Se reintentará.';
  return m.slice(0, 300);
}

async function envioReal(c, adjuntos) {
  const t = obtenerTransporte();
  const { user } = credenciales();
  const de = c.de_nombre ? `"${c.de_nombre.replace(/"/g, '')}" <${user || 'plataforma@localhost'}>` : (user || 'plataforma@localhost');
  await t.sendMail({
    from: de, to: c.para, subject: c.asunto, html: c.html, text: c.texto || htmlATexto(c.html),
    attachments: adjuntos.map((a) => ({ filename: a.nombre, content: Buffer.from(a.contenido), contentType: a.mime })),
  });
  estado.enviosRecientes.push(Date.now());
}

/** Registra el resultado de un intento sobre la fila. Devuelve { ok, pendiente, error }. */
async function marcar(id, { enviado, error, sinConfig }) {
  const db = estado.db;
  if (!db) return;
  if (enviado) {
    await db.query(`update msg.correos set estado='enviado', enviado_at=now(), intentos=intentos+1, ultimo_error=null where id=$1`, [id]);
    await db.query('delete from msg.adjuntos where correo_id = $1', [id]);        // ya salió: no se guardan los bytes
    return;
  }
  if (sinConfig) {
    await db.query(`update msg.correos set estado='pendiente', ultimo_error=$2, proximo_intento=now() + interval '10 minutes' where id=$1`, [id, PENDIENTE_CONFIG]);
    return;
  }
  await db.query(
    `update msg.correos set intentos = intentos + 1, ultimo_error = $2,
       estado = case when intentos + 1 >= $3 then 'fallido' else 'pendiente' end,
       proximo_intento = now() + ((($4::int[])[least(intentos + 1, $3)])::text || ' minutes')::interval where id = $1`,
    [id, error, MAX_INTENTOS, ESPERAS_MIN]);
}

async function intentar(fila) {
  if (!correoConfigurado()) { await marcar(fila.id, { sinConfig: true }); return { ok: false, pendiente: true, error: PENDIENTE_CONFIG }; }
  if (!hayCupo()) return { ok: false, pendiente: true, error: 'Límite de envíos por minuto: se enviará en breve' };
  const adj = estado.db ? (await estado.db.query('select nombre, mime, contenido from msg.adjuntos where correo_id = $1', [fila.id])).rows : [];
  try {
    await envioReal(fila, adj);
    await marcar(fila.id, { enviado: true });
    return { ok: true, pendiente: false, error: null };
  } catch (e) {
    const error = textoError(e);
    await marcar(fila.id, { error });
    const f = (await estado.db.query('select estado from msg.correos where id=$1', [fila.id])).rows[0];
    return { ok: false, pendiente: f?.estado === 'pendiente', error };
  }
}

async function datosEmpresa(empresaId) {
  if (!estado.db || !empresaId) return null;
  const { rows } = await estado.db.query('select nombre, razon_social, rtn, telefono, correo, direccion, ciudad, color from core.empresas where id = $1', [empresaId]);
  return rows[0] ?? null;
}

/**
 * Envía (o encola) un correo. Nunca lanza excepción por problemas de envío.
 * @param {object} p
 * @param {string} [p.empresaId]   empresa que envía (nombre, color y datos en la plantilla)
 * @param {string|string[]} p.para destinatario(s)
 * @param {string} p.asunto
 * @param {string} [p.html]        contenido; se envuelve en la plantilla salvo `plantilla: false`
 * @param {string} [p.texto]       versión en texto plano
 * @param {{nombre:string, mime?:string, contenido:Buffer}[]} [p.adjuntos]
 * @param {string} [p.tipo] [p.referencia] [p.usuario] {id,nombre} [p.titulo]  metadatos para el historial y la plantilla
 */
export async function enviarCorreo({ empresaId = null, para, asunto, html, texto, adjuntos = [], tipo = 'general', referencia = null, usuario = null, titulo, plantilla = true } = {}) {
  try {
    const { validos, invalidos } = normalizarDestinatarios(para);
    if (!validos.length) return { ok: false, pendiente: false, error: invalidos.length ? `Correo no válido: ${invalidos[0]}` : 'Falta el correo del destinatario' };
    if (validos.length > 20) return { ok: false, pendiente: false, error: 'Demasiados destinatarios (máximo 20)' };
    if (!asunto) return { ok: false, pendiente: false, error: 'Falta el asunto' };
    if ((adjuntos ?? []).reduce((s, a) => s + (a.contenido?.length ?? 0), 0) > 12 * 1024 * 1024) return { ok: false, pendiente: false, error: 'Los adjuntos pesan más de 12 MB' };

    const empresa = await datosEmpresa(empresaId);
    const cuerpoHtml = plantilla ? plantillaCorreo({ empresa, titulo, cuerpo: html ?? `<p>${esc(texto ?? '')}</p>` }) : (html ?? `<p>${esc(texto ?? '')}</p>`);
    const fila = { para: validos, asunto: String(asunto).slice(0, 250), html: cuerpoHtml, texto: texto ?? htmlATexto(html ?? ''), de_nombre: empresa?.nombre ?? null };

    if (!estado.db) {                                        // sin base (uso suelto): intento directo, sin cola
      if (!correoConfigurado()) return { ok: false, pendiente: true, error: PENDIENTE_CONFIG };
      try { await envioReal(fila, adjuntos ?? []); return { ok: true, pendiente: false, error: null }; }
      catch (e) { return { ok: false, pendiente: true, error: textoError(e) }; }
    }

    const { rows } = await estado.db.query(
      `insert into msg.correos (empresa_id, tipo, referencia, para, asunto, html, texto, usuario_id, usuario_nombre)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [empresaId, tipo, referencia, validos, fila.asunto, fila.html, fila.texto, usuario?.id ?? null, usuario?.nombre ?? null]);
    const id = rows[0].id;
    for (const a of adjuntos ?? []) {
      await estado.db.query('insert into msg.adjuntos (correo_id, nombre, mime, contenido) values ($1,$2,$3,$4)',
        [id, String(a.nombre ?? 'adjunto').slice(0, 120), a.mime ?? 'application/octet-stream', Buffer.from(a.contenido)]);
    }
    const r = await intentar({ ...fila, id });
    return { ...r, id };
  } catch (e) {
    return { ok: false, pendiente: false, error: textoError(e) };
  }
}

/** Reintenta la cola vencida (lo llama el temporizador y el botón «Reintentar»). Devuelve cuántos salieron. */
export async function procesarCola({ limite = 10 } = {}) {
  if (!estado.db || estado.procesando) return 0;
  estado.procesando = true;
  let salieron = 0;
  try {
    const { rows } = await estado.db.query(
      `select c.*, e.nombre as de_nombre from msg.correos c left join core.empresas e on e.id = c.empresa_id
        where c.estado = 'pendiente' and c.proximo_intento <= now() order by c.created_at limit $1`, [limite]);
    for (const f of rows) {
      if (!hayCupo()) break;
      const r = await intentar(f);
      if (r.ok) salieron += 1;
      else if (!correoConfigurado()) break;
    }
  } catch (e) { console.error('[correo] cola:', e.message); }
  finally { estado.procesando = false; }
  return salieron;
}

/** Reintento manual de un correo (pendiente o fallido). */
export async function reintentarCorreo(id) {
  if (!estado.db) return { ok: false, error: 'Sin base de datos' };
  const { rows } = await estado.db.query(
    `update msg.correos c set estado='pendiente', proximo_intento=now(), intentos=0
       from (select c2.id, e.nombre as de_nombre from msg.correos c2 left join core.empresas e on e.id = c2.empresa_id where c2.id=$1 and c2.estado <> 'enviado') s
      where c.id = s.id returning c.*, s.de_nombre`, [id]);
  if (!rows[0]) return { ok: false, error: 'Ese correo ya salió o no existe' };
  return intentar(rows[0]);
}

/** Arranca el temporizador de la cola (cada minuto). Idempotente. */
export function iniciarColaCorreo({ cada = 60_000 } = {}) {
  if (estado.temporizador) return;
  estado.temporizador = setInterval(() => { procesarCola().catch(() => {}); }, cada);
  estado.temporizador.unref?.();
}
export function detenerColaCorreo() { if (estado.temporizador) clearInterval(estado.temporizador); estado.temporizador = null; }

/** Estado para la pantalla de administración. */
export function estadoCorreo() {
  const { user } = credenciales();
  return { configurado: correoConfigurado(), remitente: user || null, maxPorMinuto: MAX_POR_MINUTO, hoy: fechaHN() };
}
