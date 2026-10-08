// Inventario de piedra terminada (producto terminado por lote y calidad): físico, reservado y disponible.
// La verdad vive en fab.lotes (F2); aquí se lee, se ajusta a mano y se hace el conteo sorpresa.
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { liberarVencidos, alerta } from '../fab/produccion.js';
import { round3 } from './calculo.js';

const entero = z.coerce.number().refine(Number.isInteger, 'La cantidad debe ser un número entero');

export function rutasInventarioEco({ db }) {
  const r = Router();
  const leer = requierePermiso('inv:ver');
  const escribe = requierePermiso('inv:mover');

  r.get('/pt', leer, async (req, res) => {
    const eid = req.ctx.empresa.id;
    await liberarVencidos(db, eid).catch(() => {});
    const [prods, lotes, secando] = await Promise.all([
      db.query(`select p.id, p.nombre, p.modelo, p.color, p.unidad_venta, p.m2_por_caja, p.stock_minimo as stock_minimo_m2, p.costo_estandar
                  from pos.productos p where p.empresa_id = $1 and p.es_piedra and p.activo order by p.nombre`, [eid]),
      db.query(`select producto_id, codigo as lote, calidad, estado, cantidad_disponible as fisico, cantidad_libre as disponible, cantidad_reservada as reservado, created_at as ultimo_movimiento
                  from fab.lotes where empresa_id = $1 and estado <> 'secado' and (cantidad_disponible <> 0) order by fecha_lista nulls last, created_at`, [eid]),
      db.query(`select producto_id, lote, m2_planificado, fecha_disponible::text as fecha_disponible from fab.ordenes where empresa_id = $1 and estado = 'curando'`, [eid]),
    ]);
    const ver = req.ctx.permisos.has('pos:catalogo');
    res.json(prods.rows.map((p) => {
      const ls = lotes.rows.filter((l) => l.producto_id === p.id).map((l) => ({ ...l, fisico: Number(l.fisico), disponible: Number(l.disponible), reservado: Number(l.reservado) }));
      const suma = (cal, campo) => round3(ls.filter((l) => l.calidad === cal).reduce((s, l) => s + l[campo], 0));
      const sec = secando.rows.filter((o) => o.producto_id === p.id);
      const disponible = suma('primera', 'disponible');
      return {
        ...p, costo_estandar: ver ? p.costo_estandar : undefined,
        unidad: p.unidad_venta === 'caja' ? 'cajas' : 'm²', esquina: p.unidad_venta === 'caja',
        en_secado: round3(sec.reduce((s, o) => s + Number(o.m2_planificado), 0)),
        lotes_secado: sec.map((o) => ({ lote: o.lote, cantidad: Number(o.m2_planificado), lista_el: o.fecha_disponible })),
        fisico_primera: suma('primera', 'fisico'), disponible_primera: disponible, reservado: suma('primera', 'reservado'), fisico_segunda: suma('segunda', 'fisico'),
        cajas_disponibles: Number(p.m2_por_caja) > 0 ? Math.floor(disponible / Number(p.m2_por_caja) + 1e-9) : null,
        bajo_minimo: Number(p.stock_minimo_m2) > 0 && disponible < Number(p.stock_minimo_m2),
        lotes: ls,
      };
    }));
  });

  r.get('/pt/kardex', leer, async (req, res) => {
    const f = validar(z.object({ producto_id: uuid.optional() }), req.query);
    const { rows } = await db.query(
      `select m.id, m.created_at, m.tipo, m.cantidad, m.motivo, m.ref_numero, m.venta_numero, l.codigo as lote, l.calidad, p.nombre as producto, u.nombre as usuario
         from fab.lote_movs m join fab.lotes l on l.id = m.lote_id join pos.productos p on p.id = l.producto_id left join core.usuarios u on u.id = m.usuario_id
        where m.empresa_id = $1 and ($2::uuid is null or l.producto_id = $2) order by m.id desc limit 300`, [req.ctx.empresa.id, f.producto_id ?? null]);
    res.json(rows);
  });

  async function moverFisico(q, ctx, lote, delta, tipo, motivo) {
    const nuevo = round3(Number(lote.cantidad_disponible) + delta);
    if (nuevo < 0) throw malaPeticion(`No puede quedar existencia negativa: el lote ${lote.codigo} tiene ${lote.cantidad_disponible}`);
    if (nuevo < Number(lote.cantidad_reservada)) throw malaPeticion(`El lote ${lote.codigo} tiene ${lote.cantidad_reservada} reservados para cotizaciones: libera la reserva antes de bajar la existencia`);
    await q.query(`update fab.lotes set cantidad_disponible = $2, estado = case when $2::numeric = 0 then 'agotado' when estado = 'agotado' then 'lista' else estado end where id = $1`, [lote.id, nuevo]);
    await q.query('insert into fab.lote_movs (empresa_id, lote_id, tipo, cantidad, motivo, usuario_id) values ($1,$2,$3,$4,$5,$6)', [ctx.empresa.id, lote.id, tipo, delta, motivo, ctx.usuario.id]);
  }

  // Ajuste manual (+/−) o carga de existencia inicial. Motivo obligatorio.
  r.post('/pt/ajuste', escribe, async (req, res) => {
    const b = validar(z.object({
      producto_id: uuid, lote: z.string().trim().min(1, 'Indica el lote').max(40), calidad: z.enum(['primera', 'segunda']).default('primera'),
      m2: entero.refine((n) => n !== 0, 'Indica la cantidad del ajuste'), motivo: z.string().trim().min(1, 'El motivo del ajuste es obligatorio').max(300),
      tipo: z.enum(['inicial', 'ajuste']).default('ajuste'), costo_m2: z.coerce.number().min(0).default(0),
    }), req.body);
    if (b.tipo === 'inicial' && b.m2 < 0) throw malaPeticion('La existencia inicial debe ser positiva');
    const out = await db.tx(async (q) => {
      const p = (await q.query('select nombre from pos.productos where id = $1 and empresa_id = $2 and es_piedra', [b.producto_id, req.ctx.empresa.id])).rows[0];
      if (!p) throw noEncontrado('Producto de piedra no encontrado');
      let lote = (await q.query('select * from fab.lotes where empresa_id = $1 and codigo = $2 and calidad = $3 for update', [req.ctx.empresa.id, b.lote, b.calidad])).rows[0];
      if (lote && lote.producto_id !== b.producto_id) throw malaPeticion(`El lote ${b.lote} pertenece a otro producto`);
      if (lote?.estado === 'secado') throw malaPeticion('Ese lote sigue en secado: se libera solo o desde Producción');
      if (!lote) {
        if (b.m2 < 0) throw malaPeticion('Ese lote no existe: no se le puede restar existencia');
        lote = (await q.query(
          `insert into fab.lotes (empresa_id, codigo, producto_id, calidad, estado, cantidad_producida, cantidad_disponible, costo_m2, fecha_lista, operario_id, operario)
           values ($1,$2,$3,$4,'lista',0,0,$5,now(),$6,$7) returning *`, [req.ctx.empresa.id, b.lote, b.producto_id, b.calidad, b.costo_m2, req.ctx.usuario.id, req.ctx.usuario.nombre])).rows[0];
      }
      await moverFisico(q, req.ctx, lote, b.m2, b.tipo, b.motivo);
      await auditar(q, req.ctx, `inventario_${b.tipo}`, 'producto', b.producto_id, { producto: p.nombre, lote: b.lote, m2: b.m2, motivo: b.motivo });
      if (b.tipo === 'ajuste') {
        await alerta(q, req.ctx, { tipo: 'inventario.ajuste_pt', severidad: Math.abs(b.m2) >= 50 ? 'alta' : 'media', entidad: 'producto', entidadId: b.producto_id,
          titulo: `Ajuste de inventario: ${b.m2 > 0 ? '+' : ''}${b.m2} de ${p.nombre} (${b.lote})`, detalle: { producto: p.nombre, lote: b.lote, m2: b.m2, motivo: b.motivo, por: req.ctx.usuario.nombre } });
      }
      return (await q.query('select * from fab.lotes where id = $1', [lote.id])).rows[0];
    });
    res.status(201).json(out);
  });

  // Conteo físico (también el sorpresa): compara lo contado con el sistema y ajusta la diferencia.
  r.post('/pt/conteo', escribe, async (req, res) => {
    const b = validar(z.object({ producto_id: uuid, lote: z.string().trim().min(1, 'Indica el lote'), calidad: z.enum(['primera', 'segunda']).default('primera'),
      contado: entero.refine((n) => n >= 0, 'Indica la cantidad contada') }), req.body);
    const out = await db.tx(async (q) => {
      const lote = (await q.query('select l.*, p.nombre from fab.lotes l join pos.productos p on p.id = l.producto_id where l.empresa_id = $1 and l.codigo = $2 and l.calidad = $3 and l.producto_id = $4 for update of l',
        [req.ctx.empresa.id, b.lote, b.calidad, b.producto_id])).rows[0];
      if (!lote) throw noEncontrado('Ese lote no existe');
      if (lote.estado === 'secado') throw prohibido('Ese lote sigue en secado: aún no se cuenta');
      const sistema = round3(Number(lote.cantidad_disponible));
      const diferencia = round3(b.contado - sistema);
      if (diferencia !== 0) {
        await moverFisico(q, req.ctx, lote, diferencia, 'ajuste', `Conteo físico: sistema ${sistema}, contado ${b.contado}`);
        await alerta(q, req.ctx, { tipo: 'inventario.conteo_diferencia', severidad: Math.abs(diferencia) >= 20 ? 'alta' : 'media', entidad: 'producto', entidadId: b.producto_id,
          titulo: `Conteo con diferencia: ${lote.nombre} ${lote.codigo} (${diferencia > 0 ? 'sobra' : 'falta'} ${Math.abs(diferencia)})`, detalle: { producto: lote.nombre, lote: lote.codigo, sistema, contado: b.contado, diferencia, por: req.ctx.usuario.nombre } });
      }
      await auditar(q, req.ctx, 'inventario_conteo', 'producto', b.producto_id, { producto: lote.nombre, lote: lote.codigo, sistema, contado: b.contado, diferencia });
      return { sistema, contado: b.contado, diferencia };
    });
    res.json(out);
  });

  return r;
}
