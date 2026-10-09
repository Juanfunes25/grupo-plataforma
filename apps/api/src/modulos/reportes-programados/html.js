// Reporte neutral → cuerpo HTML (y texto) del correo. Estilos en línea: los clientes de correo no leen hojas de estilo.
import { escaparHtml as e } from '../../lib/correo.js';
import { textoCelda } from './pdf.js';

const FILAS_MAX = 12;

export function reporteAHtml(rep, { adjuntos = [] } = {}) {
  const kpis = (rep.resumen ?? []).map((k) =>
    `<td style="padding:8px 14px 8px 0;vertical-align:top"><div style="font-size:11px;color:#7a716a">${e(k.etiqueta)}</div><div style="font-size:18px;font-weight:bold;color:#2b2622">${e(textoCelda(k.tipo, k.valor))}</div></td>`);
  const filasKpi = [];
  for (let i = 0; i < kpis.length; i += 2) filasKpi.push(`<tr>${kpis.slice(i, i + 2).join('')}</tr>`);
  const secciones = (rep.secciones ?? []).map((s) => {
    const cols = s.columnas.slice(0, 5);   // en el correo solo lo esencial; el detalle completo va en el adjunto
    const num = (c) => c.tipo !== 'texto' && c.tipo !== 'fecha';
    const cab = cols.map((c) => `<th style="text-align:${num(c) ? 'right' : 'left'};padding:6px 8px;background:#2f2a26;color:#fff;font-size:12px">${e(c.titulo)}</th>`).join('');
    const cuerpo = s.filas.slice(0, FILAS_MAX).map((f, i) => `<tr style="background:${i % 2 ? '#faf8f5' : '#fff'}">${cols.map((c) =>
      `<td style="text-align:${num(c) ? 'right' : 'left'};padding:5px 8px;font-size:13px;border-bottom:1px solid #eee">${e(textoCelda(c.tipo, f[c.clave]))}</td>`).join('')}</tr>`).join('');
    const mas = s.filas.length > FILAS_MAX ? `<p style="font-size:12px;color:#7a716a;margin:4px 0 0">y ${s.filas.length - FILAS_MAX} más: están en el archivo adjunto.</p>` : '';
    return `<h3 style="margin:18px 0 6px;font-size:15px">${e(s.titulo)}</h3><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${cab}</tr>${cuerpo}</table>${mas}`;
  }).join('');
  const notas = (rep.notas ?? []).map((t) => `<p style="font-size:12px;color:#7a716a;margin:10px 0 0">${e(t)}</p>`).join('');
  const adj = adjuntos.length ? `<p style="font-size:13px;margin:14px 0 0">Adjuntos: ${adjuntos.map((a) => e(a.nombre)).join(', ')}</p>` : '';
  return `<p style="margin:0 0 8px;color:#7a716a">${e(rep.subtitulo ?? '')}</p><table role="presentation" cellpadding="0" cellspacing="0">${filasKpi.join('')}</table>${secciones}${notas}${adj}`;
}

export function reporteATexto(rep) {
  const l = [rep.titulo, rep.subtitulo ?? '', ''];
  for (const k of rep.resumen ?? []) l.push(`${k.etiqueta}: ${textoCelda(k.tipo, k.valor)}`);
  for (const s of rep.secciones ?? []) {
    l.push('', s.titulo.toUpperCase());
    for (const f of s.filas.slice(0, FILAS_MAX)) l.push(s.columnas.slice(0, 5).map((c) => textoCelda(c.tipo, f[c.clave])).join(' | '));
    if (s.filas.length > FILAS_MAX) l.push(`... y ${s.filas.length - FILAS_MAX} más (en el adjunto)`);
  }
  for (const t of rep.notas ?? []) l.push('', t);
  return l.join('\n');
}
