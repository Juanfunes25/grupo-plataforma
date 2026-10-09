import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { iniciar } from './helpers.js';
import { codigoTotp, desdeBase32, base32, pasoActual, verificarTotp, cifrarSecreto, descifrarSecreto, normalizarCodigoRecuperacion } from '../src/auth/mfa.js';
import { problemaClave, problemaPin } from '../src/auth/politica.js';

let t, dueno, admin;
const unaVez = (secreto, delta = 0) => codigoTotp(secreto, pasoActual() + delta);

before(async () => {
  t = await iniciar();
  await t.usuario({ nombre: 'Dueño Grupo', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Italo', email: 'admin@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'admin' }] });
  await t.usuario({ nombre: 'Gerente Italo', email: 'gerente@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Caja Italo', accesos: [{ empresa: 'italo', rol: 'cajero', pin: '4821' }] });
  dueno = t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo');
  admin = t.cli(await t.login('italo', 'admin@italo.hn', 'ClaveSegura123'), 'italo');
});
after(() => t.cerrar());
const reiniciarLimites = () => { const l = t.app.locals.limitadores; l.limMfa.reiniciar(); l.limLogin.reiniciar(); l.limPin.reiniciar(); };

test('TOTP cumple los vectores de la RFC 6238 (SHA-1)', () => {
  const secreto = base32(Buffer.from('12345678901234567890'));
  assert.equal(secreto, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(codigoTotp(secreto, Math.floor(59 / 30)), '287082');
  assert.equal(codigoTotp(secreto, Math.floor(1111111109 / 30)), '081804');
  assert.equal(codigoTotp(secreto, Math.floor(1234567890 / 30)), '005924');
  assert.deepEqual(desdeBase32(secreto), Buffer.from('12345678901234567890'));
  // admite un paso de desfase y no más; y un código no se usa dos veces
  const ahora = 1_111_111_109_000;
  assert.equal(verificarTotp(secreto, '081804', { ahoraMs: ahora }), Math.floor(1111111109 / 30));
  assert.equal(verificarTotp(secreto, '081804', { ahoraMs: ahora + 30_000 }), Math.floor(1111111109 / 30));
  assert.equal(verificarTotp(secreto, '081804', { ahoraMs: ahora + 90_000 }), null);
  assert.equal(verificarTotp(secreto, '081804', { ahoraMs: ahora, ultimoPaso: Math.floor(1111111109 / 30) }), null);
  assert.equal(verificarTotp(secreto, '12345', { ahoraMs: ahora }), null);
});

test('el secreto se guarda cifrado y no se descifra con otra llave', () => {
  const c = { jwtSecret: 'a'.repeat(40) };
  const guardado = cifrarSecreto(c, 'JBSWY3DPEHPK3PXP');
  assert.ok(!guardado.includes('JBSWY3DPEHPK3PXP'));
  assert.equal(descifrarSecreto(c, guardado), 'JBSWY3DPEHPK3PXP');
  assert.throws(() => descifrarSecreto({ jwtSecret: 'b'.repeat(40) }, guardado));
  // MFA_KEY independiente: rotar el secreto de sesión no rompe el 2FA
  assert.equal(descifrarSecreto({ jwtSecret: 'otro'.repeat(10), mfaKey: 'llave-fija' }, cifrarSecreto({ jwtSecret: 'x'.repeat(40), mfaKey: 'llave-fija' }, 'ABC')), 'ABC');
  assert.equal(normalizarCodigoRecuperacion('abcde fghjk'), 'ABCDE-FGHJK');
  assert.equal(normalizarCodigoRecuperacion('corto'), null);
});

test('política de contraseñas: mínimo 8 y nada trivial', () => {
  for (const mala of ['corta1', '12345678', '11111111', 'password', 'Password1'.toLowerCase() + '', 'abcdefgh', 'qwertyuiop', '87654321', 'honduras', 'aaaaaaaa'])
    assert.ok(problemaClave(mala), mala);
  assert.ok(problemaClave('maria.lopez2026', { email: 'maria.lopez@x.hn' }), 'no debe contener el correo');
  assert.ok(problemaClave('MariaPerez12', { nombre: 'Maria Perez' }), 'no debe ser su nombre');
  for (const buena of ['ClaveSegura123', 'Demo-Grupo-2026', 'mala-clave', 'cafe con leche 77']) assert.equal(problemaClave(buena), null, buena);
  assert.equal(problemaPin('1234', { pin_largo_min: 4, pin_largo_max: 6 }), null);
  assert.ok(problemaPin('123', { pin_largo_min: 4, pin_largo_max: 6 }));
  assert.ok(problemaPin('1234567', { pin_largo_min: 4, pin_largo_max: 6 }));
  assert.ok(problemaPin('1234', { pin_largo_min: 6, pin_largo_max: 6 }));
});

test('las contraseñas triviales se rechazan al crear usuarios, restablecer y cambiar la propia', async () => {
  const nuevo = (password) => admin.post('/api/admin/usuarios', { nombre: 'Nuevo Gerente', email: `n${Math.random().toString(36).slice(2, 7)}@italo.hn`, password, rol: 'gerente' });
  const r = await nuevo('12345678');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /fácil|común|secuencia/i);
  assert.equal((await nuevo('ClaveSegura456')).status, 201);
  const gid = (await t.db.query(`select id from core.usuarios where email = 'gerente@italo.hn'`)).rows[0].id;
  assert.equal((await admin.post(`/api/admin/usuarios/${gid}/password`, { password: 'qwertyuiop' })).status, 400);
  assert.equal((await admin.post(`/api/admin/usuarios/${gid}/password`, { password: 'OtraClave98765' })).status, 200);
  const g = t.cli(await t.login('italo', 'gerente@italo.hn', 'OtraClave98765'), 'italo');
  assert.equal((await g.post('/api/auth/cambiar-password', { actual: 'OtraClave98765', nueva: 'password1' })).status, 400);
  assert.equal((await g.post('/api/auth/cambiar-password', { actual: 'OtraClave98765', nueva: 'OtraClave98765' })).status, 400);
});

test('el largo del PIN sigue la política (4 a 6 dígitos, configurable por el dueño)', async () => {
  const caja = (pin) => admin.post('/api/admin/usuarios', { nombre: 'Cajera Nueva', rol: 'cajero', pin });
  assert.equal((await caja('1234567')).status, 400);
  assert.equal((await caja('123')).status, 400);
  assert.equal((await caja('482615')).status, 201);
  // solo el dueño del grupo cambia la política
  assert.equal((await admin.put('/api/admin/seguridad', { pin_largo_min: 6 })).status, 403);
  assert.equal((await dueno.put('/api/admin/seguridad', { pin_largo_min: 6, pin_largo_max: 5 })).status, 400);
  assert.equal((await dueno.put('/api/admin/seguridad', { pin_largo_min: 5, pin_largo_max: 6 })).status, 200);
  assert.equal((await caja('4827')).status, 400);
  assert.equal((await caja('48273')).status, 201);
  assert.equal((await dueno.put('/api/admin/seguridad', { pin_largo_min: 4, pin_largo_max: 6 })).status, 200);
  assert.equal((await caja('4828')).status, 201);
  // quien ya tenía un PIN de 4 dígitos sigue entrando
  assert.ok(await t.loginPin('italo', '4821'));
});

test('verificación en dos pasos: activar, entrar con el código, no reutilizarlo y usar códigos de recuperación', async () => {
  reiniciarLimites();
  const est0 = (await admin.get('/api/auth/2fa/estado')).body;
  assert.equal(est0.activo, false);
  assert.equal(est0.disponible, true);
  const ini = (await admin.post('/api/auth/2fa/iniciar')).body;
  assert.match(ini.uri, /^otpauth:\/\/totp\//);
  assert.match(ini.secreto, /^[A-Z2-7]{32}$/);
  const guardado = (await t.db.query(`select secreto_cifrado from core.usuarios_mfa`)).rows[0].secreto_cifrado;
  assert.ok(!guardado.includes(ini.secreto), 'el secreto no se guarda en claro');
  assert.equal((await admin.post('/api/auth/2fa/activar', { codigo: '000000' })).status, 400);
  const act = await admin.post('/api/auth/2fa/activar', { codigo: unaVez(ini.secreto) });
  assert.equal(act.status, 200);
  assert.equal(act.body.codigos_recuperacion.length, 10);
  assert.match(act.body.codigos_recuperacion[0], /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal((await admin.get('/api/auth/2fa/estado')).body.codigos_restantes, 10);

  // Login: la contraseña sola ya no da sesión
  const paso1 = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'admin@italo.hn', password: 'ClaveSegura123' });
  assert.equal(paso1.status, 200);
  assert.equal(paso1.body.requiere_2fa, true);
  assert.equal(paso1.body.token, undefined);
  // el desafío no sirve como sesión
  assert.equal((await t.cli(paso1.body.desafio, 'italo').get('/api/auth/yo')).status, 401);
  // código malo
  assert.equal((await t.cli().post('/api/auth/login-2fa', { desafio: paso1.body.desafio, codigo: '111111' })).status, 401);
  // código bueno (el siguiente paso: el actual ya se usó al activar)
  const ok = await t.cli().post('/api/auth/login-2fa', { desafio: paso1.body.desafio, codigo: unaVez(ini.secreto, 1) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.token);
  // el mismo código no vale dos veces
  const repetido = await t.cli().post('/api/auth/login-2fa', { desafio: paso1.body.desafio, codigo: unaVez(ini.secreto, 1) });
  assert.equal(repetido.status, 401);
  // un desafío de 2FA no sirve para configurar (no es la fase)
  assert.equal((await t.cli().post('/api/auth/2fa/configurar', { desafio: paso1.body.desafio })).status, 400);

  // Código de recuperación: sirve una sola vez
  const rec = act.body.codigos_recuperacion[0];
  const p2 = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'admin@italo.hn', password: 'ClaveSegura123' });
  const conRec = await t.cli().post('/api/auth/login-2fa', { desafio: p2.body.desafio, codigo: rec.toLowerCase().replace('-', ' ') });
  assert.equal(conRec.status, 200);
  assert.match(conRec.body.aviso, /9/);
  const p3 = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'admin@italo.hn', password: 'ClaveSegura123' });
  assert.equal((await t.cli().post('/api/auth/login-2fa', { desafio: p3.body.desafio, codigo: rec })).status, 401);
  const acciones = (await dueno.get('/api/admin/auditoria?accion=mfa_')).body.map((a) => a.accion);
  assert.ok(acciones.includes('mfa_activado') && acciones.includes('mfa_codigo_recuperacion_usado'), acciones.join());
});

test('intentos de código limitados: tras 6 fallos se bloquea y avisa con 429', async () => {
  reiniciarLimites();
  const p = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'admin@italo.hn', password: 'ClaveSegura123' });
  let ultimo;
  for (let i = 0; i < 7; i++) ultimo = await t.cli().post('/api/auth/login-2fa', { desafio: p.body.desafio, codigo: '000000' });
  assert.equal(ultimo.status, 429);
  reiniciarLimites();
});

test('«Mis sesiones»: lista dispositivos y permite cerrar una a distancia', async () => {
  reiniciarLimites();
  // gerente: dos sesiones desde «equipos» distintos
  const entrar = async (ua) => {
    const r = await fetch(`${t.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': ua, 'x-dispositivo': `dev-${ua.length}` }, body: JSON.stringify({ empresa: 'italo', email: 'gerente@italo.hn', password: 'OtraClave98765' }) });
    return (await r.json()).token;
  };
  const tPc = await entrar('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36');
  const tCel = await entrar('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1');
  const pc = t.cli(tPc, 'italo'), cel = t.cli(tCel, 'italo');
  const lista = (await pc.get('/api/auth/sesiones')).body;
  assert.ok(lista.length >= 2);
  assert.equal(lista.filter((s) => s.actual).length, 1);
  assert.ok(lista.some((s) => s.navegador === 'Chrome en Windows'));
  const iphone = lista.find((s) => /iPhone/.test(s.navegador));
  assert.ok(iphone, JSON.stringify(lista.map((s) => s.navegador)));
  // cierre remoto: el celular deja de funcionar de inmediato
  assert.equal((await cel.get('/api/auth/yo')).status, 200);
  assert.equal((await pc.del(`/api/auth/sesiones/${iphone.id}`)).status, 200);
  assert.equal((await cel.get('/api/auth/yo')).status, 401);
  assert.equal((await pc.del(`/api/auth/sesiones/${iphone.id}`)).status, 404);
  // nadie cierra sesiones ajenas
  const ajena = (await t.cli(await t.login('italo', 'dueno@grupo.hn', 'ClaveSegura123'), 'italo').get('/api/auth/sesiones')).body[0];
  assert.equal((await pc.del(`/api/auth/sesiones/${ajena.id}`)).status, 404);
  // cerrar las demás deja viva solo la actual
  const otra = t.cli(await entrar('Mozilla/5.0 (Android 14) Chrome/126.0 Mobile Safari/537.36'), 'italo');
  const r = await pc.post('/api/auth/sesiones/cerrar-otras');
  assert.ok(r.body.cerradas >= 1);
  assert.equal((await otra.get('/api/auth/yo')).status, 401);
  assert.equal((await pc.get('/api/auth/yo')).status, 200);
  // salir de verdad: el token deja de valer en el servidor
  assert.equal((await pc.post('/api/auth/salir')).status, 200);
  assert.equal((await pc.get('/api/auth/yo')).status, 401);
});

test('un administrador cierra a distancia las sesiones de su equipo, pero no las de un dueño', async () => {
  reiniciarLimites();
  const tg = await t.login('italo', 'gerente@italo.hn', 'OtraClave98765');
  const g = t.cli(tg, 'italo');
  const gid = (await t.db.query(`select id from core.usuarios where email = 'gerente@italo.hn'`)).rows[0].id;
  // el administrador de la prueba tiene 2FA activo, así que quien cierra las sesiones es el dueño del grupo
  const r = await dueno.post(`/api/admin/usuarios/${gid}/cerrar-sesiones`);
  assert.equal(r.status, 200);
  assert.ok(r.body.cerradas >= 1);
  assert.equal((await g.get('/api/auth/yo')).status, 401);
  const dId = (await t.db.query(`select id from core.usuarios where email = 'dueno@grupo.hn'`)).rows[0].id;
  assert.equal((await admin.post(`/api/admin/usuarios/${dId}/cerrar-sesiones`)).status, 404);   // el dueño no tiene acceso explícito a la empresa
});

test('2FA obligatoria: el dueño debe tenerla primero; luego la configuran en el login quienes dirigen', async () => {
  reiniciarLimites();
  // quien activa la política debe tener 2FA propio (no quedarse fuera)
  assert.equal((await dueno.put('/api/admin/seguridad', { mfa_obligatoria_direccion: true })).status, 409);
  const ini = (await dueno.post('/api/auth/2fa/iniciar')).body;
  const act = await dueno.post('/api/auth/2fa/activar', { codigo: unaVez(ini.secreto) });
  assert.equal(act.status, 200);
  const on = await dueno.put('/api/admin/seguridad', { mfa_obligatoria_direccion: true });
  assert.equal(on.status, 200, JSON.stringify(on.body));

  // Un administrador sin 2FA (creado ahora) entra y la política le exige configurarla
  await t.usuario({ nombre: 'Admin Origen', email: 'admin@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'admin' }] });
  const p = await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'admin@origen.hn', password: 'ClaveSegura123' });
  assert.equal(p.status, 200);
  assert.equal(p.body.requiere_configurar_2fa, true);
  assert.equal(p.body.token, undefined);
  assert.equal((await t.cli().post('/api/auth/login-2fa', { desafio: p.body.desafio, codigo: '123456' })).status, 400);   // fase equivocada
  const cfg = await t.cli().post('/api/auth/2fa/configurar', { desafio: p.body.desafio });
  assert.equal(cfg.status, 200);
  assert.equal((await t.cli().post('/api/auth/2fa/configurar-confirmar', { desafio: p.body.desafio, codigo: '000000' })).status, 400);
  const fin = await t.cli().post('/api/auth/2fa/configurar-confirmar', { desafio: p.body.desafio, codigo: unaVez(cfg.body.secreto) });
  assert.equal(fin.status, 200);
  assert.ok(fin.body.token);
  assert.equal(fin.body.codigos_recuperacion.length, 10);
  // y ya no puede quitársela
  const yo = t.cli(fin.body.token, 'origen');
  const quitar = await yo.post('/api/auth/2fa/desactivar', { password: 'ClaveSegura123', codigo: unaVez(cfg.body.secreto, 1) });
  assert.equal(quitar.status, 403);
  // un gerente (no es de dirección) no queda obligado
  reiniciarLimites();
  await t.usuario({ nombre: 'Gerente Origen', email: 'gerente@origen.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'origen', rol: 'gerente' }] });
  const g = await t.cli().post('/api/auth/login', { empresa: 'origen', email: 'gerente@origen.hn', password: 'ClaveSegura123' });
  assert.ok(g.body.token);
  // el cajero con PIN tampoco
  assert.ok(await t.loginPin('italo', '4821'));
  // el panel muestra quién la tiene
  const pan = (await dueno.get('/api/admin/seguridad')).body;
  assert.equal(pan.politica.mfa_obligatoria_direccion, true);
  assert.ok(pan.direccion.some((d) => d.email === 'dueno@grupo.hn' && d.mfa_activo));
});

test('reiniciar el 2FA de alguien que perdió su teléfono: lo hace quien lo administra y queda en la bitácora', async () => {
  reiniciarLimites();
  const aid = (await t.db.query(`select id from core.usuarios where email = 'admin@italo.hn'`)).rows[0].id;
  assert.equal((await admin.post(`/api/admin/usuarios/${aid}/reiniciar-2fa`)).status, 403);   // no se reinicia a sí mismo
  const r = await dueno.post(`/api/admin/usuarios/${aid}/reiniciar-2fa`);
  assert.equal(r.status, 200);
  assert.equal((await t.db.query('select 1 from core.usuarios_mfa where usuario_id = $1', [aid])).rowCount, 0);
  assert.equal((await dueno.get('/api/admin/auditoria?accion=mfa_reiniciado')).body.length, 1);
  // con la política activa, el administrador vuelve a tener que configurarla al entrar
  const p = await t.cli().post('/api/auth/login', { empresa: 'italo', email: 'admin@italo.hn', password: 'ClaveSegura123' });
  assert.equal(p.body.requiere_configurar_2fa, true);
});

test('el PIN de mostrador no lleva 2FA y no puede iniciarla', async () => {
  const caja = t.cli(await t.loginPin('italo', '4821'), 'italo');
  assert.equal((await caja.get('/api/auth/2fa/estado')).body.disponible, false);
  assert.equal((await caja.post('/api/auth/2fa/iniciar')).status, 403);
});

test('rotación de llaves sin cerrar sesiones: APP_JWT_SECRET_ANTERIOR, PIN_PEPPER_ANTERIOR y MFA_KEY', async () => {
  const { firmarSesion, verificarSesion } = await import('../src/auth/tokens.js');
  const vieja = { jwtSecret: 'v'.repeat(40), sesionHoras: 1 };
  const tok = await firmarSesion(vieja, { usuarioId: '00000000-0000-4000-8000-000000000001', tokenVersion: 1, via: 'password' });
  const nueva = { jwtSecret: 'n'.repeat(40), sesionHoras: 1 };
  await assert.rejects(() => verificarSesion(nueva, tok));
  assert.equal((await verificarSesion({ ...nueva, jwtSecretAnterior: vieja.jwtSecret }, tok)).via, 'password');
  // un secreto cualquiera no entra aunque exista el «anterior»
  await assert.rejects(() => verificarSesion({ jwtSecret: 'x'.repeat(40), jwtSecretAnterior: 'y'.repeat(40) }, tok));
  // el 2FA ya activado se sigue descifrando con la llave anterior
  const g = cifrarSecreto(vieja, 'JBSWY3DPEHPK3PXP');
  assert.equal(descifrarSecreto({ ...nueva, jwtSecretAnterior: vieja.jwtSecret }, g), 'JBSWY3DPEHPK3PXP');

  // PIN: al cambiar el pepper, el PIN de siempre entra y queda re-guardado con el nuevo
  const antes = t.config.pinPepper;
  const quien = await t.pinUsuario('italo', '4821');
  t.config.pinPepperAnterior = antes; t.config.pinPepper = 'pepper-nuevo-' + 'z'.repeat(20);
  try {
    assert.ok(await t.loginPin('italo', '4821', quien), 'el PIN sigue entrando durante la rotación');
    t.config.pinPepperAnterior = '';
    assert.ok(await t.loginPin('italo', '4821', quien), 'y ya quedó guardado con el pepper nuevo');
  } finally { t.config.pinPepper = antes; t.config.pinPepperAnterior = ''; }
});

test('al rotar la llave del 2FA, el secreto se re-cifra solo la primera vez que se usa', async () => {
  const { necesitaRecifrar } = await import('../src/auth/mfa.js');
  const vieja = t.config.jwtSecret;
  const uid = (await t.db.query(`select id from core.usuarios where email = 'dueno@grupo.hn'`)).rows[0].id;
  const antes = (await t.db.query('select secreto_cifrado from core.usuarios_mfa where usuario_id = $1', [uid])).rows[0].secreto_cifrado;
  assert.equal(necesitaRecifrar(t.config, antes), false);
  const original = { jwt: t.config.jwtSecret, ant: t.config.jwtSecretAnterior };
  t.config.jwtSecretAnterior = vieja; t.config.jwtSecret = 'rotado-' + 'q'.repeat(40);
  try {
    assert.equal(necesitaRecifrar(t.config, antes), true);
    const { comprobarSegundoPaso } = await import('../src/modulos/auth/mfa.js');
    const { descifrarSecreto } = await import('../src/auth/mfa.js');
    const secreto = descifrarSecreto(t.config, antes);
    assert.equal(await comprobarSegundoPaso(t.db, t.config, uid, unaVez(secreto, 1)), 'totp');
    const despues = (await t.db.query('select secreto_cifrado from core.usuarios_mfa where usuario_id = $1', [uid])).rows[0].secreto_cifrado;
    assert.equal(necesitaRecifrar(t.config, despues), false);
    t.config.jwtSecretAnterior = '';   // ya se puede quitar la llave anterior
    assert.equal(descifrarSecreto(t.config, despues), secreto);
  } finally { t.config.jwtSecret = original.jwt; t.config.jwtSecretAnterior = original.ant; }
});
