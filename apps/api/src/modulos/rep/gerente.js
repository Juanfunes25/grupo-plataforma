// Gerente digital de reposición: auditoría de la operación, gemelo digital (simulador «¿y si…?») y cobertura de personal.
// Es de dirección: mira personal, plata y datos de todas las tiendas (permiso gerente:ver).
import { Router } from 'express';
import { z } from 'zod';
import { fechaHN } from '@grupo/shared';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, validar, uuid } from '../../lib/http.js';
import { ejecutarAuditoria, fechaHasta, DIAS_DESCARTE } from './lib/gerente/auditoria.js';
import { ErrorDeSimulacion, resumenDeBase, simular } from './lib/gerente/simulador.js';
import { DIAS_HISTORIA, analizarCobertura } from './lib/gerente/cobertura.js';
import { baseSimulador, cargarDatosAuditoria, cargarDatosCobertura } from './datos.js';
import { empresaDe, sucursalDe } from './util.js';

export function rutasGerente({ db }) {
  const r = Router();
  const emp = empresaDe;
  r.use(requierePermiso('gerente:ver'));

  // El informe se calcula al pedirlo (no con un temporizador): siempre refleja el estado de ahora.
  r.get('/auditoria', async (req, res) => {
    const hoy = fechaHN();
    const datos = await cargarDatosAuditoria(db, emp(req), { hoy });
    const descartes = (await db.query('select huella, estado, nota, hasta::text as hasta from rep.gerente_descartes where empresa_id = $1 and hasta >= $2', [emp(req), hoy])).rows;
    res.json(ejecutarAuditoria(datos, { descartes }));
  });

  // «Lo vi» o «no es un problema»: el gerente deja de mencionarlo por un tiempo (vence, nada se oculta para siempre).
  r.post('/descartes', async (req, res) => {
    const b = validar(z.object({ huella: z.string().trim().min(1, 'Falta saber de qué hallazgo se trata').max(200), estado: z.enum(Object.keys(DIAS_DESCARTE), { errorMap: () => ({ message: 'Estado inválido' }) }), nota: z.string().trim().max(300).optional().nullable().transform((v) => v || null) }), req.body);
    const hasta = fechaHasta(b.estado, fechaHN());
    await db.tx(async (q) => {
      await q.query(
        `insert into rep.gerente_descartes (empresa_id, huella, estado, nota, hasta) values ($1,$2,$3,$4,$5)
         on conflict (empresa_id, huella) do update set estado = excluded.estado, nota = excluded.nota, hasta = excluded.hasta, created_at = now()`, [emp(req), b.huella, b.estado, b.nota, hasta]);
      await auditar(q, req.ctx, 'gerente.descartar', 'hallazgo', b.huella, { estado: b.estado, hasta });
    });
    res.json({ ok: true, hasta });
  });

  // Reabre un hallazgo descartado. La huella va en la query: lleva «:» y «|».
  r.delete('/descartes', async (req, res) => {
    const huella = String(req.query.huella || '').trim();
    if (!huella) throw malaPeticion('Falta saber de qué hallazgo se trata');
    await db.tx(async (q) => {
      await q.query('delete from rep.gerente_descartes where empresa_id = $1 and huella = $2', [emp(req), huella]);
      await auditar(q, req.ctx, 'gerente.reabrir', 'hallazgo', huella, {});
    });
    res.json({ ok: true });
  });

  // ── Gemelo digital ──
  r.get('/simulador/base', async (req, res) => {
    res.json(resumenDeBase(await baseSimulador(db, emp(req), { hoy: fechaHN() })));
  });
  // «¿Y si…?»: calcula el escenario sin tocar nada de la operación.
  r.post('/simulacion', async (req, res) => {
    try { res.json(simular(await baseSimulador(db, emp(req), { hoy: fechaHN() }), req.body?.cambios)); }
    catch (e) { if (e instanceof ErrorDeSimulacion) throw malaPeticion(e.message); throw e; }
  });

  // ── Ausentismo y cobertura ──
  r.get('/cobertura', async (req, res) => {
    const dias = Math.min(30, Math.max(7, Number.parseInt(req.query.dias, 10) || 14));
    const { datos, minimos } = await cargarDatosCobertura(db, emp(req), { hoy: fechaHN(), diasHistoria: DIAS_HISTORIA });
    res.json(analizarCobertura(datos, { dias, minimos }));
  });

  // Cuánta gente hace falta en una tienda un día de la semana. `minimo: null` vuelve a lo habitual.
  r.put('/cobertura/minimo', async (req, res) => {
    const b = validar(z.object({ sucursal_id: uuid, dia_semana: z.coerce.number().int('Día inválido').min(0, 'Día inválido').max(6, 'Día inválido'), minimo: z.union([z.null(), z.literal(''), z.coerce.number().int('El mínimo tiene que ser un número entero entre 0 y 20').min(0, 'El mínimo tiene que ser un número entero entre 0 y 20').max(20, 'El mínimo tiene que ser un número entero entre 0 y 20')]) }), req.body);
    const suc = await sucursalDe(db, req, b.sucursal_id);
    await db.tx(async (q) => {
      if (b.minimo === null || b.minimo === '') {
        await q.query('delete from rep.cobertura_minimos where sucursal_id = $1 and dia_semana = $2', [suc.id, b.dia_semana]);
      } else {
        await q.query(`insert into rep.cobertura_minimos (sucursal_id, empresa_id, dia_semana, minimo) values ($1,$2,$3,$4) on conflict (sucursal_id, dia_semana) do update set minimo = excluded.minimo`, [suc.id, emp(req), b.dia_semana, b.minimo]);
      }
      await auditar(q, req.ctx, 'cobertura.minimo', 'sucursal', suc.id, { sucursal: suc.nombre, dia_semana: b.dia_semana, minimo: b.minimo === '' ? null : b.minimo }, { sucursalId: suc.id });
    });
    res.json({ ok: true, minimo: b.minimo === '' ? null : b.minimo });
  });
  return r;
}
