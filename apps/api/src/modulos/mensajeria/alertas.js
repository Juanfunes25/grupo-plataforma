// Alertas por correo: reglas simples, un correo agrupado por tipo y empresa, y como máximo uno cada N horas.
import { fechaHN } from '@grupo/shared';
import { enviarCorreo, correoConfigurado, escaparHtml as esc } from '../../lib/correo.js';
import { TIPOS_AVISO, reglaDe, destinatariosDe, reclamar, estadoClave } from './avisos.js';
import { nocheDeLaManana, tiendasSinPesar, caiPorVencer, documentosPorVencer, antifraudeAltas, descuadresDeCaja } from './reglas.js';

const lista = (items) => `<ul style="margin:8px 0 14px;padding-left:20px">${items.map((i) => `<li style="margin:3px 0">${esc(i)}</li>`).join('')}</ul>`;

/** Cada evaluador devuelve null (nada que avisar) o { titulo, intro, items, marca? } (`marca` = hasta dónde se avisó, para no repetir). */
const EVALUADORES = {
  async tienda_sin_pesar({ db, empresa, ahora }) {
    const noche = nocheDeLaManana(ahora);
    if (!noche) return null;
    const t = await tiendasSinPesar(db, empresa.id, noche);
    if (!t.length) return null;
    return { titulo: `${t.length} tienda${t.length === 1 ? '' : 's'} sin pesar`, intro: `No pesaron el gelato de la noche del ${noche} y ya es la mañana de despacho:`, items: t.map((x) => x.nombre) };
  },
  async cai({ db, empresa, ahora }) {
    const c = await caiPorVencer(db, empresa.id, { hoy: fechaHN(ahora) });
    if (!c.length) return null;
    return { titulo: 'CAI por vencer o agotarse', intro: 'Estos puntos de emisión necesitan un CAI nuevo pronto (pide el nuevo rango al SAR):', items: c.map((x) => x.texto) };
  },
  async documentos({ db, empresa, ahora }) {
    const d = await documentosPorVencer(db, empresa, { hoy: fechaHN(ahora) });
    const items = [...d.vencidos, ...d.por_vencer].map((x) => x.texto);
    if (!items.length) return null;
    return { titulo: `${items.length} documento${items.length === 1 ? '' : 's'} por atender`, intro: 'Documentos vencidos o dentro de su plazo de aviso:', items: items.slice(0, 25) };
  },
  async antifraude({ db, empresa, previo }) {
    const desde = Number(previo?.detalle) || 0;
    const a = await antifraudeAltas(db, empresa.id, { desdeId: desde });
    if (!a.length) return null;
    return { titulo: `${a.length} alerta${a.length === 1 ? '' : 's'} alta${a.length === 1 ? '' : 's'} del antifraude`, intro: 'Siguen pendientes de revisar (entra a Antifraude para verlas y resolverlas):', items: a.map((x) => x.texto), marca: String(Math.max(...a.map((x) => x.id))) };
  },
  async descuadre_caja({ db, empresa, previo, regla, ahora }) {
    const desde = previo?.detalle || new Date(ahora.getTime() - 24 * 3_600_000).toISOString();
    const d = await descuadresDeCaja(db, empresa.id, { desde, umbral: regla.umbral ?? 50 });
    if (!d.length) return null;
    return { titulo: `${d.length} cierre${d.length === 1 ? '' : 's'} de caja con diferencia`, intro: `Diferencias de L ${regla.umbral ?? 50} o más:`, items: d.map((x) => x.texto), marca: ahora.toISOString() };
  },
};

function aplica(def, empresa) {
  if (!def.solo) return true;
  return def.solo.some((m) => empresa.modulos?.includes(m));
}

/**
 * Evalúa todas las reglas por empresa y manda los correos que toquen. Idempotente: la clave en msg.avisos_estado
 * impide repetir antes de `horas_entre`. Sin Gmail configurado no hace nada (así no se acumulan avisos viejos).
 * @returns {Promise<{tipo:string, empresa:string, ok:boolean}[]>} lo que se envió
 */
export async function evaluarAlertas({ db, empresas, ahora = new Date(), tipos = null }) {
  const enviados = [];
  if (!correoConfigurado()) return enviados;
  for (const empresa of empresas) {
    for (const [tipo, def] of Object.entries(TIPOS_AVISO)) {
      if (def.ambito !== 'empresa' || (tipos && !tipos.includes(tipo)) || !aplica(def, empresa)) continue;
      try {
        const regla = await reglaDe(db, empresa.id, tipo);
        if (!regla.activo) continue;
        const clave = `alerta:${tipo}:${empresa.id}`;
        const previo = await estadoClave(db, clave);
        if (previo && ahora.getTime() - new Date(previo.ultimo_at).getTime() < regla.horas_entre * 3_600_000) continue;   // aún en pausa
        const hallazgo = await EVALUADORES[tipo]({ db, empresa, ahora, previo, regla });
        if (!hallazgo) continue;
        const para = await destinatariosDe(db, regla);
        if (!para.length) continue;
        if (!(await reclamar(db, clave, { horas: regla.horas_entre, detalle: hallazgo.marca ?? previo?.detalle ?? null, ahora }))) continue;
        const r = await enviarCorreo({
          empresaId: empresa.id, para, tipo: 'alerta', referencia: clave,
          asunto: `Aviso ${empresa.nombre}: ${hallazgo.titulo}`, titulo: hallazgo.titulo,
          html: `<p style="margin:0 0 6px">${esc(hallazgo.intro)}</p>${lista(hallazgo.items)}<p style="margin:0;color:#7a716a;font-size:12px">Para no llenarte el correo, este aviso se repite como máximo cada ${regla.horas_entre} horas. Puedes cambiar destinatarios y frecuencia en Administración, Correo y avisos.</p>`,
        });
        enviados.push({ tipo, empresa: empresa.codigo ?? empresa.nombre, ok: r.ok });
      } catch (e) {
        console.error(`[avisos] ${tipo} ${empresa.nombre}:`, e.message);
      }
    }
  }
  return enviados;
}

// ── Errores graves ────────────────────────────────────────────────────────────
const pila = [];
/** Lo llama el manejador de errores del API con cada error 500. Solo guarda en memoria; el planificador agrupa y envía. */
export function registrarErrorGrave(req, err) {
  pila.push({ cuando: new Date(), ruta: `${req?.method ?? ''} ${String(req?.originalUrl ?? '').split('?')[0]}`.trim(), mensaje: String(err?.message ?? err).slice(0, 200), empresa: req?.ctx?.empresa?.nombre ?? null });
  if (pila.length > 50) pila.shift();
}
export const erroresPendientes = () => pila.length;

export async function avisarErroresGraves({ db, ahora = new Date() }) {
  if (!pila.length || !correoConfigurado()) return null;
  const regla = await reglaDe(db, null, 'error_grave');
  if (!regla.activo) { pila.length = 0; return null; }
  const para = await destinatariosDe(db, regla);
  if (!para.length) return null;
  if (!(await reclamar(db, 'alerta:error_grave', { horas: regla.horas_entre, ahora }))) return null;
  const items = pila.splice(0).map((e) => `${e.cuando.toISOString().slice(11, 16)} UTC · ${e.ruta}${e.empresa ? ` (${e.empresa})` : ''}: ${e.mensaje}`);
  return enviarCorreo({
    para, tipo: 'alerta', referencia: 'alerta:error_grave', asunto: `Aviso: ${items.length} error${items.length === 1 ? '' : 'es'} grave${items.length === 1 ? '' : 's'} en la plataforma`,
    titulo: 'Errores graves del sistema', html: `<p style="margin:0 0 6px">El sistema registró estos errores internos:</p>${lista(items)}<p style="margin:0;color:#7a716a;font-size:12px">Se agrupan y se avisan como máximo cada ${regla.horas_entre} horas.</p>`,
  });
}
