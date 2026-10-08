import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { ErrorHttp, conflicto, malaPeticion, noEncontrado, uuid, validar } from '../../lib/http.js';
import { enteroPositivo, esAdmin, veCostos } from './comun.js';
import { round2 } from './calculo.js';

const MUEVE = 'dis:salidas';

const norm = (t) => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** Responde 409 SIN_STOCK con la lista de faltantes (el cliente la muestra y pide confirmar). */
const conFaltantes = (fn) => async (req, res) => {
  try { await fn(req, res); } catch (e) {
    if (e.faltantes) return res.status(409).json({ error: e.message, codigo: 'SIN_STOCK', faltantes: e.faltantes });
    throw e;
  }
};

export function rutasSalidas(r, { db }) {
  // Items de una salida con lo pendiente y el costo; sin costos para quien no los ve.
  async function cargar(q, ctx, id) {
    const s = (await q.query(
      `select s.*, c.codigo as cot_codigo, c.proyecto as cot_proyecto, c.nombre_cliente as cot_cliente, u.nombre as creador
         from dis.salidas s left join dis.cotizaciones c on c.id = s.cotizacion_id left join core.usuarios u on u.id = s.creada_por
        where s.id = $1 and s.empresa_id = $2`, [id, ctx.empresa.id])).rows[0];
    if (!s) return null;
    return armar(ctx, s, (await itemsDe(q, [s.id])).get(s.id) ?? []);
  }
  async function itemsDe(q, ids) {
    const { rows } = await q.query(
      `select i.*, p.nombre, p.codigo, x.presentacion, p.unidad as unidad_venta, x.consumible
         from dis.salida_items i join pos.productos p on p.id = i.producto_id join dis.producto_ext x on x.producto_id = p.id
        where i.salida_id = any($1::uuid[])`, [ids]);
    const m = new Map();
    for (const i of rows) m.set(i.salida_id, [...(m.get(i.salida_id) ?? []), i]);
    return m;
  }
  function armar(ctx, s, filas) {
    const items = filas.map((i) => {
      const pendiente = Number(i.cantidad_salida) - Number(i.cantidad_retorno);
      const costo = round2(pendiente * Number(i.costo_unitario));
      return {
        id: i.id, producto_id: i.producto_id, cantidad_salida: Number(i.cantidad_salida), cantidad_retorno: Number(i.cantidad_retorno), pendiente,
        productos: { nombre: i.nombre, presentacion: i.presentacion, unidad_venta: i.unidad_venta, codigo: i.codigo, consumible: i.consumible },
        ...(veCostos(ctx) ? { costo_unitario: Number(i.costo_unitario), costo } : {}), _costo: costo,
      };
    }).sort((a, b) => a.productos.nombre.localeCompare(b.productos.nombre));
    const { cot_codigo, cot_proyecto, cot_cliente, ...resto } = s;
    const costo_total = round2(items.reduce((t, i) => t + i._costo, 0));
    return {
      ...resto, numero: Number(s.numero), cotizacion: s.cotizacion_id ? { codigo: cot_codigo, proyecto: cot_proyecto, nombre_cliente: cot_cliente } : null,
      items: items.map(({ _costo, ...i }) => i), unidades: items.reduce((t, i) => t + i.pendiente, 0),
      ...(veCostos(ctx) ? { costo_total } : {}),
      resumen: s.resumen ? (veCostos(ctx) ? s.resumen : { ...s.resumen, costo_consumido: undefined, costo_no_regresado: undefined, lineas: s.resumen.lineas?.map((l) => ({ ...l, costo: undefined })) }) : null,
    };
  }

  // Mueve material entre la bodega y el proyecto. cantidad > 0 saca de la bodega; < 0 devuelve.
  async function mover(q, ctx, salida, productoId, cantidad, forzar) {
    const prod = (await q.query(
      `select p.id, p.nombre, x.costo_estandar, x.controla_inventario from pos.productos p join dis.producto_ext x on x.producto_id = p.id
        where p.id = $1 and p.empresa_id = $2`, [productoId, ctx.empresa.id])).rows[0];
    if (!prod) throw noEncontrado('Producto no encontrado');
    if (!prod.controla_inventario) throw malaPeticion(`${prod.nombre} no controla inventario: actívalo en Productos`);
    const previo = (await q.query('select * from dis.salida_items where salida_id = $1 and producto_id = $2 for update', [salida.id, productoId])).rows[0];
    const pendiente = previo ? Number(previo.cantidad_salida) - Number(previo.cantidad_retorno) : 0;
    if (cantidad < 0 && -cantidad > pendiente) throw malaPeticion(`Solo hay ${pendiente} de ${prod.nombre} en este proyecto: no se pueden devolver ${-cantidad}`);
    const costo = Number(prod.costo_estandar) || 0;
    const motivo = `${cantidad > 0 ? 'Salida a proyecto' : 'Retorno de proyecto'}: ${salida.proyecto} (${salida.responsable})`;
    await q.query('select dis.mover($1,$2,$3,$4,$5,$6,null,null,$7,$8,$9,$10)', [
      ctx.empresa.id, productoId, cantidad > 0 ? 'salida_proyecto' : 'retorno_proyecto', -cantidad, costo, motivo, `Salida #${salida.numero}`, ctx.usuario.id, !!forzar, salida.id]);
    if (previo) {
      const salio = Number(previo.cantidad_salida) + (cantidad > 0 ? cantidad : 0);
      const retorno = Number(previo.cantidad_retorno) + (cantidad < 0 ? -cantidad : 0);
      const costoProm = cantidad > 0 ? (pendiente * Number(previo.costo_unitario) + cantidad * costo) / (pendiente + cantidad) : Number(previo.costo_unitario);
      await q.query('update dis.salida_items set cantidad_salida=$2, cantidad_retorno=$3, costo_unitario=$4 where id=$1', [previo.id, salio, retorno, Math.round(costoProm * 10000) / 10000]);
    } else {
      await q.query('insert into dis.salida_items (salida_id, producto_id, cantidad_salida, costo_unitario) values ($1,$2,$3,$4)', [salida.id, productoId, cantidad, costo]);
    }
  }

  const esqItems = z.array(z.object({ producto_id: uuid, cantidad: z.coerce.number() })).min(1, 'Agrega al menos un producto');
  function leerItems(lista) {
    const parsed = validar(esqItems, lista ?? []);
    const mapa = new Map();
    for (const it of parsed) mapa.set(it.producto_id, (mapa.get(it.producto_id) ?? 0) + enteroPositivo(it.cantidad, 'Cada producto necesita una cantidad entera distinta de cero'));
    return [...mapa].map(([producto_id, cantidad]) => ({ producto_id, cantidad })).filter((x) => x.cantidad !== 0);
  }

  // Avisa de faltantes (409 SIN_STOCK) salvo que el usuario ya lo haya confirmado.
  async function revisarFaltantes(q, ctx, items, confirmar) {
    const sacando = items.filter((i) => i.cantidad > 0);
    if (!sacando.length) return [];
    const { rows } = await q.query(
      `select p.id, p.nombre, coalesce(e.existencia, 0) as hay from pos.productos p left join dis.existencias e on e.producto_id = p.id
        where p.empresa_id = $1 and p.id = any($2::uuid[])`, [ctx.empresa.id, sacando.map((i) => i.producto_id)]);
    const por = new Map(rows.map((x) => [x.id, x]));
    const faltantes = sacando.filter((i) => Number(por.get(i.producto_id)?.hay ?? 0) < i.cantidad)
      .map((i) => ({ producto: por.get(i.producto_id)?.nombre ?? '—', pedido: i.cantidad, hay: Math.max(0, Math.floor(Number(por.get(i.producto_id)?.hay ?? 0))) }));
    if (faltantes.length && !confirmar) {
      const e = new ErrorHttp(409, `Sin existencia suficiente: ${faltantes.map((f) => `${f.producto} (pides ${f.pedido}, hay ${f.hay})`).join('; ')}`, 'SIN_STOCK');
      e.faltantes = faltantes;
      throw e;
    }
    return faltantes;
  }

  // Proyectos para elegir al sacar material: solo nombres (sin cantidades ni costos).
  r.get('/salidas/proyectos', requierePermiso(MUEVE), async (req, res) => {
    const [cots, abiertas] = await Promise.all([
      db.query(`select id, codigo, proyecto, nombre_cliente from dis.cotizaciones where empresa_id = $1 and tipo = 'proyecto' and estado in ('aprobada','facturada') order by created_at desc limit 200`, [req.ctx.empresa.id]),
      db.query(`select proyecto, cotizacion_id from dis.salidas where empresa_id = $1 and estado = 'abierta' order by created_at desc`, [req.ctx.empresa.id]),
    ]);
    const enCurso = abiertas.rows.map((a) => ({ nombre: a.proyecto, cotizacion_id: a.cotizacion_id }));
    const nombres = new Set(enCurso.map((a) => a.nombre));
    res.json({
      en_curso: enCurso,
      cotizaciones: cots.rows.filter((c) => !nombres.has(`${c.proyecto} — ${c.nombre_cliente}`)).map((c) => ({ nombre: `${c.proyecto} — ${c.nombre_cliente}`, cotizacion_id: c.id, codigo: c.codigo, proyecto: c.proyecto, cliente: c.nombre_cliente })),
    });
  });

  // Recepción: quien recibe ve lo que salió (sin costos), cuenta lo que regresó y el sistema cuadra.
  r.get('/salidas/por-cerrar', requierePermiso(MUEVE), async (req, res) => {
    const { rows } = await db.query(`select * from dis.salidas where empresa_id = $1 and estado = 'abierta' order by created_at desc`, [req.ctx.empresa.id]);
    const items = await itemsDe(db, rows.map((s) => s.id));
    res.json(rows.map((s) => {
      const its = (items.get(s.id) ?? []).map((i) => Number(i.cantidad_salida) - Number(i.cantidad_retorno)).filter((p) => p > 0);
      return { id: s.id, proyecto: s.proyecto, productos: its.length, unidades: its.reduce((a, b) => a + b, 0), desde: s.created_at };
    }));
  });

  r.get('/salidas/:id/recepcion', requierePermiso(MUEVE), async (req, res) => {
    const s = await cargar(db, req.ctx, validar(uuid, req.params.id));
    if (!s) throw noEncontrado('Proyecto no encontrado');
    if (s.estado !== 'abierta') throw conflicto('Este proyecto ya está terminado');
    res.json({ id: s.id, proyecto: s.proyecto, items: s.items.filter((i) => i.pendiente > 0).map((i) => ({ producto_id: i.producto_id, nombre: i.productos.nombre, presentacion: i.productos.presentacion, salio: i.pendiente, consumible: i.productos.consumible !== false })) });
  });

  r.post('/salidas/:id/cerrar', requierePermiso(MUEVE), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const out = await db.tx(async (q) => {
      await q.query('select 1 from dis.salidas where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id]);
      const salida = await cargar(q, req.ctx, id);
      if (!salida) throw noEncontrado('Proyecto no encontrado');
      if (salida.estado !== 'abierta') throw conflicto('Este proyecto ya está terminado');
      const conteo = new Map((Array.isArray(req.body?.conteo) ? req.body.conteo : []).map((c) => [c.producto_id, c.regreso]));
      const pendientes = salida.items.filter((i) => i.pendiente > 0);
      for (const i of pendientes) {
        const rg = conteo.get(i.producto_id);
        const nom = i.productos.nombre;
        if (rg === undefined || rg === '' || rg === null) throw malaPeticion(`Falta contar: ${nom}`);
        if (!Number.isInteger(Number(rg)) || Number(rg) < 0) throw malaPeticion(`${nom}: escribe un número entero (0 si no regresó nada)`);
        if (Number(rg) > i.pendiente) throw malaPeticion(`${nom}: no pueden regresar ${rg}, solo salieron ${i.pendiente}`);
      }
      for (const i of pendientes) {
        const rg = Number(conteo.get(i.producto_id));
        if (rg > 0) await mover(q, req.ctx, salida, i.producto_id, -rg, true);
      }
      // Costos reales para el resumen (aunque quien cierra no los vea).
      const { rows } = await q.query('select i.*, p.nombre, x.consumible from dis.salida_items i join pos.productos p on p.id = i.producto_id join dis.producto_ext x on x.producto_id = p.id where i.salida_id = $1 order by p.nombre', [id]);
      const lineas = rows.map((i) => {
        const consumido = Number(i.cantidad_salida) - Number(i.cantidad_retorno);
        return { producto_id: i.producto_id, producto: i.nombre, consumible: i.consumible !== false, salio: Number(i.cantidad_salida), regreso: Number(i.cantidad_retorno), consumido, costo: round2(consumido * Number(i.costo_unitario)) };
      });
      const faltan = lineas.filter((l) => !l.consumible && l.consumido > 0);
      const resumen = { cerrado_por: req.ctx.usuario.nombre, lineas, costo_consumido: round2(lineas.filter((l) => l.consumible).reduce((t, l) => t + l.costo, 0)), costo_no_regresado: round2(faltan.reduce((t, l) => t + l.costo, 0)) };
      await q.query(`update dis.salidas set estado='cerrada', cerrada_at=now(), cerrada_por=$2, resumen=$3::jsonb where id=$1`, [id, req.ctx.usuario.id, JSON.stringify(resumen)]);
      await auditar(q, req.ctx, 'salida_cerrada', 'salida', id, { numero: salida.numero, proyecto: salida.proyecto, conteo: lineas.map((l) => `${l.producto}: salió ${l.salio}, regresó ${l.regreso}, ${l.consumible ? 'consumido' : 'NO regresó'} ${l.consumido}`) }, { sucursalId: salida.sucursal_id });
      if (faltan.length) {
        await auditar(q, req.ctx, 'proyecto_material_no_regreso', 'salida', id, { proyecto: salida.proyecto, recibio: req.ctx.usuario.nombre, faltantes: faltan.map((l) => `${l.producto}: salió ${l.salio}, regresó ${l.regreso}`) }, { sucursalId: salida.sucursal_id });
      }
      const ve = veCostos(req.ctx);
      return { proyecto: salida.proyecto, lineas: lineas.map((l) => (ve ? l : { ...l, costo: undefined })), costo_consumido: ve ? resumen.costo_consumido : undefined, costo_no_regresado: ve ? resumen.costo_no_regresado : undefined, no_regresaron: faltan.length };
    });
    res.json(out);
  });

  r.get('/salidas', requierePermiso('admin:empresa'), async (req, res) => {
    const estado = req.query.estado ? validar(z.enum(['abierta', 'cerrada']), req.query.estado) : null;
    const cot = req.query.cotizacion_id ? validar(uuid, req.query.cotizacion_id) : null;
    const { rows } = await db.query(
      `select s.*, c.codigo as cot_codigo, c.proyecto as cot_proyecto, c.nombre_cliente as cot_cliente, u.nombre as creador
         from dis.salidas s left join dis.cotizaciones c on c.id = s.cotizacion_id left join core.usuarios u on u.id = s.creada_por
        where s.empresa_id = $1 and ($2::text is null or s.estado = $2) and ($3::uuid is null or s.cotizacion_id = $3) order by s.created_at desc limit 200`,
      [req.ctx.empresa.id, estado, cot]);
    const items = await itemsDe(db, rows.map((s) => s.id));
    const t = norm(req.query.q ?? '');
    res.json(rows.map((s) => armar(req.ctx, s, items.get(s.id) ?? [])).filter((s) => !t || norm(s.proyecto).includes(t)));
  });

  // Historial de un proyecto: cada movimiento de material y cada cierre/reapertura, con quién y cuándo.
  r.get('/salidas/:id/historial', requierePermiso('admin:empresa'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const [movs, eventos] = await Promise.all([
      db.query(`select m.id, m.created_at, m.cantidad, p.nombre as producto, u.nombre as usuario from dis.movimientos m join pos.productos p on p.id = m.producto_id left join core.usuarios u on u.id = m.usuario_id
                 where m.salida_id = $1 and m.empresa_id = $2 order by m.created_at desc limit 500`, [id, req.ctx.empresa.id]),
      db.query(`select id, created_at, accion, usuario_nombre, detalle from core.auditoria where empresa_id = $1 and entidad = 'salida' and entidad_id = $2 and accion in ('salida_cerrada','salida_reabierta') order by created_at desc`, [req.ctx.empresa.id, id]),
    ]);
    res.json([
      ...movs.rows.map((m) => ({ clave: `m${m.id}`, fecha: m.created_at, usuario: m.usuario ?? '—', texto: `${Number(m.cantidad) < 0 ? 'Sacó' : 'Devolvió'} ${Math.abs(Number(m.cantidad))} × ${m.producto}`, tipo: Number(m.cantidad) < 0 ? 'salida' : 'retorno' })),
      ...eventos.rows.map((e) => ({ clave: `e${e.id}`, fecha: e.created_at, usuario: e.usuario_nombre ?? '—', texto: e.accion === 'salida_cerrada' ? 'Cerró el proyecto' : 'Reabrió el proyecto', tipo: 'estado' })),
    ].sort((a, b) => String(b.fecha).localeCompare(String(a.fecha))));
  });

  r.get('/salidas/:id', requierePermiso('admin:empresa'), async (req, res) => {
    const s = await cargar(db, req.ctx, validar(uuid, req.params.id));
    if (!s) throw noEncontrado('Salida no encontrada');
    res.json(s);
  });

  r.post('/salidas', requierePermiso(MUEVE), conFaltantes(async (req, res) => {
    const b = validar(z.object({ proyecto: z.string().trim().min(3, 'Indica a qué proyecto va el material (obligatorio)').max(200), cotizacion_id: uuid.nullish().or(z.literal('').transform(() => null)), notas: z.string().trim().max(500).nullish(), confirmar_sin_stock: z.boolean().optional() }), req.body);
    const items = leerItems(req.body.items);
    if (items.some((i) => i.cantidad < 0)) throw malaPeticion('Una salida nueva solo lleva cantidades positivas');
    const admin = esAdmin(req.ctx);
    const out = await db.tx(async (q) => {
      const faltantes = await revisarFaltantes(q, req.ctx, items, !!b.confirmar_sin_stock);
      if (b.cotizacion_id) {
        const { rows } = await q.query('select 1 from dis.cotizaciones where id = $1 and empresa_id = $2', [b.cotizacion_id, req.ctx.empresa.id]);
        if (!rows.length) throw malaPeticion('Esa cotización no existe');
      }
      // Un proyecto = un registro: si ya hay material abierto para ese proyecto, se suma ahí.
      const abiertas = (await q.query(`select id, proyecto, cotizacion_id from dis.salidas where empresa_id = $1 and estado = 'abierta' for update`, [req.ctx.empresa.id])).rows;
      const existente = abiertas.find((a) => (b.cotizacion_id && a.cotizacion_id === b.cotizacion_id) || norm(a.proyecto) === norm(b.proyecto));
      let salida; let sumada = false;
      if (existente) {
        salida = await cargar(q, req.ctx, existente.id);
        sumada = true;
      } else {
        const suc = (await q.query('select id from core.sucursales where empresa_id = $1 and activo order by orden, nombre', [req.ctx.empresa.id])).rows
          .map((x) => x.id).filter((x) => !req.ctx.sucursalIds.length || req.ctx.sucursalIds.includes(x))[0] ?? null;
        const numero = (await q.query(`select dis.siguiente($1,'sal',0) as n`, [req.ctx.empresa.id])).rows[0].n;
        const ins = (await q.query(
          `insert into dis.salidas (empresa_id, sucursal_id, numero, proyecto, cotizacion_id, responsable, notas, creada_por) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
          [req.ctx.empresa.id, suc, numero, b.proyecto, b.cotizacion_id ?? null, req.ctx.usuario.nombre, b.notas ?? null, req.ctx.usuario.id])).rows[0];
        salida = { ...ins, numero: Number(ins.numero) };
        await auditar(q, req.ctx, 'salida_creada', 'salida', salida.id, { numero, proyecto: b.proyecto, responsable: req.ctx.usuario.nombre, productos: items.length }, { sucursalId: suc });
      }
      for (const it of items) await mover(q, req.ctx, salida, it.producto_id, it.cantidad, faltantes.length > 0);
      if (sumada) await auditar(q, req.ctx, 'salida_movimiento', 'salida', salida.id, { numero: salida.numero, proyecto: salida.proyecto, items }, { sucursalId: salida.sucursal_id });
      if (faltantes.length) await auditar(q, req.ctx, 'inventario_salida_sin_stock', 'salida', salida.id, { proyecto: salida.proyecto, faltantes: faltantes.map((f) => `${f.producto}: pidió ${f.pedido}, había ${f.hay}`) }, { sucursalId: salida.sucursal_id });
      const unidades = items.reduce((t, i) => t + i.cantidad, 0);
      return admin ? { ...(await cargar(q, req.ctx, salida.id)), sumada } : { id: salida.id, numero: salida.numero, proyecto: salida.proyecto, sumada, unidades };
    });
    res.status(out.sumada ? 200 : 201).json(out);
  }));

  // Sumar o restar material en una salida abierta: cantidad > 0 saca más de la bodega; < 0 devuelve.
  r.post('/salidas/:id/movimiento', requierePermiso('admin:empresa'), conFaltantes(async (req, res) => {
    const id = validar(uuid, req.params.id);
    const items = leerItems(req.body.items ?? [{ producto_id: req.body.producto_id, cantidad: req.body.cantidad }]);
    const out = await db.tx(async (q) => {
      await q.query('select 1 from dis.salidas where id = $1 and empresa_id = $2 for update', [id, req.ctx.empresa.id]);
      const salida = await cargar(q, req.ctx, id);
      if (!salida) throw noEncontrado('Salida no encontrada');
      if (salida.estado !== 'abierta') throw conflicto('El proyecto ya está cerrado: reábrelo para mover material');
      const faltantes = await revisarFaltantes(q, req.ctx, items, !!req.body.confirmar_sin_stock);
      for (const it of items) await mover(q, req.ctx, salida, it.producto_id, it.cantidad, faltantes.length > 0);
      await auditar(q, req.ctx, 'salida_movimiento', 'salida', id, { numero: salida.numero, proyecto: salida.proyecto, items }, { sucursalId: salida.sucursal_id });
      if (faltantes.length) await auditar(q, req.ctx, 'inventario_salida_sin_stock', 'salida', id, { proyecto: salida.proyecto, faltantes: faltantes.map((f) => `${f.producto}: pidió ${f.pedido}, había ${f.hay}`) }, { sucursalId: salida.sucursal_id });
      return cargar(q, req.ctx, id);
    });
    res.json(out);
  }));

  r.post('/salidas/:id/reabrir', requierePermiso('admin:empresa'), async (req, res) => {
    const id = validar(uuid, req.params.id);
    const out = await db.tx(async (q) => {
      const salida = await cargar(q, req.ctx, id);
      if (!salida) throw noEncontrado('Salida no encontrada');
      if (salida.estado !== 'cerrada') throw conflicto('La salida no está cerrada');
      await q.query(`update dis.salidas set estado='abierta', cerrada_at=null, cerrada_por=null where id=$1`, [id]);
      await auditar(q, req.ctx, 'salida_reabierta', 'salida', id, { numero: salida.numero, proyecto: salida.proyecto }, { sucursalId: salida.sucursal_id });
      return cargar(q, req.ctx, id);
    });
    res.json(out);
  });
}
