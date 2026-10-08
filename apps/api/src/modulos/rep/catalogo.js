import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { conflicto, malaPeticion, noEncontrado, prohibido, validar, uuid } from '../../lib/http.js';
import { normalizarNombreSabor, pareceQueTraePeso, saborParecido } from './lib/normalizarSabor.js';
import { PERM_ADMIN, empresaDe, listarSucursales, saborDe, sucursalDe } from './util.js';

export function rutasCatalogo({ db }) {
  const r = Router();
  const emp = empresaDe;

  r.get('/sucursales', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    res.json(await listarSucursales(db, req.ctx));
  });

  // Todas las sucursales (cerradas o no) con su configuración de reposición, para la administración.
  r.get('/sucursales/todas', requierePermiso(PERM_ADMIN), async (req, res) => {
    const { rows } = await db.query(
      `select s.id, s.nombre, s.alias, s.tipo, s.activo, coalesce(c.cerrada,false) as cerrada, coalesce(c.fuera_de_analisis,false) as fuera_de_analisis, c.motivo_exclusion
         from core.sucursales s left join rep.sucursal_config c on c.sucursal_id = s.id where s.empresa_id = $1 order by s.orden, s.nombre`, [emp(req)]);
    res.json(rows);
  });

  // «Cerrada» saca la tienda del pesaje y de los análisis (conserva el historial); «fuera de análisis» la deja pesar
  // pero no entra a los modelos de demanda (Los Andes se sirve sola de la fábrica).
  r.patch('/sucursales/:id/config', requierePermiso(PERM_ADMIN), async (req, res) => {
    const b = validar(z.object({ cerrada: z.boolean().optional(), fuera_de_analisis: z.boolean().optional(), motivo_exclusion: z.string().trim().max(300).optional().nullable() }), req.body);
    const suc = await sucursalDe(db, req, req.params.id);
    await db.tx(async (q) => {
      await q.query(
        `insert into rep.sucursal_config (sucursal_id, empresa_id, cerrada, fuera_de_analisis, motivo_exclusion) values ($1,$2,coalesce($3,false),coalesce($4,false),$5)
         on conflict (sucursal_id) do update set cerrada = coalesce($3, rep.sucursal_config.cerrada), fuera_de_analisis = coalesce($4, rep.sucursal_config.fuera_de_analisis),
           motivo_exclusion = coalesce($5, rep.sucursal_config.motivo_exclusion), updated_at = now()`, [suc.id, emp(req), b.cerrada ?? null, b.fuera_de_analisis ?? null, b.motivo_exclusion ?? null]);
      await auditar(q, req.ctx, 'sucursal.config_rep', 'sucursal', suc.id, { sucursal: suc.nombre, ...b }, { sucursalId: suc.id });
    });
    res.json({ ok: true });
  });

  // Sabores que pesa esta sucursal, con su último peso (el pesaje arranca de ahí).
  r.get('/sucursales/:id/sabores', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.id);
    const { rows } = await db.query(
      `select sa.id, sa.nombre, sa.gramos_pana,
         (select p.gramos::float8 from rep.pesajes p where p.sucursal_id = ss.sucursal_id and p.sabor_id = sa.id order by p.fecha desc, p.created_at desc limit 1) as ultimo_peso,
         (select p.fecha::text from rep.pesajes p where p.sucursal_id = ss.sucursal_id and p.sabor_id = sa.id order by p.fecha desc, p.created_at desc limit 1) as ultimo_peso_fecha
       from rep.sucursal_sabores ss join rep.sabores sa on sa.id = ss.sabor_id
       where ss.sucursal_id = $1 and ss.empresa_id = $2 and ss.activo and sa.activo order by sa.nombre`, [suc.id, emp(req)]);
    res.json(rows);
  });

  // Catálogo completo marcando cuáles pesa la tienda. Lo ve la propia sucursal o la administración.
  r.get('/sucursales/:id/catalogo', requierePermiso('rep:pesar', PERM_ADMIN), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.id);
    const { rows } = await db.query(
      `select sa.id, sa.nombre, sa.gramos_pana, coalesce(ss.activo,false) as activo from rep.sabores sa
         left join rep.sucursal_sabores ss on ss.sabor_id = sa.id and ss.sucursal_id = $1
        where sa.empresa_id = $2 and sa.activo order by sa.nombre`, [suc.id, emp(req)]);
    res.json(rows.map((s) => ({ ...s, activo: s.activo ? 1 : 0 })));
  });

  // Elegir CUÁLES sabores pesa cada tienda es cosa de la propia tienda (y de la administración).
  r.patch('/sucursales/:id/sabores/:saborId', requierePermiso('rep:pesar', PERM_ADMIN), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.id);
    const activo = Boolean(req.body?.activo);
    await db.tx(async (q) => {
      const sa = await saborDe(q, emp(req), validar(uuid, req.params.saborId));
      await q.query(
        `insert into rep.sucursal_sabores (sucursal_id, sabor_id, empresa_id, activo) values ($1,$2,$3,$4)
         on conflict (sucursal_id, sabor_id) do update set activo = excluded.activo`, [suc.id, sa.id, emp(req), activo]);
      await auditar(q, req.ctx, activo ? 'catalogo.sabor_activar' : 'catalogo.sabor_desactivar', 'sabor', sa.id, { sucursal: suc.nombre, sabor: sa.nombre }, { sucursalId: suc.id });
    });
    res.json({ ok: true });
  });

  // ── Catálogo global de sabores ──
  r.get('/sabores', requierePermiso(PERM_ADMIN, 'rep:producir', 'rep:ver'), async (req, res) => {
    const { rows } = await db.query('select id, nombre, gramos_pana, activo::int as activo from rep.sabores where empresa_id = $1 order by nombre', [emp(req)]);
    res.json(rows);
  });

  /**
   * Alta de un sabor nuevo. Un sabor nace en producción: si nunca se produce no puede llegar a ninguna tienda, así que
   * las sucursales no pueden inventarse uno (de ahí salían los duplicados «FRESA», «FRESA CON CREMA», «FRESA C/CREMA»).
   * No lo engancha a ninguna sucursal: la administración decide a cuáles les toca.
   */
  r.post('/sabores', requierePermiso('rep:producir', PERM_ADMIN), async (req, res) => {
    const b = validar(z.object({ nombre: z.string().trim().min(1, 'Falta el nombre del sabor').max(80), gramos_pana: z.coerce.number().int().min(1).max(20000).optional(), forzar: z.boolean().optional() }), req.body);
    const nombre = b.nombre.toUpperCase();
    const existentes = (await db.query('select id, nombre from rep.sabores where empresa_id = $1 and activo', [emp(req)])).rows;
    const norm = normalizarNombreSabor(nombre);
    const exacto = existentes.find((s) => normalizarNombreSabor(s.nombre) === norm);
    if (exacto) throw malaPeticion(`Ya existe "${exacto.nombre}"`);
    if (!b.forzar) {
      if (pareceQueTraePeso(nombre)) return res.status(409).json({ error: `"${nombre}" parece traer el peso pegado al nombre. ¿El sabor de verdad se llama así?`, codigo: 'nombre_con_peso', mensaje: `"${nombre}" parece traer el peso pegado al nombre. ¿El sabor de verdad se llama así?` });
      const parecido = saborParecido(nombre, existentes);
      if (parecido) return res.status(409).json({ error: `Ya existe "${parecido.nombre}". ¿"${nombre}" es un sabor distinto?`, codigo: 'sabor_parecido', existente: parecido, mensaje: `Ya existe "${parecido.nombre}". ¿"${nombre}" es un sabor distinto?` });
    }
    const s = await db.tx(async (q) => {
      const n = (await q.query('insert into rep.sabores (empresa_id, nombre, gramos_pana) values ($1,$2,$3) returning id, nombre', [emp(req), nombre, b.gramos_pana || 3000])).rows[0];
      await auditar(q, req.ctx, 'sabor.crear', 'sabor', n.id, { nombre, gramos_pana: b.gramos_pana || 3000 });
      return n;
    });
    res.status(201).json({ ok: true, sabor_id: s.id, nombre: s.nombre });
  });

  // Renombrar, corregir el peso de pana o reactivar uno desactivado por error.
  r.patch('/sabores/:id', requierePermiso(PERM_ADMIN), async (req, res) => {
    const b = validar(z.object({ nombre: z.string().trim().min(1, 'El nombre no puede quedar vacío').max(80).optional(), gramos_pana: z.coerce.number().finite().gt(0, 'Peso de pana inválido').max(20000, 'Peso de pana inválido').optional(), activo: z.boolean().optional() }), req.body);
    if (b.nombre === undefined && b.gramos_pana === undefined && b.activo === undefined) throw malaPeticion('Nada para actualizar');
    await db.tx(async (q) => {
      const antes = await saborDe(q, emp(req), validar(uuid, req.params.id));
      const nombre = b.nombre?.toUpperCase();
      if (nombre && (await q.query('select 1 from rep.sabores where empresa_id = $1 and nombre = $2 and id <> $3', [emp(req), nombre, antes.id])).rows.length) throw malaPeticion('Ya existe otro sabor con ese nombre');
      await q.query('update rep.sabores set nombre = coalesce($2,nombre), gramos_pana = coalesce($3,gramos_pana), activo = coalesce($4,activo) where id = $1', [antes.id, nombre ?? null, b.gramos_pana ?? null, b.activo ?? null]);
      await auditar(q, req.ctx, 'sabor.editar', 'sabor', antes.id, { antes: { nombre: antes.nombre, gramos_pana: antes.gramos_pana, activo: antes.activo }, despues: { nombre: nombre ?? antes.nombre, gramos_pana: b.gramos_pana ?? antes.gramos_pana, activo: b.activo ?? antes.activo } });
    });
    res.json({ ok: true });
  });

  /**
   * Fusiona el sabor :id (el duplicado) DENTRO de `en`. Es la forma correcta de limpiar el catálogo: todo lo pesado a
   * nombre del duplicado pasa a contar para el que se queda, sin partir el historial. Solo chocan las tablas con
   * unicidad (sucursal_sabores, despachos): ahí manda lo que ya tenía el destino. Las tablas de otros módulos que
   * tengan sabor_id (producción, costeo, RFID, incidencias) se mueven también; las que choquen quedan y se avisa.
   */
  r.post('/sabores/:id/fusionar', requierePermiso(PERM_ADMIN), async (req, res) => {
    const { en } = validar(z.object({ en: uuid }), req.body);
    const origenId = validar(uuid, req.params.id);
    if (origenId === en) throw malaPeticion('No se puede fusionar un sabor consigo mismo');
    const out = await db.tx(async (q) => {
      const origen = await saborDe(q, emp(req), origenId);
      const destino = await saborDe(q, emp(req), en);
      const cuenta = async (t) => (await q.query(`select count(*)::int as c from ${t} where sabor_id = $1`, [origenId])).rows[0].c;
      const movidos = { pesajes: await cuenta('rep.pesajes'), despachos: await cuenta('rep.despachos'), sucursales: await cuenta('rep.sucursal_sabores') };
      await q.query(`update rep.sucursal_sabores set sabor_id = $2 where sabor_id = $1 and sucursal_id not in (select sucursal_id from rep.sucursal_sabores where sabor_id = $2)`, [origenId, en]);
      await q.query('delete from rep.sucursal_sabores where sabor_id = $1', [origenId]);
      await q.query(`update rep.despachos set sabor_id = $2 where sabor_id = $1 and not exists (select 1 from rep.despachos d2 where d2.sabor_id = $2 and d2.fecha = rep.despachos.fecha and d2.sucursal_id = rep.despachos.sucursal_id)`, [origenId, en]);
      await q.query('update rep.pesajes set sabor_id = $2 where sabor_id = $1', [origenId, en]);
      // Tablas de otros módulos con sabor_id (esquemas prod, inc, inv, rfid…): se mueven con un savepoint por tabla.
      const otras = (await q.query(
        `select table_schema, table_name from information_schema.columns
          where column_name = 'sabor_id' and table_schema not in ('rep','pg_catalog','information_schema','core','pos') and table_name in (select table_name from information_schema.tables where table_type = 'BASE TABLE')`)).rows;
      const sinFusionar = [];
      let i = 0;
      for (const t of otras) {
        const sp = `fus${i++}`;
        await q.query(`savepoint ${sp}`);
        try { await q.query(`update "${t.table_schema}"."${t.table_name}" set sabor_id = $2 where sabor_id = $1`, [origenId, en]); await q.query(`release savepoint ${sp}`); }
        catch { await q.query(`rollback to savepoint ${sp}`); sinFusionar.push(`${t.table_schema}.${t.table_name}`); }
      }
      const quedan = (await q.query(`select 1 from rep.despachos where sabor_id = $1 limit 1`, [origenId])).rows.length > 0 || sinFusionar.length > 0;
      let borrado = false;
      if (!quedan) {
        try { await q.query('savepoint borrar'); await q.query('delete from rep.sabores where id = $1', [origenId]); await q.query('release savepoint borrar'); borrado = true; }
        catch { await q.query('rollback to savepoint borrar'); await q.query('update rep.sabores set activo = false where id = $1', [origenId]); }
      } else await q.query('update rep.sabores set activo = false where id = $1', [origenId]);
      await auditar(q, req.ctx, 'sabor.fusionar', 'sabor', origenId, { origen: origen.nombre, destino: destino.nombre, movidos, sin_fusionar: sinFusionar, borrado });
      return { ok: true, origen: origen.nombre, destino: destino.nombre, borrado, receta_sin_fusionar: sinFusionar.length > 0, sin_fusionar: sinFusionar, movidos };
    });
    res.json(out);
  });

  // ── Insumos para pedir ("toca para agregar rápido") ──
  r.get('/insumos/catalogo', requierePermiso('rep:pesar', 'rep:despachar', 'rep:ver'), async (req, res) => {
    const sucursalId = req.query.sucursal_id ? (await sucursalDe(db, req, req.query.sucursal_id)).id : null;
    const { rows } = await db.query(
      `select ic.nombre, (select count(*)::int from rep.pedido_items pii join rep.pedidos_insumos p on p.id = pii.pedido_id where p.empresa_id = ic.empresa_id and pii.insumo_texto = ic.nombre) as usos
         from rep.insumos_catalogo ic ${sucursalId ? 'left join rep.sucursal_insumos si on si.insumo_id = ic.id and si.sucursal_id = $2' : ''}
        where ic.empresa_id = $1 and ic.activo ${sucursalId ? 'and coalesce(si.activo, true)' : ''} order by usos desc, ic.nombre`, sucursalId ? [emp(req), sucursalId] : [emp(req)]);
    res.json(rows);
  });

  r.get('/insumos/catalogo/:sucursalId', requierePermiso('rep:pesar', PERM_ADMIN), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.sucursalId);
    const { rows } = await db.query(
      `select ic.id, ic.nombre, ic.categoria, coalesce(si.activo,true)::int as activo from rep.insumos_catalogo ic
         left join rep.sucursal_insumos si on si.insumo_id = ic.id and si.sucursal_id = $2
        where ic.empresa_id = $1 and ic.activo and not ic.es_equipo order by ic.nombre`, [emp(req), suc.id]);
    res.json(rows);
  });

  r.patch('/insumos/catalogo/:sucursalId/:insumoId', requierePermiso('rep:pesar', PERM_ADMIN), async (req, res) => {
    const suc = await sucursalDe(db, req, req.params.sucursalId);
    const activo = Boolean(req.body?.activo);
    await db.tx(async (q) => {
      const ic = (await q.query('select id, nombre from rep.insumos_catalogo where id = $1 and empresa_id = $2', [validar(uuid, req.params.insumoId), emp(req)])).rows[0];
      if (!ic) throw noEncontrado('Insumo no encontrado');
      await q.query(`insert into rep.sucursal_insumos (sucursal_id, insumo_id, empresa_id, activo) values ($1,$2,$3,$4) on conflict (sucursal_id, insumo_id) do update set activo = excluded.activo`, [suc.id, ic.id, emp(req), activo]);
      await auditar(q, req.ctx, activo ? 'catalogo.insumo_activar' : 'catalogo.insumo_desactivar', 'insumo', ic.id, { sucursal: suc.nombre, insumo: ic.nombre }, { sucursalId: suc.id });
    });
    res.json({ ok: true });
  });
  return r;
}
