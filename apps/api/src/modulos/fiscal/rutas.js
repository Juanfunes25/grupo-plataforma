import { Router } from 'express';
import { z } from 'zod';
import { fechaHN, rtnValido, soloDigitos, UMBRAL_RTN_OBLIGATORIO } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, ErrorHttp, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { estadoPunto } from '../pos/fiscal.js';
import { alertasCai, correoValido, FACTURA, guardarConfigFiscal, leerConfigFiscal, verificarEmpresa } from './asistente.js';

const cambiosDe = (antes, despues, campos) => Object.fromEntries(
  campos.filter((k) => despues[k] !== undefined && String(antes[k] ?? '') !== String(despues[k] ?? '')).map((k) => [k, { antes: antes[k] ?? null, despues: despues[k] ?? null }]));

const texto = (max) => z.string().trim().max(max).nullable().optional().transform((v) => (v ? v : null));
const telefono = z.string().trim().max(40).nullable().optional().transform((v) => (v ? v : null))
  .refine((v) => v === null || soloDigitos(v).length >= 7, 'El teléfono necesita al menos 7 dígitos');
const correo = z.string().trim().toLowerCase().max(120).nullable().optional().transform((v) => (v ? v : null))
  .refine((v) => v === null || correoValido(v), 'El correo no es válido');

export function rutasFiscalAsistente({ db, ctxMgr }) {
  const r = Router();

  /** Todo el asistente en una llamada: modo, datos, sucursales, lista de verificación y alertas. */
  r.get('/asistente', requierePermiso('pos:fiscal'), async (req, res) => {
    const v = await verificarEmpresa(db, req.ctx.empresa);
    const cfgPos = (await db.query(`select valor from core.config where empresa_id = $1 and clave = 'pos'`, [req.ctx.empresa.id])).rows[0]?.valor ?? {};
    const e = v.empresa;
    res.json({
      modo: v.modo, en_preparacion: v.en_preparacion, sucursales_con_cai_real: v.sucursales_con_cai_real, sucursales_que_facturan: v.sucursales_que_facturan,
      umbral_rtn: Number(cfgPos.umbral_rtn) > 0 ? Number(cfgPos.umbral_rtn) : UMBRAL_RTN_OBLIGATORIO,
      rtn_bloqueante: cfgPos.rtn_bloqueante !== false,
      en_vivo_desde: v.config.en_vivo_desde ?? null,
      empresa: { id: e.id, codigo: e.codigo, nombre: e.nombre, razon_social: e.razon_social, rtn: e.rtn, direccion: e.direccion, ciudad: e.ciudad, telefono: e.telefono, correo: e.correo, web: e.web },
      sucursales: v.sucursales.map((s) => ({
        id: s.id, nombre: s.nombre, tipo: s.tipo, factura: FACTURA.has(s.tipo), direccion: s.direccion, telefono: s.telefono, correo: s.correo, color: s.color,
        punto: s.pe_id ? (({ id, es_borrador, porcentaje_usado, dias_restantes, agotado, vencido, alerta }) => ({ id, es_borrador, porcentaje_usado, dias_restantes, agotado, vencido, alerta }))(
          estadoPunto({ ...s, id: s.pe_id, fecha_limite_emision: s.fecha_limite_emision ? String(s.fecha_limite_emision).slice(0, 10) : null })) : null,
        impresora_confirmada: v.config.confirmaciones?.[`impresora_${s.id}`] ?? null,
      })),
      verificacion: v.items, faltan: v.faltan, por_confirmar: v.por_confirmar, listo_para_real: v.listo_para_real,
      alertas: v.alertas,
    });
  });

  /** Alertas de CAI: la empresa activa, o todo el grupo para quien ve la Dirección. Lo usan el tablero y el aviso por correo. */
  r.get('/alertas', requierePermiso('pos:fiscal', 'pos:reportes', 'gerente:ver', 'grupo:ver'), async (req, res) => {
    const grupo = req.query.alcance === 'grupo';
    if (grupo && !req.ctx.permisos.has('grupo:ver')) return res.json({ alertas: [] });
    const alertas = await alertasCai(db, { empresaId: grupo ? null : req.ctx.empresa.id, sucursalIds: grupo ? [] : req.ctx.sucursalIds });
    res.json({ alertas });
  });

  // ── Datos de la empresa ──
  r.put('/empresa', requierePermiso('pos:fiscal'), async (req, res) => {
    const b = validar(z.object({
      razon_social: z.string().trim().min(2).max(200),
      nombre: z.string().trim().min(2).max(120),
      rtn: z.string().trim().max(30).nullable().optional().transform((v) => (v ? soloDigitos(v) : null)),
      direccion: texto(200), ciudad: texto(100), telefono, correo, web: texto(120),
    }), req.body);
    if (b.rtn && !rtnValido(b.rtn)) throw malaPeticion('El RTN debe tener 14 dígitos (ej. 0801-1999-123456)');
    const emp = req.ctx.empresa;
    const ant = (await db.query('select * from core.empresas where id = $1', [emp.id])).rows[0];
    const cfg = await leerConfigFiscal(db, emp.id);
    if (cfg.en_vivo && (!b.rtn || !b.direccion)) throw conflicto('En modo REAL no se puede dejar la empresa sin RTN ni dirección. Vuelve primero a modo prueba si debes corregirlo.');
    const out = await db.tx(async (q) => {
      const x = (await q.query(
        `update core.empresas set razon_social=$2, nombre=$3, rtn=$4, direccion=$5, ciudad=$6, telefono=$7, correo=$8, web=$9 where id=$1 returning *`,
        [emp.id, b.razon_social, b.nombre, b.rtn, b.direccion, b.ciudad, b.telefono, b.correo, b.web])).rows[0];
      const cambios = cambiosDe(ant, b, ['razon_social', 'nombre', 'rtn', 'direccion', 'ciudad', 'telefono', 'correo', 'web']);
      if (Object.keys(cambios).length) await auditar(q, req.ctx, 'datos_fiscales_empresa_editados', 'empresa', emp.id, { cambios });
      return x;
    });
    ctxMgr.invalidar();
    res.json(out);
  });

  // ── Datos de cada sucursal ──
  r.put('/sucursales/:id', requierePermiso('pos:fiscal'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const b = validar(z.object({ nombre: z.string().trim().min(2).max(80), direccion: texto(200), telefono, correo }), req.body);
    const out = await db.tx(async (q) => {
      const ant = (await q.query('select * from core.sucursales where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id])).rows[0];
      if (!ant) throw noEncontrado();
      const x = (await q.query('update core.sucursales set nombre=$3, direccion=$4, telefono=$5, correo=$6 where id=$1 and empresa_id=$2 returning *',
        [id, req.ctx.empresa.id, b.nombre, b.direccion, b.telefono, b.correo])).rows[0];
      const cambios = cambiosDe(ant, b, ['nombre', 'direccion', 'telefono', 'correo']);
      if (Object.keys(cambios).length) await auditar(q, req.ctx, 'datos_fiscales_sucursal_editados', 'sucursal', id, { nombre: x.nombre, cambios }, { sucursalId: id });
      return x;
    });
    ctxMgr.invalidar();
    res.json(out);
  });

  // ── Confirmaciones manuales (la impresora vive en cada computadora: la confirma una persona) ──
  r.post('/confirmaciones', requierePermiso('pos:fiscal'), async (req, res) => {
    const b = validar(z.object({ id: z.string().regex(/^impresora_[0-9a-f-]{36}$/, 'confirmación desconocida'), confirmado: z.boolean() }), req.body);
    const sid = b.id.slice('impresora_'.length);
    const s = (await db.query('select id, nombre from core.sucursales where id = $1 and empresa_id = $2', [sid, req.ctx.empresa.id])).rows[0];
    if (!s) throw noEncontrado('Esa sucursal no es de esta empresa');
    const cfg = await leerConfigFiscal(db, req.ctx.empresa.id);
    const conf = { ...(cfg.confirmaciones ?? {}) };
    if (b.confirmado) conf[b.id] = { por: req.ctx.usuario.nombre, fecha: fechaHN(), at: new Date().toISOString() }; else delete conf[b.id];
    await guardarConfigFiscal(db, req.ctx.empresa.id, { confirmaciones: conf });
    // `||` de jsonb reemplaza la clave completa: si se desmarcó, queda el objeto sin esa entrada.
    await auditar(db, req.ctx, b.confirmado ? 'fiscal_impresora_confirmada' : 'fiscal_impresora_desmarcada', 'sucursal', sid, { sucursal: s.nombre }, { sucursalId: sid });
    res.json({ ok: true });
  });

  // ── Cambio de modo ──
  r.post('/modo', requierePermiso('pos:fiscal'), async (req, res) => {
    const { modo } = validar(z.object({ modo: z.enum(['real', 'prueba']), confirmar: z.literal(true, { errorMap: () => ({ message: 'Falta confirmar el cambio de modo' }) }) }), req.body);
    const emp = req.ctx.empresa;
    const v = await verificarEmpresa(db, emp);
    if (modo === 'real') {
      if (v.modo === 'real') throw conflicto('La empresa ya está en modo REAL');
      if (v.faltan || v.por_confirmar) {
        const e = new ErrorHttp(409, 'Todavía no se puede pasar a modo REAL: completa la lista de verificación', 'fiscal_incompleto');
        e.faltantes = v.items.filter((i) => i.estado === 'falta' || i.estado === 'manual').map((i) => ({ id: i.id, titulo: i.titulo, detalle: i.detalle }));
        throw e;
      }
      await db.tx(async (q) => {
        await guardarConfigFiscal(q, emp.id, { en_vivo: true, en_vivo_desde: new Date().toISOString(), en_vivo_por: req.ctx.usuario.nombre });
        // Desde aquí la ley manda: factura sobre el umbral sin RTN no se cobra.
        await q.query(
          `insert into core.config (empresa_id, clave, valor) values ($1,'pos','{"rtn_bloqueante": true}'::jsonb)
           on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"rtn_bloqueante": true}'::jsonb, updated_at = now()`, [emp.id]);
        await auditar(q, req.ctx, 'modo_fiscal_real', 'empresa', emp.id, { sucursales: v.sucursales_que_facturan });
      });
    } else {
      if (v.modo === 'prueba' && !v.en_preparacion) throw conflicto('La empresa ya está en modo PRUEBA');
      await db.tx(async (q) => {
        const pts = (await q.query('update pos.puntos_emision set es_borrador = true where empresa_id = $1 and activo and not es_borrador returning id', [emp.id])).rows;
        await guardarConfigFiscal(q, emp.id, { en_vivo: false, en_vivo_hasta: new Date().toISOString() });
        await q.query(
          `insert into core.config (empresa_id, clave, valor) values ($1,'pos','{"rtn_bloqueante": false}'::jsonb)
           on conflict (empresa_id, clave) do update set valor = core.config.valor || '{"rtn_bloqueante": false}'::jsonb, updated_at = now()`, [emp.id]);
        await auditar(q, req.ctx, 'modo_fiscal_prueba', 'empresa', emp.id, { puntos_devueltos_a_borrador: pts.length });
      });
    }
    ctxMgr.invalidar();
    res.json({ ok: true, modo });
  });

  return r;
}
