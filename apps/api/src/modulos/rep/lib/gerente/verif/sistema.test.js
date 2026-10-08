import { test } from 'node:test';
import assert from 'node:assert/strict';
import { datosBase, dia } from '../fixtures.js';
import { seguridadConfiguracion, incidenciasSinCerrar, mantenimientoPendiente } from './sistema.js';

const entorno = (extra) => ({ produccion: true, jwtSecret: true, tursoToken: true, gemini: true, ...extra });

test('sin JWT_SECRET en producción lo marca como confirmado, y nunca muestra valores', () => {
  const r = seguridadConfiguracion(datosBase({ entorno: entorno({ jwtSecret: false }) }));
  assert.equal(r.hallazgos.length, 1);
  assert.equal(r.hallazgos[0].nivel, 'confirmado');
  assert.match(r.hallazgos[0].accion, /Railway/);
  assert.ok(!JSON.stringify(r).match(/secret-|dev-secret/i), 'no filtra ninguna clave');
});

test('sin JWT_SECRET ni token de la base es gravedad alta: la clave es pública', () => {
  const r = seguridadConfiguracion(datosBase({ entorno: entorno({ jwtSecret: false, tursoToken: false }) }));
  assert.equal(r.hallazgos[0].gravedad, 'alta');
  assert.match(r.hallazgos[0].titulo, /clave pública/);
});

test('con todo configurado no dice nada', () => {
  assert.equal(seguridadConfiguracion(datosBase({ entorno: entorno() })).hallazgos.length, 0);
});

test('en desarrollo no audita la configuración de producción', () => {
  assert.equal(seguridadConfiguracion(datosBase({ entorno: entorno({ produccion: false, jwtSecret: false }) })).estado, 'sin_datos');
});

test('la falta de la clave de IA es para observar, no una alerta', () => {
  const r = seguridadConfiguracion(datosBase({ entorno: entorno({ gemini: false }) }));
  assert.equal(r.hallazgos[0].nivel, 'observar');
});

const incidencia = (extra) => ({ id: 1, tipo: 'equipo', gravedad: 'media', sucursal_id: 'mackey', descripcion: 'Se rompió el congelador', estado: 'abierta', creado_en: `${dia(-10)} 12:00:00`, ...extra });

test('una incidencia alta abierta hace 3 días ya pasó su plazo; una baja de 3 días no', () => {
  assert.equal(incidenciasSinCerrar(datosBase({ incidencias: [incidencia({ gravedad: 'alta', creado_en: `${dia(-3)} 10:00:00` })] })).hallazgos.length, 1);
  assert.equal(incidenciasSinCerrar(datosBase({ incidencias: [incidencia({ gravedad: 'baja', creado_en: `${dia(-3)} 10:00:00` })] })).hallazgos.length, 0);
});

test('las incidencias cerradas no cuentan, por viejas que sean', () => {
  assert.equal(incidenciasSinCerrar(datosBase({ incidencias: [incidencia({ estado: 'cerrada', creado_en: `${dia(-90)} 10:00:00` })] })).hallazgos.length, 0);
});

test('un equipo sin cerrar hace 3 semanas es un registro "por ordenar", no una alarma; uno reciente o listo no aparece', () => {
  const m = (extra) => ({ id: 1, equipo: 'Máquina de café', sucursal_id: 'mackey', fecha: dia(-21), listo: 0, ...extra });
  const r = mantenimientoPendiente(datosBase({ mantenimientos: [m()] }));
  assert.equal(r.hallazgos.length, 0);
  assert.equal(r.limpieza.length, 1);
  assert.match(r.limpieza[0].evidencia[0], /Máquina de café/);
  assert.equal(mantenimientoPendiente(datosBase({ mantenimientos: [m({ fecha: dia(-3) })] })).limpieza.length, 0);
  assert.equal(mantenimientoPendiente(datosBase({ mantenimientos: [m({ listo: 1 })] })).limpieza.length, 0);
});
