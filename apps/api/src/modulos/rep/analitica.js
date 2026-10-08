import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, validar, fechaISO } from '../../lib/http.js';
import { resolverRango, FECHA_ISO } from './lib/rangoFechas.js';
import { sumarDias } from './lib/fechasSemana.js';
import { CLASIFICACION } from './lib/rotacion.js';
import { armarInsumosDespachados } from './lib/insumosDespachados.js';
import { armarResumen, formatearResumenHtml, formatearResumenTexto } from './lib/resumen.js';
import { PERM_ADMIN, empresaDe } from './util.js';
import { analisisDe, consumoDeRango, existeTabla, insumosMasDespachados, opcional, recomendacionDespachoDeDatos, rotacionDeSabores } from './datos.js';

export function rutasAnalitica({ db }) {
  const r = Router();
  const emp = empresaDe;
  const rango = (query) => { const x = resolverRango(query); if (x.error) throw malaPeticion(x.error); return x; };
  const hoyDe = (q) => (FECHA_ISO.test(q.hoy || '') ? q.hoy : fechaHN());

  // ── Resumen del dueño: discrepancias abiertas, producción del día, sabores parados ──
  r.get('/dueno/:fecha', requierePermiso('rep:ver'), async (req, res) => {
    const fecha = validar(fechaISO, req.params.fecha);
    const dias = Math.min(Math.max(Number(req.query.dias) || 14, 1), 90);
    const [sucursales, discrepancias, produccion, rotacion] = await Promise.all([
      db.query('select s.id, s.nombre from core.sucursales s left join rep.sucursal_config c on c.sucursal_id = s.id where s.empresa_id = $1 and s.activo and not coalesce(c.cerrada,false) order by s.nombre', [emp(req)]).then((x) => x.rows),
      db.query(
        `select d.id, d.fecha::text as fecha, d.sucursal_id, d.sabor_id, d.categoria, d.panas, d.gramos_enviados, d.estado, d.gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos, d.panas_recibidas,
                d.discrepancia::int as discrepancia, d.discrepancia_resuelta::int as discrepancia_resuelta, d.enviado_en::text as enviado_en, sa.nombre as sabor_nombre, su.nombre as sucursal_nombre
           from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
          where d.empresa_id = $1 and d.discrepancia and not d.discrepancia_resuelta and d.fecha >= ($2::date - $3::int) order by d.fecha desc`, [emp(req), fecha, dias]).then((x) => x.rows),
      opcional(db, `select coalesce(sum(kg),0)::float8 as kg from prod.producciones where empresa_id = $1 and fecha = $2`, [emp(req), fecha]),
      rotacionDeSabores(db, emp(req), { desde: sumarDias(fecha, -29), hasta: fecha, hoy: fecha }),
    ]);
    const saboresParados = rotacion.sabores.filter((s) => s.clasificacion === CLASIFICACION.LENTO || s.clasificacion === CLASIFICACION.MUERTO).sort((a, b) => a.despachadoGramos - b.despachadoGramos).slice(0, 5);
    res.json({ fecha, porSucursal: sucursales, discrepancias, produccionHoyKg: produccion[0]?.kg || 0, produccionHoyCostoLps: 0, movimientosHoy: [], movimientosHoyResumen: { entrada: 0, salida: 0 }, saboresParados });
  });

  /**
   * Todo lo que la pantalla del despachador necesita en una sola respuesta (en un celular con mala señal, una espera
   * y no tres). Pedidos solo del día y el anterior: el pedido siempre se manda de noche.
   */
  r.get('/panel-despacho/:fecha', requierePermiso('rep:despachar'), async (req, res) => {
    const fecha = validar(fechaISO, req.params.fecha);
    const anterior = sumarDias(fecha, -1);
    // Lo pesado después de la medianoche (hasta el mediodía) lleva la fecha del día nuevo pero es parte de ESTA noche.
    const siguiente = sumarDias(fecha, 1);
    const corteMadrugada = `((($2::date + 1)::timestamp + interval '18 hours') at time zone 'UTC')`;
    const [despachos, pedidos, ultima, reportes] = await Promise.all([
      db.query(
        `select d.id, d.fecha::text as fecha, d.sucursal_id, d.sabor_id, d.categoria, d.panas, d.gramos_enviados, d.estado, d.gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos, d.panas_recibidas,
                d.discrepancia::int as discrepancia, d.discrepancia_resuelta::int as discrepancia_resuelta, d.notas, d.enviado_en::text as enviado_en, sa.nombre as sabor_nombre, su.nombre as sucursal_nombre
           from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id
          where d.empresa_id = $1 and (d.fecha = $2 or (d.fecha = $2::date + 1 and exists (
                  select 1 from rep.pesajes p where p.empresa_id = d.empresa_id and p.sucursal_id = d.sucursal_id and p.sabor_id = d.sabor_id and p.fecha = d.fecha and p.created_at < ${corteMadrugada})))
          order by su.nombre, d.categoria, sa.nombre`, [emp(req), fecha]).then((x) => x.rows),
      db.query(
        `select p.id, p.sucursal_id, p.fecha::text as fecha, p.notas, p.estado, p.created_at as creado_en, su.nombre as sucursal_nombre
           from rep.pedidos_insumos p join core.sucursales su on su.id = p.sucursal_id where p.empresa_id = $1 and (p.fecha in ($2,$3) or (p.fecha = $4 and p.created_at < ${corteMadrugada})) order by p.created_at desc`, [emp(req), fecha, anterior, siguiente]).then((x) => x.rows),
      // Pista antes de ir al freezer: cuándo y cuánto se produjo de cada sabor por última vez.
      opcional(db, `select p.sabor_id, p.fecha::text as fecha, sum(p.kg)::float8 as kg from prod.producciones p
                      join (select sabor_id, max(fecha) as fecha from prod.producciones where empresa_id = $1 group by sabor_id) u on u.sabor_id = p.sabor_id and u.fecha = p.fecha
                     where p.empresa_id = $1 group by p.sabor_id, p.fecha`, [emp(req)]),
      // A qué hora mandó su reporte cada tienda: el último pesaje cargado esa noche.
      db.query(`select sucursal_id, max(created_at) as reportado_en from rep.pesajes where empresa_id = $1 and (fecha = $2 or (fecha = $2::date + 1 and created_at < ${corteMadrugada})) group by sucursal_id`, [emp(req), fecha]).then((x) => x.rows),
    ]);
    if (pedidos.length) {
      const items = (await db.query('select id, pedido_id, insumo_texto, cantidad, preparado::int as preparado, enviado::int as enviado from rep.pedido_items where pedido_id = any($1::uuid[]) order by created_at, id', [pedidos.map((p) => p.id)])).rows;
      for (const p of pedidos) p.items = items.filter((i) => i.pedido_id === p.id);
    }
    const porSucursal = {}; const porSabor = {};
    for (const f of despachos) {
      (porSucursal[f.sucursal_id] ||= []).push(f);
      porSabor[f.sabor_id] ||= { nombre: f.sabor_nombre, totalPanas: 0, destinos: [] };
      porSabor[f.sabor_id].totalPanas += f.panas;
      porSabor[f.sabor_id].destinos.push({ despachoId: f.id, sucursal: f.sucursal_nombre, sucursalId: f.sucursal_id, categoria: f.categoria, panas: f.panas, gramos: f.gramos_enviados, estado: f.estado, notas: f.notas });
    }
    const ultimaProduccion = {}; for (const f of ultima) ultimaProduccion[f.sabor_id] = { fecha: f.fecha, kg: f.kg };
    const reportadoPorSucursal = {}; for (const f of reportes) reportadoPorSucursal[f.sucursal_id] = f.reportado_en;
    res.json({ fecha, porSucursal, porSabor, pedidos, ultimaProduccion, reportadoPorSucursal });
  });

  // Rotación: qué sabores se mueven y cuáles no, por sabor y por sucursal (sin datos de venta por sabor).
  r.get('/rotacion', requierePermiso('rep:ver'), async (req, res) => {
    const x = rango(req.query);
    res.json(await rotacionDeSabores(db, emp(req), { desde: x.desde, hasta: x.hasta, hoy: x.hasta }));
  });

  r.get('/insumos-despachados', requierePermiso('rep:ver'), async (req, res) => {
    const x = rango(req.query);
    res.json({ desde: x.desde, hasta: x.hasta, insumos: armarInsumosDespachados(await insumosMasDespachados(db, emp(req), x)) });
  });

  // Cuánto mandar de cada sabor a cada tienda el día que le toca reparto (ventana larga: la mediana por día de la semana necesita repeticiones).
  r.get('/recomendacion-despacho', requierePermiso('rep:ver'), async (req, res) => {
    const x = rango({ ...req.query, dias: req.query.dias || 90 });
    res.json(await recomendacionDespachoDeDatos(db, emp(req), { desde: x.desde, hasta: x.hasta, hoy: hoyDe(req.query) }));
  });

  // Consumo medido en vitrina por sucursal/sabor/día, cruzado con la venta del POS.
  r.get('/consumo', requierePermiso('rep:ver'), async (req, res) => {
    const x = rango({ ...req.query, dias: req.query.dias || 14 });
    res.json(await consumoDeRango(db, emp(req), x));
  });

  // ── Resumen diario (lista de envíos) ──
  async function construirResumen(q, empresaId, fecha) {
    const filas = (await q.query(
      `select d.sucursal_id, d.categoria, d.gramos_enviados, d.estado, d.discrepancia, d.gramos_confirmados_recibidos::float8 as gramos_confirmados_recibidos, sa.nombre as sabor_nombre, su.nombre as sucursal_nombre
         from rep.despachos d join rep.sabores sa on sa.id = d.sabor_id join core.sucursales su on su.id = d.sucursal_id where d.empresa_id = $1 and d.fecha = $2`, [empresaId, fecha])).rows;
    // Alertas de inventario (stock bajo mínimo): las aporta Inventario (R3) cuando está conectado.
    return armarResumen({ fecha, filas, alertas: [] });
  }
  r.get('/resumen/:fecha', requierePermiso('rep:ver'), async (req, res) => {
    const fecha = validar(fechaISO, req.params.fecha);
    const resumen = await construirResumen(db, emp(req), fecha);
    const guardado = (await db.query('select estado, updated_at, detalle from rep.resumenes where empresa_id = $1 and fecha = $2', [emp(req), fecha])).rows[0] || null;
    res.json({ ...resumen, texto: formatearResumenTexto(resumen), html: formatearResumenHtml(resumen), correoConfigurado: false, envio: guardado });
  });

  /** El correo no está configurado en el servidor: el contenido queda listo y el envío «pendiente de configurar». */
  r.post('/resumen/:fecha/enviar', requierePermiso(PERM_ADMIN), async (req, res) => {
    const fecha = validar(fechaISO, req.params.fecha);
    const resumen = await construirResumen(db, emp(req), fecha);
    const texto = formatearResumenTexto(resumen); const html = formatearResumenHtml(resumen);
    const detalle = 'El servidor no tiene correo configurado. El resumen quedó guardado y listo para enviarse cuando se configure.';
    await db.tx(async (q) => {
      await q.query(
        `insert into rep.resumenes (empresa_id, fecha, estado, asunto, texto, html, detalle) values ($1,$2,'pendiente_configurar',$3,$4,$5,$6)
         on conflict (empresa_id, fecha) do update set estado = 'pendiente_configurar', asunto = excluded.asunto, texto = excluded.texto, html = excluded.html, detalle = excluded.detalle, updated_at = now()`,
        [emp(req), fecha, `Lista de envíos para hoy - ${fecha}`, texto, html, detalle]);
      await auditar(q, req.ctx, 'resumen.envio_pendiente', 'resumen', fecha, { despachos: resumen.totalDespachos });
    });
    res.json({ ok: true, enviado: false, estado: 'pendiente_configurar', mensaje: detalle });
  });
  return r;
}
