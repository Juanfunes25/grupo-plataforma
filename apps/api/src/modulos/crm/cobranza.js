import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { cuentasPorCobrar, cxcPorEmpresa, resumirCxc } from './cxc.js';
import { datosEstadoCuenta, htmlEstadoCuenta } from './estado-cuenta.js';

const r2 = (n) => Math.round(n * 100) / 100;
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'fecha inválida (YYYY-MM-DD)');
const origen = z.enum(['eco', 'dis']);

/** Cierra solas las promesas: cumplida si ya se pagó lo prometido, incumplida si pasó la fecha sin pago. */
export async function refrescarPromesas(q, empresaId, hoy = fechaHN()) {
  const { rows } = await q.query(`select * from crm.promesas where empresa_id = $1 and estado = 'pendiente'`, [empresaId]);
  for (const p of rows) {
    const pagos = p.origen === 'eco' ? 'eco.cotizacion_pagos' : 'dis.cotizacion_pagos';
    const filtro = p.origen === 'dis' ? 'and not anulado' : '';
    const pagado = Number((await q.query(`select coalesce(sum(monto),0) as s from ${pagos} where cotizacion_id = $1 and created_at >= $2 ${filtro}`, [p.documento_id, p.created_at])).rows[0].s);
    const abierta = (await q.query('select 1 from crm.cxc($2::date) where documento_id = $1', [p.documento_id, hoy])).rowCount > 0;
    let nuevo = null;
    if (pagado + 0.004 >= Number(p.monto) || !abierta) nuevo = 'cumplida';
    else if (String(p.fecha_promesa).slice(0, 10) < hoy) nuevo = 'incumplida';
    if (nuevo) {
      await q.query('update crm.promesas set estado = $2, cerrada_at = now() where id = $1', [p.id, nuevo]);
      if (nuevo === 'cumplida') await q.query(`update crm.recordatorios set estado = 'hecho', hecho_at = now() where clave = $1 and estado = 'pendiente'`, [`promesa:${p.id}`]);
    }
  }
}

export function rutasCobranza({ db, ctxMgr }) {
  const r = Router();
  const ver = requierePermiso('cobranza:ver');
  const gestiona = requierePermiso('cobranza:gestionar');
  r.use((req, _res, next) => {
    if (req.path === '/grupo') return next();
    if (!req.ctx.empresa.modulos.includes('cobranza')) throw prohibido(`${req.ctx.empresa.nombre} no usa cobranza`);
    next();
  });
  const emp = (req) => req.ctx.empresa.id;

  // ── Tablero ──────────────────────────────────────────────────────────────
  r.get('/tablero', ver, async (req, res) => {
    const hoy = fechaHN();
    await refrescarPromesas(db, emp(req), hoy);
    const filas = await cuentasPorCobrar(db, { empresaIds: [emp(req)], hoy });
    const [prom, rec] = await Promise.all([
      db.query(`select id, documento_id, tercero_id, nombre_cliente, documento, monto, fecha_promesa::text, responsable_nombre, estado from crm.promesas where empresa_id = $1 and estado in ('pendiente','incumplida') order by fecha_promesa`, [emp(req)]),
      db.query(`select count(*)::int as n from crm.recordatorios where empresa_id = $1 and estado = 'pendiente' and fecha <= $2::date`, [emp(req), hoy]),
    ]);
    const clientes = new Map();
    for (const f of filas) {
      const k = f.tercero_id ?? f.nombre_cliente;
      if (!clientes.has(k)) clientes.set(k, { tercero_id: f.tercero_id, nombre: f.nombre_cliente, filas: [] });
      clientes.get(k).filas.push(f);
    }
    const sinCobro = filas.filter((f) => f.pagado === 0);
    const anticipos = filas.filter((f) => f.anticipo_requerido > 0 && f.anticipo_pendiente > 0.004);
    const proms = prom.rows.map((p) => ({ ...p, monto: Number(p.monto) }));
    res.json({
      fecha: hoy,
      resumen: {
        ...resumirCxc(filas),
        sin_cobro: { n: sinCobro.length, monto: r2(sinCobro.reduce((s, f) => s + f.saldo, 0)) },
        anticipos_pendientes: { n: anticipos.length, monto: r2(anticipos.reduce((s, f) => s + f.anticipo_pendiente, 0)) },
        promesas: { pendientes: proms.filter((p) => p.estado === 'pendiente').length, incumplidas: proms.filter((p) => p.estado === 'incumplida').length, para_hoy: proms.filter((p) => p.estado === 'pendiente' && p.fecha_promesa <= hoy).length },
        recordatorios_hoy: rec.rows[0].n,
      },
      clientes: [...clientes.values()].map(({ filas: fs, ...c }) => ({ ...c, ...resumirCxc(fs), peor_atraso: Math.max(...fs.map((f) => f.dias_atraso)) })).sort((a, b) => b.total - a.total),
      documentos: filas.map((f) => ({ origen: f.origen, documento_id: f.documento_id, documento: f.documento, tercero_id: f.tercero_id, nombre_cliente: f.nombre_cliente, proyecto: f.proyecto, total: f.total, pagado: f.pagado, saldo: f.saldo,
        anticipo_pendiente: f.anticipo_pendiente, fecha_documento: String(f.fecha_documento).slice(0, 10), dias_atraso: f.dias_atraso, vencido: f.vencido, bucket: f.bucket,
        situacion: f.pagado === 0 ? 'sin_cobro' : f.anticipo_pendiente > 0.004 ? 'anticipo_pendiente' : 'parcial' })),
      promesas: proms,
    });
  });

  // ── Detalle de un documento: pagos, gestiones y promesas ────────────────
  r.get('/documento/:origen/:id', ver, async (req, res) => {
    const o = validar(origen, req.params.origen); const id = validar(uuid, req.params.id);
    const fila = (await cuentasPorCobrar(db, { empresaIds: [emp(req)] })).find((f) => f.origen === o && f.documento_id === id);
    if (!fila) throw noEncontrado('Ese documento ya no tiene saldo por cobrar');
    const [pagos, gestiones, promesas] = await Promise.all([
      db.query(o === 'eco'
        ? `select p.created_at, p.tipo as concepto, f.nombre as forma, p.monto, p.referencia from eco.cotizacion_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.cotizacion_id = $1 order by p.created_at`
        : `select p.created_at, p.concepto, f.nombre as forma, p.monto, p.referencia from dis.cotizacion_pagos p join pos.formas_pago f on f.id = p.forma_pago_id where p.cotizacion_id = $1 and not p.anulado order by p.created_at`, [id]),
      db.query(`select id, tipo, resultado, nota, proxima_fecha::text, usuario_nombre, created_at from crm.gestiones where empresa_id = $1 and origen = $2 and documento_id = $3 order by created_at desc`, [emp(req), o, id]),
      db.query(`select id, monto, fecha_promesa::text, responsable_nombre, estado, nota, created_at from crm.promesas where empresa_id = $1 and origen = $2 and documento_id = $3 order by created_at desc`, [emp(req), o, id]),
    ]);
    res.json({ documento: fila, pagos: pagos.rows.map((p) => ({ ...p, monto: Number(p.monto) })), gestiones: gestiones.rows, promesas: promesas.rows.map((p) => ({ ...p, monto: Number(p.monto) })) });
  });

  async function docAbierto(req, o, id) {
    const fila = (await cuentasPorCobrar(db, { empresaIds: [emp(req)] })).find((f) => f.origen === o && f.documento_id === id);
    if (!fila) throw conflicto('Ese documento ya no tiene saldo por cobrar');
    return fila;
  }

  // ── Gestiones de cobro ───────────────────────────────────────────────────
  r.post('/gestiones', gestiona, async (req, res) => {
    const b = validar(z.object({ origen, documento_id: uuid, tipo: z.enum(['llamada', 'visita', 'correo', 'mensaje', 'nota']), resultado: z.string().trim().max(160).optional().nullable(),
      nota: z.string().trim().max(600).optional().nullable(), proxima_fecha: fecha.optional().nullable() }), req.body);
    if (!b.resultado && !b.nota) throw malaPeticion('Anota qué pasó (resultado o nota)');
    if (b.proxima_fecha && b.proxima_fecha < fechaHN()) throw malaPeticion('La próxima gestión no puede ser en el pasado');
    const d = await docAbierto(req, b.origen, b.documento_id);
    const g = await db.tx(async (q) => {
      const g = (await q.query(
        `insert into crm.gestiones (empresa_id, tercero_id, nombre_cliente, origen, documento_id, documento, tipo, resultado, nota, proxima_fecha, usuario_id, usuario_nombre) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [emp(req), d.tercero_id, d.nombre_cliente, b.origen, b.documento_id, d.documento, b.tipo, b.resultado ?? null, b.nota ?? null, b.proxima_fecha ?? null, req.ctx.usuario.id, req.ctx.usuario.nombre])).rows[0];
      if (b.proxima_fecha) {
        await q.query(`insert into crm.recordatorios (empresa_id, tipo, tercero_id, fecha, titulo, detalle, responsable_id, clave, creado_por) values ($1,'gestion',$2,$3,$4,$5,$6,$7,$6)`,
          [emp(req), d.tercero_id, b.proxima_fecha, `Dar seguimiento a ${d.nombre_cliente} (${d.documento})`, `Saldo L ${d.saldo.toFixed(2)}`, req.ctx.usuario.id, `gestion:${g.id}`]);
      }
      await auditar(q, req.ctx, 'cobranza_gestion', 'cobranza', b.documento_id, { documento: d.documento, cliente: d.nombre_cliente, tipo: b.tipo, resultado: b.resultado ?? null });
      return g;
    });
    res.status(201).json(g);
  });

  // ── Promesas de pago ─────────────────────────────────────────────────────
  r.get('/promesas', ver, async (req, res) => {
    const { estado } = validar(z.object({ estado: z.enum(['pendiente', 'cumplida', 'incumplida', 'cancelada']).optional() }), req.query);
    await refrescarPromesas(db, emp(req));
    const { rows } = await db.query(`select id, origen, documento_id, documento, nombre_cliente, monto, fecha_promesa::text, responsable_id, responsable_nombre, estado, nota, created_at from crm.promesas
      where empresa_id = $1 and ($2::text is null or estado = $2) order by fecha_promesa desc limit 200`, [emp(req), estado ?? null]);
    res.json(rows.map((p) => ({ ...p, monto: Number(p.monto) })));
  });

  r.post('/promesas', gestiona, async (req, res) => {
    const b = validar(z.object({ origen, documento_id: uuid, monto: z.coerce.number().positive('El monto debe ser mayor que 0'), fecha_promesa: fecha, responsable_id: uuid.optional().nullable(), nota: z.string().trim().max(300).optional().nullable() }), req.body);
    if (b.fecha_promesa < fechaHN()) throw malaPeticion('La fecha prometida no puede ser en el pasado');
    const d = await docAbierto(req, b.origen, b.documento_id);
    if (b.monto > d.saldo + 0.004) throw malaPeticion(`El monto supera el saldo (L ${d.saldo.toFixed(2)})`);
    let resp = { id: req.ctx.usuario.id, nombre: req.ctx.usuario.nombre };
    if (b.responsable_id && b.responsable_id !== resp.id) {
      const u = (await db.query(`select u.id, u.nombre from core.usuarios u where u.id = $1 and u.activo and (u.es_dueno_grupo or exists (select 1 from core.accesos a where a.usuario_id = u.id and a.empresa_id = $2 and a.activo))`, [b.responsable_id, emp(req)])).rows[0];
      if (!u) throw malaPeticion('Ese responsable no trabaja en esta empresa');
      resp = u;
    }
    const p = await db.tx(async (q) => {
      const p = (await q.query(
        `insert into crm.promesas (empresa_id, tercero_id, nombre_cliente, origen, documento_id, documento, monto, fecha_promesa, responsable_id, responsable_nombre, nota, creado_por) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [emp(req), d.tercero_id, d.nombre_cliente, b.origen, b.documento_id, d.documento, b.monto, b.fecha_promesa, resp.id, resp.nombre, b.nota ?? null, req.ctx.usuario.id])).rows[0];
      await q.query(`insert into crm.recordatorios (empresa_id, tipo, tercero_id, fecha, titulo, detalle, responsable_id, clave, creado_por) values ($1,'promesa',$2,$3,$4,$5,$6,$7,$8)`,
        [emp(req), d.tercero_id, b.fecha_promesa, `Promesa de pago: ${d.nombre_cliente}`, `${d.documento} · L ${b.monto.toFixed(2)}`, resp.id, `promesa:${p.id}`, req.ctx.usuario.id]);
      await auditar(q, req.ctx, 'cobranza_promesa', 'cobranza', b.documento_id, { documento: d.documento, cliente: d.nombre_cliente, monto: b.monto, fecha: b.fecha_promesa, responsable: resp.nombre });
      return p;
    });
    res.status(201).json({ ...p, monto: Number(p.monto) });
  });

  r.put('/promesas/:id/estado', gestiona, async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { estado } = validar(z.object({ estado: z.enum(['cumplida', 'incumplida', 'cancelada']) }), req.body);
    const p = (await db.query(`update crm.promesas set estado = $3, cerrada_at = now() where id = $1 and empresa_id = $2 and estado in ('pendiente','incumplida') returning *`, [id, emp(req), estado])).rows[0];
    if (!p) throw conflicto('Esa promesa ya está cerrada o no existe');
    await db.query(`update crm.recordatorios set estado = 'hecho', hecho_at = now() where clave = $1 and estado = 'pendiente'`, [`promesa:${id}`]);
    await auditar(db, req.ctx, 'cobranza_promesa_estado', 'cobranza', p.documento_id, { documento: p.documento, estado });
    res.json({ ...p, monto: Number(p.monto) });
  });

  // ── Recordatorios internos (el correo lo envía Mensajería; aquí solo el registro) ──
  r.get('/recordatorios', ver, async (req, res) => {
    const f = validar(z.object({ estado: z.enum(['pendiente', 'hecho', 'descartado']).default('pendiente'), hasta: fecha.optional(), mios: z.enum(['1', '0']).default('0') }), req.query);
    const { rows } = await db.query(
      `select r.id, r.tipo, r.fecha::text, r.titulo, r.detalle, r.estado, r.responsable_id, u.nombre as responsable, r.tercero_id from crm.recordatorios r left join core.usuarios u on u.id = r.responsable_id
        where r.empresa_id = $1 and r.estado = $2 and ($3::date is null or r.fecha <= $3::date) and ($4::boolean is false or r.responsable_id = $5) order by r.fecha, r.created_at limit 200`,
      [emp(req), f.estado, f.hasta ?? null, f.mios === '1', req.ctx.usuario.id]);
    res.json(rows);
  });
  r.post('/recordatorios', gestiona, async (req, res) => {
    const b = validar(z.object({ fecha, titulo: z.string().trim().min(3).max(160), detalle: z.string().trim().max(400).optional().nullable(), tercero_id: uuid.optional().nullable() }), req.body);
    const x = (await db.query(`insert into crm.recordatorios (empresa_id, tipo, tercero_id, fecha, titulo, detalle, responsable_id, creado_por) values ($1,'otro',$2,$3,$4,$5,$6,$6) returning *`,
      [emp(req), b.tercero_id ?? null, b.fecha, b.titulo, b.detalle ?? null, req.ctx.usuario.id])).rows[0];
    res.status(201).json(x);
  });
  for (const [ruta, estado] of [['hecho', 'hecho'], ['descartar', 'descartado']]) {
    r.post(`/recordatorios/:id/${ruta}`, gestiona, async (req, res) => {
      const id = validar(uuid, req.params.id);
      const x = (await db.query(`update crm.recordatorios set estado = $3, hecho_at = now() where id = $1 and empresa_id = $2 and estado = 'pendiente' returning *`, [id, emp(req), estado])).rows[0];
      if (!x) throw conflicto('Ese recordatorio ya está cerrado o no existe');
      res.json(x);
    });
  }

  // ── Estado de cuenta imprimible ──────────────────────────────────────────
  r.get('/estado-cuenta/:terceroId', ver, async (req, res) => {
    const id = validar(uuid, req.params.terceroId);
    const { formato } = validar(z.object({ formato: z.enum(['json', 'html']).default('json') }), req.query);
    const d = await datosEstadoCuenta(db, { empresa: req.ctx.empresa, terceroId: id });
    if (!d) throw noEncontrado('Cliente no encontrado');
    await auditar(db, req.ctx, 'cobranza_estado_cuenta', 'tercero', id, { cliente: d.cliente.nombre, saldo: d.resumen.saldo });
    if (formato === 'html') return res.type('html').send(htmlEstadoCuenta(d));
    res.json({ ...d, html: htmlEstadoCuenta(d) });
  });

  // ── Para Finanzas / Dirección: antigüedad por empresa ───────────────────
  r.get('/grupo', requierePermiso('grupo:ver'), async (req, res) => {
    const empresas = (await ctxMgr.empresasDe(req.ctx.usuario)).filter((e) => e.modulos.includes('cobranza')).map((e) => e.id);
    res.json(await cxcPorEmpresa(db, { empresaIds: empresas }));
  });

  return r;
}
