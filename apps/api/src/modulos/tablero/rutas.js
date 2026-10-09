import { Router } from 'express';
import { permisosDe } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { alertasEmpresa, tableroEmpresa } from './consultas.js';
import { r2 } from './calculo.js';

/** Qué familias de alertas puede ver quien consulta, según sus permisos en esa empresa. */
export const alertasVisibles = (permisos, rol) => ({
  cai: permisos.has('pos:fiscal') || permisos.has('pos:reportes'),
  inventario: permisos.has('inv:ver'),
  caja: permisos.has('pos:reportes'),
  antifraude: permisos.has('antifraude:ver'),
  documentos: permisos.has('doc:ver'),
  restringidos: rol === 'dueno' || rol === 'admin',
});

/** /api/tablero — el tablero del dueño y de la gerencia, pensado para el celular. */
export function rutasTablero({ db, ctxMgr }) {
  const r = Router();

  /** Empresas que ESTE usuario puede consolidar (grupo:ver en cada una), con su rol. */
  async function consolidables(u) {
    const todas = await ctxMgr.empresas();
    if (u.es_dueno_grupo) return todas.map((e) => ({ ...e, rol: 'dueno', permisos: permisosDe('dueno') }));
    const { rows } = await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id]);
    return todas.map((e) => {
      const a = rows.find((x) => x.empresa_id === e.id);
      return a ? { ...e, rol: a.rol, permisos: permisosDe(a.rol, a.permisos_extra, a.permisos_quitados) } : null;
    }).filter((e) => e && e.permisos.has('grupo:ver'));
  }

  // Empresa activa. Las sucursales visibles salen del acceso (nunca del cliente).
  r.get('/', requierePermiso('pos:reportes'), async (req, res) => {
    const base = await tableroEmpresa(db, { empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds });
    const alertas = await alertasEmpresa(db, {
      empresaId: req.ctx.empresa.id, sucursalIds: req.ctx.sucursalIds, hoy: base.fecha, ver: alertasVisibles(req.ctx.permisos, req.ctx.rol) });
    res.json({ empresa: { codigo: req.ctx.empresa.codigo, nombre: req.ctx.empresa.nombre, color: req.ctx.empresa.color }, ...base, alertas });
  });

  // Dirección del Grupo: las empresas que el usuario puede consolidar, con acceso directo a cada una.
  r.get('/grupo', requierePermiso('grupo:ver'), async (req, res) => {
    const empresas = await consolidables(req.ctx.usuario);
    const filas = await Promise.all(empresas.map(async (e) => {
      const base = await tableroEmpresa(db, { empresaId: e.id });
      const alertas = await alertasEmpresa(db, { empresaId: e.id, empresaNombre: e.nombre, hoy: base.fecha, ver: { ...alertasVisibles(e.permisos, e.rol), restringidos: e.rol === 'dueno' || e.rol === 'admin' } });
      return { codigo: e.codigo, nombre: e.nombre, color: e.color, tipo_negocio: e.tipo_negocio, ...base, alertas };
    }));
    const suma = (f) => r2(filas.reduce((s, e) => s + f(e), 0));
    const total = {
      hoy: suma((e) => e.hoy.total), ayer: suma((e) => e.ayer.total), ayer_misma_hora: suma((e) => e.ayer.total_corte),
      semana_pasada: suma((e) => e.semana_pasada.total), semana_misma_hora: suma((e) => e.semana_pasada.total_corte),
      facturas_hoy: filas.reduce((s, e) => s + e.hoy.facturas, 0),
    };
    const tendencia = filas[0]?.tendencia.map((t, i) => ({ fecha: t.fecha, dia: t.dia, total: r2(filas.reduce((s, e) => s + e.tendencia[i].total, 0)) })) ?? [];
    res.json({ fecha: filas[0]?.fecha ?? null, hora_corte: filas[0]?.hora_corte ?? null, empresas: filas, total, tendencia });
  });
  return r;
}

