// Qué tanda de producción se fue en qué despacho (trazabilidad), portado de lib/despachoTandas.js.
//
// El vínculo se escribe cuando el despachador manda las panas: en ese momento se sabe cuál es la
// producción más vieja que sigue en cámara (FIFO), que es el criterio con el que se despacha en la
// práctica. Una trazabilidad basada en suposiciones no sirve para contestar a qué tienda fue un lote.
//
// Las tandas viven en el esquema de Producción (R2): `prod.producciones (id, empresa_id, sabor_id,
// fecha, kg, kg_restante)`. Si esa tabla no existe todavía (o cambia), el despacho funciona igual
// y la tanda queda «sin identificar»: la trazabilidad nunca bloquea el envío.
import { repartirFifo, redondear } from './lib/fifo.js';
import { existeTabla } from './datos.js';

/** Suelta lo anterior y reparte de nuevo con `gramos`. Devuelve los gramos sin tanda identificada. */
export async function reasignarTandas(q, { empresaId, despachoId, saborId, gramos, fecha }) {
  const cantidadKg = redondear(Number(gramos) / 1000);
  const previas = (await q.query('select produccion_id, gramos::float8 as gramos from rep.despacho_tandas where despacho_id = $1', [despachoId])).rows;
  const hayProd = await existeTabla(q, 'prod.producciones');

  await q.query('savepoint tandas');
  try {
    const liberado = new Map();
    for (const p of previas) liberado.set(p.produccion_id, redondear((liberado.get(p.produccion_id) || 0) + p.gramos / 1000));
    if (hayProd) {
      for (const [id, kg] of liberado) await q.query('update prod.producciones set kg_restante = kg_restante + $1 where id = $2', [kg, id]);
    }
    await q.query('delete from rep.despacho_tandas where despacho_id = $1', [despachoId]);
    if (!(cantidadKg > 0)) { await q.query('release savepoint tandas'); return 0; }
    if (!hayProd) { await q.query('release savepoint tandas'); return redondear(cantidadKg * 1000); }

    const tandas = (await q.query(
      `select id, kg_restante::float8 as kg_restante from prod.producciones
        where empresa_id = $1 and sabor_id = $2 and fecha <= $3 order by fecha asc, id asc`, [empresaId, saborId, fecha])).rows;
    const disponibles = tandas.map((t) => ({ id: t.id, restante: redondear(Number(t.kg_restante)) })).filter((t) => t.restante > 0);
    const { tomas, sinOrigen } = repartirFifo({ disponibles, cantidad: cantidadKg });
    for (const t of tomas) {
      await q.query('insert into rep.despacho_tandas (empresa_id, despacho_id, produccion_id, gramos) values ($1,$2,$3,$4)', [empresaId, despachoId, t.id, redondear(t.cantidad * 1000)]);
      await q.query('update prod.producciones set kg_restante = kg_restante - $1 where id = $2', [t.cantidad, t.id]);
    }
    await q.query('release savepoint tandas');
    return redondear(sinOrigen * 1000);
  } catch {
    // La trazabilidad no debe tumbar el envío: se deshace solo el reparto de tandas.
    await q.query('rollback to savepoint tandas');
    return redondear(cantidadKg * 1000);
  }
}

/** Devuelve a cámara los kg de un despacho (se marcó «no disponible» o se deshizo). */
export const soltarTandas = (q, args) => reasignarTandas(q, { ...args, gramos: 0 });
