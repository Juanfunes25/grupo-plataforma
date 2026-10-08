import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanciaMetros, verificarUbicacion, tiendasSinAbrir, horaAMinutos, VERIFICACION } from './asistencia.js';

// Coordenadas reales de referencia en San Pedro Sula, para que los numeros sean creibles.
const TIENDA = { lat: 15.5041, lon: -88.0250, radio_metros: 150 };

test('mide bien una distancia corta conocida', () => {
  // ~111 metros al norte (0.001 grados de latitud).
  const d = distanciaMetros(15.5041, -88.025, 15.5051, -88.025);
  assert.ok(d > 105 && d < 118, `esperaba ~111 m, dio ${d}`);
});

test('la misma coordenada da distancia cero', () => {
  assert.equal(Math.round(distanciaMetros(15.5041, -88.025, 15.5041, -88.025)), 0);
});

test('marcar dentro del radio queda verificado', () => {
  const r = verificarUbicacion({ sucursal: TIENDA, lat: 15.5045, lon: -88.0252 });
  assert.equal(r.verificacion, VERIFICACION.DENTRO);
  assert.ok(r.distancia_metros < 150);
});

test('marcar desde lejos queda señalado, con la distancia, en vez de rechazado', () => {
  // ~5 km al sur: alguien marcando desde su casa.
  const r = verificarUbicacion({ sucursal: TIENDA, lat: 15.4600, lon: -88.0250 });
  assert.equal(r.verificacion, VERIFICACION.LEJOS);
  assert.ok(r.distancia_metros > 1000, 'debe registrar cuan lejos estaba');
});

test('sin ubicación del celular no se asume nada: queda como sin_ubicacion', () => {
  const r = verificarUbicacion({ sucursal: TIENDA, lat: null, lon: null });
  assert.equal(r.verificacion, VERIFICACION.SIN_UBICACION);
  assert.equal(r.distancia_metros, null);
});

test('si la tienda no tiene coordenadas cargadas no se culpa al empleado', () => {
  const r = verificarUbicacion({ sucursal: { lat: null, lon: null }, lat: 15.5, lon: -88.0 });
  assert.equal(r.verificacion, VERIFICACION.SIN_CONFIGURAR);
});

test('respeta un radio mas grande si la tienda lo tiene configurado', () => {
  const lejos = { lat: 15.5100, lon: -88.0250 };
  assert.equal(verificarUbicacion({ sucursal: TIENDA, ...lejos }).verificacion, VERIFICACION.LEJOS);
  assert.equal(
    verificarUbicacion({ sucursal: { ...TIENDA, radio_metros: 2000 }, ...lejos }).verificacion,
    VERIFICACION.DENTRO
  );
});

// ------------------------------------------------------- tiendas sin abrir

const horarios = [
  { sucursal_id: 'proceres', nombre: 'Próceres', entrada_minutos: 480 }, // 08:00
  { sucursal_id: 'mackey', nombre: 'Mackey', entrada_minutos: 540 },     // 09:00
];

test('avisa solo de la tienda que ya pasó su hora y nadie marcó', () => {
  // 08:30 con tolerancia 20 -> Proceres (8:00) esta atrasada, Mackey (9:00) todavia no.
  const r = tiendasSinAbrir({ horarios, marcaciones: [], ahoraMinutos: 510 });
  assert.equal(r.length, 1);
  assert.equal(r[0].sucursal_id, 'proceres');
  assert.equal(r[0].minutosDeAtraso, 30);
});

test('no avisa dentro de la tolerancia: recién arranca el turno', () => {
  const r = tiendasSinAbrir({ horarios, marcaciones: [], ahoraMinutos: 490 }); // 08:10
  assert.equal(r.length, 0);
});

test('si alguien ya marcó entrada, esa tienda deja de figurar', () => {
  const r = tiendasSinAbrir({
    horarios,
    marcaciones: [{ sucursal_id: 'proceres', tipo: 'entrada' }],
    ahoraMinutos: 600,
  });
  assert.deepEqual(r.map((x) => x.sucursal_id), ['mackey']);
});

test('una salida no cuenta como apertura', () => {
  const r = tiendasSinAbrir({
    horarios,
    marcaciones: [{ sucursal_id: 'proceres', tipo: 'salida' }],
    ahoraMinutos: 600,
  });
  assert.ok(r.some((x) => x.sucursal_id === 'proceres'));
});

test('una tienda sin turno hoy no genera aviso', () => {
  const r = tiendasSinAbrir({
    horarios: [{ sucursal_id: 'progreso', nombre: 'Progreso', entrada_minutos: null }],
    marcaciones: [],
    ahoraMinutos: 1200,
  });
  assert.equal(r.length, 0);
});

test('ordena primero la tienda con más atraso', () => {
  const r = tiendasSinAbrir({ horarios, marcaciones: [], ahoraMinutos: 700 });
  assert.equal(r[0].sucursal_id, 'proceres', 'la que abre antes lleva más atraso');
});

test('convierte la hora del horario a minutos y descarta basura', () => {
  assert.equal(horaAMinutos('08:30'), 510);
  assert.equal(horaAMinutos('8:05'), 485);
  assert.equal(horaAMinutos('00:00'), 0);
  assert.equal(horaAMinutos('libre'), null);
  assert.equal(horaAMinutos(''), null);
  assert.equal(horaAMinutos('99:99'), null);
});
