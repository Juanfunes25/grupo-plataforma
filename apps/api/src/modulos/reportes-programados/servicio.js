// Generación de archivos y envío por correo de un reporte (lo comparten las rutas y el programador).
import { fechaHN, permisosDe } from '@grupo/shared';
import { enviarCorreo } from '../../lib/correo.js';
import { generarReporte } from './catalogo.js';
import { MIME_XLSX, reporteAExcel } from './excel.js';
import { MIME_PDF, reporteAPdf } from './pdf.js';
import { reporteAHtml, reporteATexto } from './html.js';

export const FORMATOS = ['xlsx', 'pdf'];
const slug = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'reporte';

/** Archivos del reporte en los formatos pedidos: [{ nombre, mime, contenido }]. */
export async function armarArchivos(rep, formatos, { fecha = fechaHN(), nombreBase = rep.tipo } = {}) {
  const base = `${slug(nombreBase)}-${fecha}`;
  const out = [];
  if (formatos.includes('xlsx')) out.push({ nombre: `${base}.xlsx`, mime: MIME_XLSX, contenido: await reporteAExcel(rep) });
  if (formatos.includes('pdf')) out.push({ nombre: `${base}.pdf`, mime: MIME_PDF, contenido: reporteAPdf(rep) });
  return out;
}

/** Empresas que un usuario puede consolidar (dueño del grupo: todas; otros: donde tengan grupo:ver). */
export async function empresasConsolidablesDe(db, usuarioId) {
  const u = (await db.query('select es_dueno_grupo, activo from core.usuarios where id = $1', [usuarioId])).rows[0];
  if (!u?.activo) return [];
  const todas = (await db.query('select * from core.empresas where activo order by orden')).rows;
  if (u.es_dueno_grupo) return todas;
  const { rows } = await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [usuarioId]);
  return todas.filter((e) => { const a = rows.find((x) => x.empresa_id === e.id); return a && permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('grupo:ver'); });
}

/** ¿Sigue pudiendo programar reportes quien lo creó? (activo y con el permiso en esa empresa) */
export async function creadorVigente(db, usuarioId, empresaId) {
  if (!usuarioId) return false;
  const u = (await db.query('select es_dueno_grupo, activo from core.usuarios where id = $1', [usuarioId])).rows[0];
  if (!u?.activo) return false;
  if (u.es_dueno_grupo) return true;
  const a = (await db.query('select rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and empresa_id = $2 and activo', [usuarioId, empresaId])).rows[0];
  return Boolean(a) && permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('reportes:programar');
}

/**
 * Genera el reporte de una programación y lo envía. `enviar` se puede sustituir en pruebas.
 * Devuelve { estado: enviado | pendiente_correo | error | sin_datos, detalle, archivos, destinatarios }.
 */
export async function correrProgramado(db, p, { ahora = new Date(), enviar = enviarCorreo, forzar = false } = {}) {
  const hoy = fechaHN(ahora);
  if (!forzar && !(await creadorVigente(db, p.creado_por, p.empresa_id))) {
    return { estado: 'error', detalle: 'Quien programó este reporte ya no tiene permiso o fue desactivado. Vuelve a guardarlo con un usuario autorizado.', archivos: [], destinatarios: p.destinatarios };
  }
  const empresa = (await db.query('select * from core.empresas where id = $1', [p.empresa_id])).rows[0];
  const empresasGrupo = p.ambito === 'grupo' ? await empresasConsolidablesDe(db, p.creado_por) : [];
  const rep = await generarReporte(p.tipo, { db, empresa, sucursalIds: [], hoy, params: p.parametros ?? {}, restringidos: true, empresasGrupo });
  if (rep.vacio && rep.omitirSiVacio && !forzar) return { estado: 'sin_datos', detalle: 'No había nada que reportar: no se envió correo.', archivos: [], destinatarios: p.destinatarios };
  const archivos = await armarArchivos(rep, p.formatos, { fecha: hoy, nombreBase: p.tipo });
  const r = await enviar({
    empresaId: p.empresa_id, para: p.destinatarios, asunto: `${p.nombre} - ${hoy}`, titulo: rep.titulo,
    html: reporteAHtml(rep, { adjuntos: archivos }), texto: reporteATexto(rep), adjuntos: archivos, tipo: 'reporte_programado', referencia: p.id,
  });
  const meta = archivos.map((a) => ({ nombre: a.nombre, mime: a.mime, bytes: a.contenido.length }));
  if (r?.ok) return { estado: 'enviado', detalle: `Enviado a ${p.destinatarios.length} destinatario(s).`, archivos: meta, destinatarios: p.destinatarios };
  if (r?.pendiente) return { estado: 'pendiente_correo', detalle: r.error || 'Pendiente de configurar el correo (GMAIL_USER y GMAIL_APP_PASSWORD): saldrá solo cuando se configure.', archivos: meta, destinatarios: p.destinatarios };
  return { estado: 'error', detalle: r?.error || 'No se pudo enviar el correo.', archivos: meta, destinatarios: p.destinatarios };
}
