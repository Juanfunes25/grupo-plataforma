import { z } from 'zod';
import { permisosDe, fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { validar } from '../../lib/http.js';
import { checklist, kpis, proximos } from '../documentos/servicio.js';

/** Dirección: consolidado de documentos de las empresas que el usuario puede ver (vencimientos, faltantes por empresa). */
export function montarDocumentos(r, { db }, empresasConsolidables) {
  r.get('/documentos', requierePermiso('grupo:ver'), async (req, res) => {
    const { dias } = validar(z.object({ dias: z.coerce.number().int().min(1).max(365).default(90) }), req.query);
    const u = req.ctx.usuario;
    const hoy = fechaHN();
    const accesos = (await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id])).rows;
    const empresas = [];
    for (const e of await empresasConsolidables(u)) {
      const a = accesos.find((x) => x.empresa_id === e.id);
      const rol = u.es_dueno_grupo ? 'dueno' : a?.rol;
      if (!rol || !(u.es_dueno_grupo || permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('doc:ver'))) continue;
      const o = { hoy, verRestringido: rol === 'dueno' || rol === 'admin' };
      const [k, cl, prox] = await Promise.all([kpis(db, e.id, o), checklist(db, e, o), proximos(db, e.id, { ...o, dias })]);
      empresas.push({
        codigo: e.codigo, nombre: e.nombre, color: e.color, kpis: k,
        checklist: { resumen: cl.resumen, faltantes: cl.items.filter((i) => i.estado === 'falta' || i.estado === 'vencido') },
        proximos: prox.map((d) => ({ ...d, empresa: e.codigo, empresa_nombre: e.nombre, empresa_color: e.color })),
      });
    }
    const suma = (f) => empresas.reduce((s, e) => s + f(e), 0);
    res.json({
      hoy, dias, empresas,
      total: {
        vigentes: suma((e) => e.kpis.vigentes), vencidos: suma((e) => e.kpis.vencidos), d30: suma((e) => e.kpis.d30), d60: suma((e) => e.kpis.d60), d90: suma((e) => e.kpis.d90),
        faltan: suma((e) => e.checklist.resumen.falta), sin_vigente: suma((e) => e.checklist.resumen.vencido),
      },
      proximos: empresas.flatMap((e) => e.proximos).sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento)),
    });
  });
}
