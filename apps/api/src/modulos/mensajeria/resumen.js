// Resumen diario del dueño por correo: lo importante del día de las cuatro empresas en un solo mensaje.
import { fechaHN, horaDeHN, sumarDias, lempiras } from '@grupo/shared';
import { enviarCorreo, correoConfigurado, escaparHtml as esc } from '../../lib/correo.js';
import { reglaDe, destinatariosDe, reclamar } from './avisos.js';
import { datosResumenEmpresa } from './reglas.js';

/** Si la hora de envío es de tarde/noche (17:00 o más) el resumen es del día de hoy; si es de mañana, el de ayer. */
export const HORA_CORTE_HOY = 17;
export const diaDelResumen = (ahora, hora) => (hora >= HORA_CORTE_HOY ? fechaHN(ahora) : sumarDias(fechaHN(ahora), -1));

const nombreDia = (f) => new Date(`${f}T12:00:00Z`).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const h2 = (t, c) => `<h2 style="margin:22px 0 6px;font-size:16px;color:${c};border-bottom:2px solid ${c};padding-bottom:3px">${esc(t)}</h2>`;
const ul = (items) => (items.length ? `<ul style="margin:4px 0 8px;padding-left:20px">${items.map((i) => `<li style="margin:2px 0">${esc(i)}</li>`).join('')}</ul>` : '');
const nada = (t) => `<p style="margin:4px 0;color:#7a716a">${esc(t)}</p>`;

export async function empresasActivas(db) {
  const { rows } = await db.query('select * from core.empresas where activo order by orden');
  const mods = await db.query('select empresa_id, modulo from core.empresa_modulos where activo');
  return rows.map((e) => ({ ...e, modulos: mods.rows.filter((m) => m.empresa_id === e.id).map((m) => m.modulo) }));
}

export function htmlResumen({ fecha, empresas }) {
  const totalGrupo = empresas.reduce((s, e) => s + e.ventas.total, 0);
  const facturas = empresas.reduce((s, e) => s + e.ventas.facturas, 0);
  const partes = [`<p style="margin:0 0 4px">Así cerró <strong>${esc(nombreDia(fecha))}</strong>:</p>
<p style="margin:0 0 6px;font-size:24px;font-weight:bold">${esc(lempiras(totalGrupo))} <span style="font-size:13px;font-weight:normal;color:#7a716a">en ${facturas} factura${facturas === 1 ? '' : 's'} (suma de las empresas)</span></p>`];
  for (const e of empresas) {
    const color = /^#[0-9a-f]{3,8}$/i.test(e.empresa.color ?? '') ? e.empresa.color : '#2f2a26';
    partes.push(h2(e.empresa.nombre, color));
    partes.push(`<p style="margin:4px 0"><strong>Ventas: ${esc(lempiras(e.ventas.total))}</strong> · ${e.ventas.facturas} factura${e.ventas.facturas === 1 ? '' : 's'}</p>`);
    partes.push(e.ventas.sucursales.length ? ul(e.ventas.sucursales.map((s) => `${s.sucursal}: ${lempiras(s.total)} (${s.facturas})`)) : nada('Sin ventas registradas.'));
    // Cierres de caja
    const c = e.cierres;
    const lineasCierre = c.hechos.map((x) => `${x.sucursal}: ${Math.abs(x.diferencia) < 0.005 ? 'cuadrado' : `${x.diferencia < 0 ? 'faltante' : 'sobrante'} de ${lempiras(Math.abs(x.diferencia))}`}`);
    if (c.hechos.length || c.sin_cierre.length) {
      partes.push(`<p style="margin:8px 0 2px"><strong>Cierres de caja</strong></p>${ul(lineasCierre)}`);
      if (c.sin_cierre.length) partes.push(`<p style="margin:2px 0;color:#a02a1c">Vendieron pero no hicieron cierre: ${esc(c.sin_cierre.join(', '))}</p>`);
    }
    // Gelato
    if (e.gelato) {
      const g = e.gelato;
      if (g.sin_pesar) partes.push(g.sin_pesar.length ? `<p style="margin:8px 0 2px;color:#a02a1c"><strong>Tiendas que no pesaron (noche del ${esc(g.noche)}):</strong> ${esc(g.sin_pesar.join(', '))}</p>` : '<p style="margin:8px 0 2px">Todas las tiendas pesaron.</p>');
      const d = Object.entries(g.despachos);
      if (d.length) partes.push(`<p style="margin:6px 0 2px"><strong>Despachos:</strong> ${esc(d.map(([est, v]) => `${v.n} ${est.replace('_', ' ')}`).join(' · '))}</p>`);
    }
    // Alertas y vencimientos
    const af = e.antifraude;
    if (af.total) partes.push(`<p style="margin:8px 0 2px"><strong>Antifraude:</strong> ${af.total} alerta${af.total === 1 ? '' : 's'} (${esc(Object.entries(af.por_severidad).map(([s, n]) => `${n} ${s}`).join(', '))})</p>`);
    if (e.cai.length) partes.push(`<p style="margin:8px 0 2px"><strong>CAI:</strong></p>${ul(e.cai.map((x) => x.texto))}`);
    const dv = [...e.documentos.vencidos, ...e.documentos.por_vencer].map((x) => x.texto);
    if (dv.length) partes.push(`<p style="margin:8px 0 2px"><strong>Documentos por atender (${dv.length}):</strong></p>${ul(dv.slice(0, 8))}${dv.length > 8 ? nada(`…y ${dv.length - 8} más`) : ''}`);
  }
  partes.push('<p style="margin:22px 0 0;color:#7a716a;font-size:12px">Etapa de pruebas: las facturas todavía son borradores sin valor fiscal. Puedes cambiar la hora y los destinatarios en Administración, Correo y avisos.</p>');
  return partes.join('\n');
}

export async function armarResumen(db, { fecha, ahora = new Date() }) {
  const hoy = fechaHN(ahora);
  const empresas = [];
  for (const e of await empresasActivas(db)) empresas.push(await datosResumenEmpresa(db, e, { fecha, hoy }));
  return { fecha, empresas };
}

/**
 * Manda el resumen si ya es la hora configurada y hoy no se ha enviado (idempotente por día, aunque haya reinicios o dos instancias).
 * `forzar` = botón «Enviar ahora»: ignora la hora y la marca del día.
 */
export async function enviarResumenDiario({ db, ahora = new Date(), forzar = false, usuario = null, para = null }) {
  if (!forzar && !correoConfigurado()) return { enviado: false, motivo: 'correo sin configurar' };
  const regla = await reglaDe(db, null, 'resumen_diario');
  if (!forzar) {
    if (!regla.activo) return { enviado: false, motivo: 'desactivado' };
    if (horaDeHN(ahora) < (regla.hora ?? 7)) return { enviado: false, motivo: 'aún no es la hora' };
  }
  const destinatarios = para ?? await destinatariosDe(db, regla);
  if (!destinatarios.length) return { enviado: false, motivo: 'sin destinatarios' };
  const hoy = fechaHN(ahora);
  if (!forzar && !(await reclamar(db, `resumen:${hoy}`, { horas: 20, ahora }))) return { enviado: false, motivo: 'ya enviado hoy' };
  const fecha = diaDelResumen(ahora, regla.hora ?? 7);
  const datos = await armarResumen(db, { fecha, ahora });
  const total = datos.empresas.reduce((s, e) => s + e.ventas.total, 0);
  const r = await enviarCorreo({
    para: destinatarios, tipo: 'resumen', referencia: `resumen:${fecha}`, usuario,
    asunto: `Resumen del día ${fecha}: ${lempiras(total)} en el grupo`, titulo: 'Resumen diario', html: htmlResumen(datos),
  });
  return { enviado: r.ok, pendiente: r.pendiente, error: r.error, fecha, destinatarios };
}
