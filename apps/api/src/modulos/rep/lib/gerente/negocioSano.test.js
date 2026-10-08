import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dia, negocioSano } from './fixtures.js';
import { ejecutarAuditoria } from './auditoria.js';

/**
 * LA PRUEBA DE QUE EL GERENTE NO GRITA LOBO.
 *
 * Un auditor se mide por dos cosas: que encuentre lo que está mal, y que NO invente problemas
 * donde no los hay. Lo segundo es lo que hace que el dueño siga leyéndolo meses después.
 *
 * Acá se simulan 60 días de un negocio que funciona bien pero NO perfecto: las balanzas varían,
 * de vez en cuando alguien cuenta una pana de más, el GPS del teléfono falla un par de veces,
 * y alguien se olvida de marcar la salida. Todo eso es ruido normal, y el gerente no puede
 * dar ninguna alerta firme por eso.
 */

test('un negocio sano, con el ruido normal de balanzas, GPS y olvidos, no recibe ninguna alerta firme', () => {
  const r = ejecutarAuditoria(negocioSano());
  const firmes = r.hallazgos.map((h) => `${h.nivel} · ${h.huella}: ${h.titulo} | ${h.evidencia.slice(0, 2).join(' ; ')}`);
  assert.deepEqual(firmes, [], `el gerente gritó lobo:\n${firmes.join('\n')}`);
  assert.equal(r.errores.length, 0);
  assert.equal(r.patrones.length, 0, 'ni historias inventadas sobre problemas que no existen');
});

test('el mismo negocio sano, pero con un problema real plantado, sí lo encuentra', () => {
  const datos = negocioSano();
  // Plantamos un problema real: en Próceres, 4 noches el pesaje de PISTACHO sube sin que llegue nada.
  // Esas noches subimos el peso +2.5 kg sin que haya entrada.
  const alterados = datos.pesajes.map((p) => {
    const offset = Math.round((new Date(`${p.fecha}T00:00:00Z`) - new Date(`${dia(0)}T00:00:00Z`)) / 86400000);
    if (p.sucursal_id === 'proceres' && p.sabor_id === 1 && [-23, -19, -13, -7].includes(offset)) return { ...p, gramos: p.gramos + 2500 };
    return p;
  });
  const r = ejecutarAuditoria({ ...datos, pesajes: alterados });
  const h = r.hallazgos.find((x) => x.verificacion === 'pesaje_sube_sin_entrada' && x.sucursal_id === 'proceres');
  assert.ok(h, 'encontró el problema plantado en Próceres');
  assert.ok(!r.hallazgos.some((x) => x.sucursal_id === 'mackey'), 'y no acusó a la tienda que estaba bien');
});
