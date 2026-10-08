import { Router } from 'express';
import { z } from 'zod';
import { permisosDe, fechaHN, sumarDias } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { fechaISO, validar } from '../../lib/http.js';
import { resultadosEmpresa } from '../fin/rutas.js';
import { montarExtras } from './extras.js';
import { montarRrhhGrupo } from './rrhh.js';
import { montarDocumentos } from './documentos.js';

export function rutasGrupo({ db, ctxMgr }) {
  const r = Router();

  /** Empresas del grupo que ESTE usuario puede consolidar (grupo:ver en cada una). */
  async function empresasConsolidables(u) {
    const todas = await ctxMgr.empresas();
    if (u.es_dueno_grupo) return todas;
    const { rows } = await db.query('select empresa_id, rol, permisos_extra, permisos_quitados from core.accesos where usuario_id = $1 and activo', [u.id]);
    return todas.filter((e) => {
      const a = rows.find((x) => x.empresa_id === e.id);
      return a && permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('grupo:ver');
    });
  }

  // Tablero de dirección: lo que antes eran 4 sistemas separados, en una sola llamada.
  r.get('/resumen', requierePermiso('grupo:ver'), async (req, res) => {
    const f = validar(z.object({ desde: fechaISO.optional(), hasta: fechaISO.optional() }), req.query);
    const hoy = fechaHN();
    const desde = f.desde ?? `${hoy.slice(0, 8)}01`, hasta = f.hasta ?? hoy;
    const empresas = await empresasConsolidables(req.ctx.usuario);
    if (!empresas.length) return res.json({ desde, hasta, empresas: [], total: null });
    const ids = empresas.map((e) => e.id);

    const [res_, dias, suc, interco, hoyRows] = await Promise.all([
      Promise.all(empresas.map((e) => resultadosEmpresa(db, { empresaId: e.id, desde, hasta }))),
      db.query(`select v.empresa_id, (v.fecha_emision at time zone 'America/Tegucigalpa')::date::text as fecha, sum(v.total)::numeric as total
                  from pos.ventas v where v.estado = 'pagada' and v.empresa_id = any($1::uuid[])
                   and (v.fecha_emision at time zone 'America/Tegucigalpa')::date between $2::date and $3::date group by 1, 2 order by 2`, [ids, desde, hasta]),
      db.query(`select v.empresa_id, s.nombre as sucursal, count(*)::int as facturas, sum(v.total)::numeric as total
                  from pos.ventas v join core.sucursales s on s.id = v.sucursal_id where v.estado = 'pagada' and v.empresa_id = any($1::uuid[])
                   and (v.fecha_emision at time zone 'America/Tegucigalpa')::date between $2::date and $3::date group by 1, 2 order by 4 desc`, [ids, desde, hasta]),
      db.query(`select empresa_origen_id, empresa_destino_id, coalesce(sum(monto),0)::numeric as monto from fin.intercompania
                 where fecha between $1::date and $2::date and empresa_origen_id = any($3::uuid[]) and empresa_destino_id = any($3::uuid[]) group by 1, 2`, [desde, hasta, ids]),
      db.query(`select v.empresa_id, count(*)::int as facturas, coalesce(sum(v.total),0)::numeric as total
                  from pos.ventas v where v.estado = 'pagada' and v.empresa_id = any($1::uuid[])
                   and (v.fecha_emision at time zone 'America/Tegucigalpa')::date = $2::date group by 1`, [ids, hoy]),
    ]);

    const porEmpresa = empresas.map((e, i) => ({
      codigo: e.codigo, nombre: e.nombre, color: e.color, tipo_negocio: e.tipo_negocio, ...res_[i],
      hoy: hoyRows.rows.find((x) => x.empresa_id === e.id) ?? { facturas: 0, total: 0 },
      serie: dias.rows.filter((d) => d.empresa_id === e.id).map((d) => ({ fecha: d.fecha, total: d.total })),
      sucursales: suc.rows.filter((s) => s.empresa_id === e.id).map(({ sucursal, facturas, total }) => ({ sucursal, facturas, total })),
    }));
    const suma = (k) => Math.round(porEmpresa.reduce((s, e) => s + (e[k] ?? 0), 0) * 100) / 100;
    // Lo que una empresa le vende a otra del grupo se resta del consolidado (si no, se contaría dos veces).
    const eliminacion = Math.round(interco.rows.reduce((s, x) => s + x.monto, 0) * 100) / 100;
    const total = {
      ventas_netas: suma('ventas_netas'), eliminacion_intercompania: eliminacion, ventas_netas_consolidadas: Math.round((suma('ventas_netas') - eliminacion) * 100) / 100,
      costo_ventas: suma('costo_ventas'), utilidad_bruta: suma('utilidad_bruta'), gastos_operativos: suma('gastos_operativos'), utilidad_operativa: suma('utilidad_operativa'),
      facturas: porEmpresa.reduce((s, e) => s + e.facturas, 0),
      hoy: Math.round(porEmpresa.reduce((s, e) => s + e.hoy.total, 0) * 100) / 100,
    };
    res.json({ desde, hasta, empresas: porEmpresa, total });
  });

  // Alertas transversales: CAI por vencer, stock negativo, perecederos por vencer, turnos abiertos desde ayer.
  r.get('/alertas', requierePermiso('grupo:ver'), async (req, res) => {
    const empresas = await empresasConsolidables(req.ctx.usuario);
    const ids = empresas.map((e) => e.id);
    const hoy = fechaHN();
    const [cai, neg, ven, turnos] = await Promise.all([
      db.query(`select e.nombre as empresa, s.nombre as sucursal, pe.fecha_limite_emision::text as vence, (pe.correlativo_hasta - pe.correlativo_actual + 1) as restantes
                  from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id join core.empresas e on e.id = pe.empresa_id
                 where pe.empresa_id = any($1::uuid[]) and pe.activo and not pe.es_borrador
                   and (pe.fecha_limite_emision <= $2::date or (pe.correlativo_hasta - pe.correlativo_actual + 1) <= (pe.correlativo_hasta - pe.correlativo_desde + 1) * 0.1)`, [ids, sumarDias(hoy, 15)]),
      db.query(`select e.nombre as empresa, s.nombre as sucursal, i.nombre as insumo, st.cantidad from inv.stock st join inv.insumos i on i.id = st.insumo_id
                  join core.sucursales s on s.id = st.sucursal_id join core.empresas e on e.id = st.empresa_id where st.empresa_id = any($1::uuid[]) and st.cantidad < 0 order by st.cantidad limit 50`, [ids]),
      db.query(`select e.nombre as empresa, s.nombre as sucursal, i.nombre as insumo, l.cantidad_actual, l.vence_at::text as vence from inv.lotes l join inv.insumos i on i.id = l.insumo_id
                  join core.sucursales s on s.id = l.sucursal_id join core.empresas e on e.id = l.empresa_id
                 where l.empresa_id = any($1::uuid[]) and l.cantidad_actual > 0 and l.vence_at <= $2::date order by l.vence_at limit 50`, [ids, sumarDias(hoy, 2)]),
      db.query(`select e.nombre as empresa, s.nombre as sucursal, u.nombre as cajero, t.abierto_at from pos.turnos t join core.sucursales s on s.id = t.sucursal_id
                  join core.empresas e on e.id = t.empresa_id join core.usuarios u on u.id = t.cajero_id
                 where t.empresa_id = any($1::uuid[]) and t.estado = 'abierto' and t.abierto_at < now() - interval '18 hours'`, [ids]),
    ]);
    res.json({ cai: cai.rows, stock_negativo: neg.rows, por_vencer: ven.rows, turnos_olvidados: turnos.rows });
  });

  montarExtras(r, { db, ctxMgr }, empresasConsolidables);
  montarRrhhGrupo(r, { db, ctxMgr }, empresasConsolidables);
  montarDocumentos(r, { db, ctxMgr }, empresasConsolidables);
  return r;
}
