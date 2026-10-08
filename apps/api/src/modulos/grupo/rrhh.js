// Recursos humanos en Dirección del grupo: personal de TODAS las empresas que el usuario puede consolidar.
// Lectura aquí; las ediciones de la ficha van al API de la empresa del empleado (permiso rrhh:editar allí).
import { z } from 'zod';
import { permisosDe, fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { noEncontrado, uuid, validar, fechaISO } from '../../lib/http.js';
import { armarFicha } from '../rrhh/ficha.js';
import { calendario, directorio, resumen } from '../rrhh/consultas.js';
import { ESTADOS } from '../rrhh/comun.js';

export function montarRrhhGrupo(r, { db }, empresasConsolidables) {
  /** Permisos efectivos por empresa del usuario: { empresa_id → Set }. El dueño del grupo lo tiene todo. */
  async function permisosPorEmpresa(u, empresas) {
    const mapa = new Map();
    if (u.es_dueno_grupo) { for (const e of empresas) mapa.set(e.id, permisosDe('dueno')); return mapa; }
    const { rows } = await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id]);
    for (const a of rows) mapa.set(a.empresa_id, permisosDe(a.rol, a.permisos_extra, a.permisos_quitados));
    return mapa;
  }
  const contexto = async (req) => {
    const empresas = await empresasConsolidables(req.ctx.usuario);
    const perms = await permisosPorEmpresa(req.ctx.usuario, empresas);
    return { empresas, ids: empresas.map((e) => e.id), perms, sensibles: new Set(empresas.filter((e) => perms.get(e.id)?.has('rrhh:sensible')).map((e) => e.id)) };
  };

  r.get('/rrhh/directorio', requierePermiso('grupo:ver'), async (req, res) => {
    const f = validar(z.object({
      q: z.string().trim().max(80).optional(), empresa: z.string().max(30).optional(), sucursal_id: uuid.optional(), cargo: z.string().trim().max(80).optional(),
      estado: z.enum(ESTADOS).optional(), vence: z.enum(['30', '60', '90', 'vencidos']).optional(),
    }), req.query);
    const c = await contexto(req);
    res.json({ ...(await directorio(db, { empresaIds: c.ids, sensibles: c.sensibles, filtros: f })), empresas: c.empresas.map((e) => ({ codigo: e.codigo, nombre: e.nombre, color: e.color })) });
  });
  r.get('/rrhh/resumen', requierePermiso('grupo:ver'), async (req, res) => {
    const c = await contexto(req);
    res.json(await resumen(db, { empresaIds: c.ids }));
  });
  r.get('/rrhh/calendario', requierePermiso('grupo:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const c = await contexto(req);
    res.json(await calendario(db, { empresaIds: c.ids, desde: f.desde ?? `${hoy.slice(0, 8)}01`, hasta: f.hasta ?? sumarDias(hoy, 60) }));
  });
  r.get('/rrhh/empleados/:id', requierePermiso('grupo:ver'), async (req, res) => {
    const c = await contexto(req);
    const id = validar(uuid, req.params.id);
    const emp = (await db.query('select empresa_id from rrhh.empleados where id = $1', [id])).rows[0];
    if (!emp || !c.ids.includes(emp.empresa_id)) throw noEncontrado('Empleado no encontrado');
    const p = c.perms.get(emp.empresa_id);
    const ficha = await armarFicha(db, { empleadoId: id, empresaId: emp.empresa_id, permisos: { editar: p?.has('rrhh:editar'), sensible: p?.has('rrhh:sensible') } });
    res.json(ficha);
  });
}
