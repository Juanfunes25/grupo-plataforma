import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fechaHN, sumarDias } from '@grupo/shared';
import { iniciar } from './helpers.js';
import { detectarTipo } from '../src/modulos/documentos/archivos.js';
import { analizar, analizarGrupo } from '../src/modulos/gerente/analisis.js';

let t, dueno, admin, ger, cajero, otraEmp, tokens = {}, eid, iid, empleadoEco, empleadoItalo, sucItalo;

const PDF = (extra = 'a') => Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n% ${extra}\ntrailer<<>>\n%%EOF\n`);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('relleno-de-imagen-1234567890')]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml relleno')]);
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
const hoy = fechaHN();

const qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null) p.set(k, v); return p.toString(); };
/** Sube un archivo crudo (el cuerpo ES el archivo). */
async function subir(token, empresa, ruta, buf, params = {}) {
  const r = await fetch(`${t.base}/api/documentos${ruta}?${qs(params)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-empresa': empresa, 'content-type': 'application/octet-stream' }, body: buf });
  const txt = await r.text();
  return { status: r.status, body: txt ? JSON.parse(txt) : null };
}
async function bajar(token, empresa, ruta) {
  const r = await fetch(`${t.base}/api/documentos${ruta}`, { headers: { authorization: `Bearer ${token}`, 'x-empresa': empresa } });
  return { status: r.status, tipo: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
}
const A = (c) => c.token;

before(async () => {
  t = await iniciar();
  eid = await t.empresaId('ecostone'); iid = await t.empresaId('italo');
  await t.usuario({ nombre: 'Dueño', email: 'dueno@grupo.hn', password: 'ClaveSegura123', dueno: true });
  await t.usuario({ nombre: 'Admin Eco', email: 'admin@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'admin' }] });
  await t.usuario({ nombre: 'Manager Eco', email: 'ger@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'gerente' }] });
  await t.usuario({ nombre: 'Cajero Eco', accesos: [{ empresa: 'ecostone', rol: 'cajero', pin: '4242' }] });
  await t.usuario({ nombre: 'Admin Italo', email: 'admin@italo.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'italo', rol: 'admin' }] });
  tokens = {
    dueno: await t.login('ecostone', 'dueno@grupo.hn', 'ClaveSegura123'), admin: await t.login('ecostone', 'admin@eco.hn', 'ClaveSegura123'),
    ger: await t.login('ecostone', 'ger@eco.hn', 'ClaveSegura123'), cajero: await t.loginPin('ecostone', '4242'), italo: await t.login('italo', 'admin@italo.hn', 'ClaveSegura123'),
  };
  dueno = t.cli(tokens.dueno, 'ecostone'); admin = t.cli(tokens.admin, 'ecostone'); ger = t.cli(tokens.ger, 'ecostone'); cajero = t.cli(tokens.cajero, 'ecostone'); otraEmp = t.cli(tokens.italo, 'italo');
  const mkEmp = async (empresaId, ident) => {
    const p = (await t.db.query(`insert into rrhh.personas (nombres, apellidos, identidad) values ('Ana','Pérez',$1) returning id`, [ident])).rows[0].id;
    return (await t.db.query(`insert into rrhh.empleados (persona_id, empresa_id, puesto) values ($1,$2,'Vendedora') returning id`, [p, empresaId])).rows[0].id;
  };
  empleadoEco = await mkEmp(eid, '0501199000001'); empleadoItalo = await mkEmp(iid, '0501199000002');
  sucItalo = await t.sucursalId('italo', 'los_andes');
});
after(() => t.cerrar());

test('detección de tipo por contenido (magic bytes)', () => {
  assert.equal(detectarTipo(PDF()), 'pdf'); assert.equal(detectarTipo(PNG), 'png'); assert.equal(detectarTipo(DOCX), 'docx');
  assert.equal(detectarTipo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])), 'jpeg');
  assert.equal(detectarTipo(EXE), null);
  assert.equal(detectarTipo(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('algo.txt')])), null);   // zip cualquiera no es docx/xlsx
});

test('subida y descarga: el archivo vuelve idéntico con su tipo de contenido', async () => {
  const pdf = PDF('contrato');
  const r = await subir(tokens.admin, 'ecostone', '/subir', pdf, { tipo: 'contrato_arrendamiento', titulo: 'Arrendamiento bodega', nombre: 'contrato bodega.pdf', fecha_vencimiento: sumarDias(hoy, 200), numero: 'CA-1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.version_actual, 1); assert.equal(r.body.estado, 'vigente'); assert.equal(r.body.mime, 'application/pdf'); assert.equal(r.body.nombre_archivo, 'contrato bodega.pdf');
  const d = await bajar(tokens.admin, 'ecostone', `/${r.body.id}/archivo`);
  assert.equal(d.status, 200); assert.equal(d.tipo, 'application/pdf'); assert.ok(d.buf.equals(pdf)); assert.match(d.disp, /^attachment/);
  const v = await bajar(tokens.admin, 'ecostone', `/${r.body.id}/archivo?inline=1`);
  assert.match(v.disp, /^inline/);
  // La ficha trae la lista de versiones, sin los bytes
  const f = await admin.get(`/api/documentos/${r.body.id}`);
  assert.equal(f.body.versiones.length, 1); assert.equal(f.body.versiones[0].tamano, pdf.length); assert.equal(f.body.contenido, undefined);
  // Bitácora
  const aud = await t.db.query(`select accion from core.auditoria where empresa_id = $1 and entidad_id = $2 order by id`, [eid, r.body.id]);
  assert.deepEqual(aud.rows.map((x) => x.accion), ['documento.crear', 'documento.subir']);
});

test('valida el contenido real, el tamaño y el permiso para subir', async () => {
  const p = { tipo: 'certificado_otro', titulo: 'Prueba' };
  assert.equal((await subir(tokens.admin, 'ecostone', '/subir', EXE, { ...p, nombre: 'virus.exe' })).status, 400);                    // tipo no permitido
  assert.equal((await subir(tokens.admin, 'ecostone', '/subir', EXE, { ...p, nombre: 'falso.pdf' })).status, 400);                    // exe renombrado a pdf
  const m = await subir(tokens.admin, 'ecostone', '/subir', PNG, { ...p, nombre: 'foto.pdf' });                                      // png con extensión pdf
  assert.equal(m.status, 400); assert.match(m.body.error, /no corresponde a su extensión/);
  assert.equal((await subir(tokens.admin, 'ecostone', '/subir', Buffer.alloc(0), { ...p, nombre: 'a.pdf' })).status, 400);              // vacío
  const grande = Buffer.concat([PDF(), Buffer.alloc(15 * 1024 * 1024 + 10, 0x20)]);
  const g = await subir(tokens.admin, 'ecostone', '/subir', grande, { ...p, nombre: 'grande.pdf' });
  assert.equal(g.status, 413); assert.match(g.body.error, /15 MB/);
  assert.equal((await subir(tokens.admin, 'ecostone', '/subir', PDF('x'), { tipo: 'no_existe', titulo: 'x', nombre: 'a.pdf' })).status, 400);
  assert.equal((await subir(tokens.ger, 'ecostone', '/subir', PDF('y'), { ...p, nombre: 'a.pdf' })).status, 403);                     // Manager solo ve (doc:ver)
  assert.equal((await subir(tokens.cajero, 'ecostone', '/subir', PDF('z'), { ...p, nombre: 'a.pdf' })).status, 403);
  assert.equal((await cajero.get('/api/documentos')).status, 403);                                                                    // cajero ni lista
  const sinExt = await subir(tokens.admin, 'ecostone', '/subir', PNG, { ...p, titulo: 'Foto cámara', nombre: 'IMG_0001' });          // foto sin extensión: se deduce
  assert.equal(sinExt.status, 201); assert.equal(sinExt.body.nombre_archivo, 'IMG_0001.png'); assert.equal(sinExt.body.mime, 'image/png');
});

test('versiones: la nueva reemplaza a la actual y la anterior queda en el historial', async () => {
  const c = await admin.post('/api/documentos', { tipo: 'poliza_seguro', titulo: 'Póliza flotilla', fecha_vencimiento: sumarDias(hoy, 10) });
  assert.equal(c.status, 201); assert.equal(c.body.version_actual, 0);
  assert.equal(c.body.estado, 'por_vencer');
  assert.equal((await bajar(tokens.admin, 'ecostone', `/${c.body.id}/archivo`)).status, 404);                       // aún sin archivo
  const v1 = PDF('v1'), v2 = PDF('v2 renovada');
  assert.equal((await subir(tokens.admin, 'ecostone', `/${c.body.id}/archivo`, v1, { nombre: 'poliza-2025.pdf' })).status, 201);
  const dup = await subir(tokens.admin, 'ecostone', `/${c.body.id}/archivo`, v1, { nombre: 'poliza-2025.pdf' });
  assert.equal(dup.status, 409);                                                                                    // mismo archivo = no es versión nueva
  const nueva = sumarDias(hoy, 365);
  const r2 = await subir(tokens.admin, 'ecostone', `/${c.body.id}/archivo`, v2, { nombre: 'poliza-2026.pdf', nota: 'Renovación anual', fecha_vencimiento: nueva });
  assert.equal(r2.status, 201, JSON.stringify(r2.body));
  assert.equal(r2.body.version_actual, 2); assert.equal(r2.body.fecha_vencimiento, nueva); assert.equal(r2.body.estado, 'vigente');
  const f = await admin.get(`/api/documentos/${c.body.id}`);
  assert.deepEqual(f.body.versiones.map((v) => v.numero), [2, 1]); assert.equal(f.body.versiones[0].nota, 'Renovación anual');
  assert.ok((await bajar(tokens.admin, 'ecostone', `/${c.body.id}/archivo`)).buf.equals(v2));                         // por defecto, la actual
  assert.ok((await bajar(tokens.admin, 'ecostone', `/${c.body.id}/archivo?version=1`)).buf.equals(v1));              // la anterior sigue disponible
  assert.equal((await bajar(tokens.admin, 'ecostone', `/${c.body.id}/archivo?version=9`)).status, 404);
});

test('confidencialidad: los contratos de empleados solo los ven dueño y administrador, y su descarga queda en bitácora', async () => {
  const pdf = PDF('contrato-empleado');
  const r = await subir(tokens.admin, 'ecostone', '/subir', pdf, { tipo: 'contrato_empleado', titulo: 'Contrato Ana Pérez', empleado_id: empleadoEco, nombre: 'contrato-ana.pdf' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.confidencialidad, 'restringido'); assert.equal(r.body.empleado, 'Ana Pérez');
  const id = r.body.id;
  // El Manager (doc:ver) ni lo lista, ni lo abre, ni lo descarga
  assert.equal((await ger.get(`/api/documentos/${id}`)).status, 404);
  assert.equal((await bajar(tokens.ger, 'ecostone', `/${id}/archivo`)).status, 404);
  assert.ok(!(await ger.get('/api/documentos?limite=300')).body.filas.some((d) => d.id === id));
  assert.ok(!(await ger.get(`/api/documentos?empleado_id=${empleadoEco}`)).body.filas.length);
  assert.equal((await ger.get('/api/documentos/resumen')).body.kpis.activos < (await admin.get('/api/documentos/resumen')).body.kpis.activos, true);
  // Admin y dueño sí; el listado por empleado es lo que usa la pestaña de RRHH
  const l = await admin.get(`/api/documentos?empleado_id=${empleadoEco}`);
  assert.equal(l.body.filas.length, 1); assert.equal(l.body.filas[0].id, id);
  assert.ok((await bajar(tokens.dueno, 'ecostone', `/${id}/archivo`)).buf.equals(pdf));
  const aud = await t.db.query(`select usuario_nombre, accion from core.auditoria where entidad_id = $1 and accion = 'documento.descargar'`, [id]);
  assert.equal(aud.rows.length, 1); assert.equal(aud.rows[0].usuario_nombre, 'Dueño');
  // Un documento NORMAL no deja rastro de descarga (solo los confidenciales)
  const n = await subir(tokens.admin, 'ecostone', '/subir', PDF('normal-x'), { tipo: 'certificado_otro', titulo: 'Certificado normal', nombre: 'c.pdf' });
  await bajar(tokens.admin, 'ecostone', `/${n.body.id}/archivo`);
  assert.equal((await t.db.query(`select 1 from core.auditoria where entidad_id = $1 and accion = 'documento.descargar'`, [n.body.id])).rowCount, 0);
  // El empleado debe ser de la empresa
  const mal = await admin.post('/api/documentos', { tipo: 'contrato_empleado', titulo: 'x', empleado_id: empleadoItalo });
  assert.equal(mal.status, 400);
  // El Manager no puede cambiar la restricción aunque tuviera acceso: ni siquiera lo encuentra
  assert.equal((await ger.put(`/api/documentos/${id}`, { confidencialidad: 'normal' })).status, 403);
});

test('vencimientos: KPIs, estados y alertas a 30/60/90 días y vencidos', async () => {
  const mk = (titulo, dias) => admin.post('/api/documentos', { tipo: 'licencia_municipal', titulo, fecha_vencimiento: sumarDias(hoy, dias), dias_aviso: 15 });
  const [venc, d12, d45, d80, lejos] = [await mk('V-vencida', -5), await mk('V-12', 12), await mk('V-45', 45), await mk('V-80', 80), await mk('V-400', 400)];
  assert.equal(venc.body.estado, 'vencido'); assert.equal(venc.body.dias_restantes, -5);
  assert.equal(d12.body.estado, 'por_vencer'); assert.equal(d45.body.estado, 'vigente');           // el aviso es de 15 días
  assert.equal(lejos.body.estado, 'vigente');
  const a = (await admin.get('/api/documentos/alertas')).body;
  const tit = (l) => l.map((x) => x.titulo);
  assert.ok(tit(a.vencidos).includes('V-vencida')); assert.ok(tit(a.d30).includes('V-12')); assert.ok(tit(a.d60).includes('V-45')); assert.ok(tit(a.d90).includes('V-80'));
  assert.ok(![...tit(a.d30), ...tit(a.d60), ...tit(a.d90), ...tit(a.vencidos)].includes('V-400'));
  const k = (await admin.get('/api/documentos/resumen')).body.kpis;
  assert.ok(k.vencidos >= 1 && k.d30 >= 1 && k.d60 >= 1 && k.d90 >= 1);
  // Filtros
  assert.equal((await admin.get('/api/documentos?estado=vencido')).body.filas.every((d) => d.estado === 'vencido'), true);
  assert.ok((await admin.get('/api/documentos?q=V-45')).body.filas.some((d) => d.titulo === 'V-45'));
  assert.equal((await admin.get('/api/documentos?q=V-400&vence_en=90')).body.filas.length, 0);
  assert.equal((await admin.get('/api/documentos?q=V-80&vence_en=90')).body.filas.length, 1);
  assert.equal((await admin.get('/api/documentos?tipo=licencia_municipal')).body.filas.every((d) => d.tipo === 'licencia_municipal'), true);
  assert.equal((await admin.put(`/api/documentos/${d12.body.id}`, { fecha_vencimiento: '2020-01-01', fecha_emision: '2021-01-01' })).status, 400);   // vence antes de emitirse
  assert.equal((await admin.put(`/api/documentos/${d12.body.id}`, { fecha_vencimiento: '2026-13-45' })).status, 400);
});

test('editar, archivar y borrar piden permiso y motivo, y quedan en la bitácora', async () => {
  const c = (await admin.post('/api/documentos', { tipo: 'contrato_proveedor', titulo: 'Contrato cemento', contraparte: 'Cementos SA', monto: 12500.5, etiquetas: ['proveedor', 'cemento'] })).body;
  assert.equal(c.contraparte, 'Cementos SA'); assert.deepEqual(c.etiquetas, ['proveedor', 'cemento']);
  const e = await admin.put(`/api/documentos/${c.id}`, { titulo: 'Contrato de cemento 2026', monto: 15000, contraparte: '' });
  assert.equal(e.body.titulo, 'Contrato de cemento 2026'); assert.equal(e.body.contraparte, null); assert.equal(e.body.monto, 15000);
  assert.equal((await ger.put(`/api/documentos/${c.id}`, { titulo: 'x' })).status, 403);
  const ed = await t.db.query(`select detalle from core.auditoria where entidad_id = $1 and accion = 'documento.editar'`, [c.id]);
  assert.equal(ed.rows[0].detalle.antes.titulo, 'Contrato cemento');
  // Archivar
  assert.equal((await admin.post(`/api/documentos/${c.id}/archivar`, {})).status, 400);                              // sin motivo
  const ar = await admin.post(`/api/documentos/${c.id}/archivar`, { motivo: 'Contrato terminado' });
  assert.equal(ar.body.estado, 'archivado');
  assert.ok(!(await admin.get('/api/documentos?q=cemento')).body.filas.some((d) => d.id === c.id));                  // no sale en la lista normal…
  assert.ok((await admin.get('/api/documentos?estado=archivado')).body.filas.some((d) => d.id === c.id));            // …pero sí archivado
  assert.equal((await subir(tokens.admin, 'ecostone', `/${c.id}/archivo`, PDF('q'), { nombre: 'a.pdf' })).status, 409);   // archivado no recibe versiones
  assert.equal((await admin.post(`/api/documentos/${c.id}/restaurar`, {})).body.estado, 'vigente');
  // Borrar
  const f = await subir(tokens.admin, 'ecostone', `/${c.id}/archivo`, PDF('para-borrar'), { nombre: 'a.pdf' });
  assert.equal(f.status, 201);
  assert.equal((await admin.del(`/api/documentos/${c.id}`)).status, 400);                                            // sin motivo
  assert.equal((await ger.del(`/api/documentos/${c.id}?motivo=prueba`)).status, 403);
  assert.equal((await admin.del(`/api/documentos/${c.id}?motivo=Cargado por error`)).status, 200);
  assert.equal((await admin.get(`/api/documentos/${c.id}`)).status, 404);
  assert.equal((await bajar(tokens.admin, 'ecostone', `/${c.id}/archivo`)).status, 404);
  assert.equal((await t.db.query('select 1 from doc.archivos a join doc.versiones v on v.id = a.version_id where v.documento_id = $1', [c.id])).rowCount, 0);   // los bytes se eliminaron
  const acc = (await t.db.query(`select accion, detalle from core.auditoria where entidad_id = $1 order by id`, [c.id])).rows;
  assert.deepEqual(acc.map((x) => x.accion), ['documento.crear', 'documento.editar', 'documento.archivar', 'documento.restaurar', 'documento.subir', 'documento.eliminar']);
  assert.equal(acc.at(-1).detalle.motivo, 'Cargado por error');
});

test('aislamiento entre empresas', async () => {
  const eco = (await admin.get('/api/documentos?limite=300')).body.filas;
  assert.ok(eco.length > 0);
  const it = await subir(tokens.italo, 'italo', '/subir', PDF('italo-doc'), { tipo: 'arsa_permiso', titulo: 'ARSA Los Andes', sucursal_id: sucItalo, nombre: 'arsa.pdf', fecha_vencimiento: sumarDias(hoy, 100) });
  assert.equal(it.status, 201, JSON.stringify(it.body));
  const idIt = it.body.id;
  // Italo no ve nada de EcoStone y viceversa, ni por id ni por descarga
  const ita = (await otraEmp.get('/api/documentos?limite=300')).body.filas;
  assert.ok(ita.every((d) => d.empresa_id === iid)); assert.ok(ita.some((d) => d.id === idIt));
  assert.equal((await otraEmp.get(`/api/documentos/${eco[0].id}`)).status, 404);
  assert.equal((await bajar(tokens.italo, 'italo', `/${eco[0].id}/archivo`)).status, 404);
  assert.equal((await admin.get(`/api/documentos/${idIt}`)).status, 404);
  assert.equal((await dueno.get(`/api/documentos/${idIt}`)).status, 404);                          // el dueño, con la empresa equivocada, tampoco
  assert.equal((await t.cli(tokens.dueno, 'italo').get(`/api/documentos/${idIt}`)).status, 200);  // con la correcta, sí
  assert.equal((await otraEmp.put(`/api/documentos/${eco[0].id}`, { titulo: 'hackeado' })).status, 404);
  assert.equal((await otraEmp.del(`/api/documentos/${eco[0].id}?motivo=hackeo`)).status, 404);
  // Una sucursal o empleado de otra empresa no se puede enlazar
  assert.equal((await admin.post('/api/documentos', { tipo: 'certificado_otro', titulo: 'x', sucursal_id: sucItalo })).status, 400);
  // Un acceso por PIN de EcoStone no entra a Italo
  assert.equal((await t.cli(tokens.cajero, 'italo').get('/api/documentos')).status, 403);
});

test('tipos configurables por empresa y checklist por tipo de negocio', async () => {
  const tp = (await otraEmp.get('/api/documentos/tipos')).body;
  assert.ok(tp.tipos.find((x) => x.codigo === 'arsa_permiso' && x.esperado && x.por_sucursal));          // gelatería: ARSA por sucursal
  assert.ok(!(await admin.get('/api/documentos/tipos')).body.tipos.find((x) => x.codigo === 'arsa_permiso' && x.esperado));   // fábrica: no se espera
  assert.ok((await admin.get('/api/documentos/tipos')).body.tipos.find((x) => x.codigo === 'licencia_ambiental' && x.esperado));
  const nuevo = await otraEmp.post('/api/documentos/tipos', { nombre: 'Licencia de rótulos', grupo: 'legal', esperado: true });
  assert.equal(nuevo.status, 201); assert.equal(nuevo.body.codigo, 'licencia_de_rotulos');
  assert.equal((await otraEmp.post('/api/documentos/tipos', { nombre: 'Licencia de rótulos' })).status, 409);
  assert.equal((await ger.post('/api/documentos/tipos', { nombre: 'Otro tipo' })).status, 403);
  assert.ok(!(await admin.get('/api/documentos/tipos')).body.tipos.find((x) => x.codigo === 'licencia_de_rotulos'));   // es de Italo
  // Checklist de Italo: ARSA por sucursal, hay un ARSA en Los Andes → ok; el resto faltan
  const cl = (await otraEmp.get('/api/documentos/checklist')).body;
  const arsa = cl.items.filter((i) => i.tipo === 'arsa_permiso');
  assert.ok(arsa.length >= 4);                                                                               // una por sucursal activa
  assert.equal(arsa.find((i) => i.sucursal_id === sucItalo).estado, 'ok');
  assert.ok(arsa.filter((i) => i.sucursal_id !== sucItalo).every((i) => i.estado === 'falta'));
  assert.ok(cl.resumen.falta > 0 && cl.items.find((i) => i.tipo === 'poliza_seguro').estado === 'falta');
  // Si el permiso vence, ya no hay uno vigente
  await t.db.query(`update doc.documentos set fecha_vencimiento = $2 where id = $1`, [(await otraEmp.get(`/api/documentos?tipo=arsa_permiso`)).body.filas[0].id, sumarDias(hoy, -1)]);
  assert.equal((await otraEmp.get('/api/documentos/checklist')).body.items.find((i) => i.tipo === 'arsa_permiso' && i.sucursal_id === sucItalo).estado, 'vencido');
  // y renovarlo (versión con nueva fecha) lo deja ok otra vez
  const id = (await otraEmp.get(`/api/documentos?tipo=arsa_permiso&estado=vencido`)).body.filas[0].id;
  await subir(tokens.italo, 'italo', `/${id}/archivo`, PDF('arsa-renovada'), { nombre: 'arsa-2.pdf', fecha_vencimiento: sumarDias(hoy, 300) });
  assert.equal((await otraEmp.get('/api/documentos/checklist')).body.items.find((i) => i.tipo === 'arsa_permiso' && i.sucursal_id === sucItalo).estado, 'ok');
});

test('Dirección: consolidado de documentos del grupo (solo con grupo:ver)', async () => {
  const gd = await dueno.get('/api/grupo/documentos');
  assert.equal(gd.status, 200);
  assert.equal(gd.body.empresas.length, 4);
  const eco = gd.body.empresas.find((e) => e.codigo === 'ecostone');
  assert.ok(eco.kpis.vencidos >= 1); assert.ok(gd.body.total.vencidos >= 1);
  assert.ok(gd.body.proximos.every((d) => d.empresa && d.empresa_nombre)); assert.ok(gd.body.proximos.some((d) => d.empresa === 'ecostone' && d.titulo === 'V-vencida'));
  const fechas = gd.body.proximos.map((d) => d.fecha_vencimiento); assert.deepEqual(fechas, [...fechas].sort());
  assert.ok(gd.body.empresas.find((e) => e.codigo === 'italo').checklist.faltantes.length > 0);
  assert.equal((await admin.get('/api/grupo/documentos')).status, 403);                                // administrador de empresa: no es Dirección
  assert.equal((await ger.get('/api/grupo/documentos')).status, 403);
  // Un contador (grupo:ver + doc:ver) ve el consolidado pero NO los contratos de empleados
  await t.usuario({ nombre: 'Contadora', email: 'cont@eco.hn', password: 'ClaveSegura123', accesos: [{ empresa: 'ecostone', rol: 'contador' }] });
  const cont = t.cli(await t.login('ecostone', 'cont@eco.hn', 'ClaveSegura123'), 'ecostone');
  const gc = await cont.get('/api/grupo/documentos');
  assert.equal(gc.status, 200); assert.deepEqual(gc.body.empresas.map((e) => e.codigo), ['ecostone']);
  await t.db.query(`update doc.documentos set fecha_vencimiento = $2 where empresa_id = $1 and tipo = 'contrato_empleado'`, [eid, sumarDias(hoy, 5)]);
  assert.ok(!(await cont.get('/api/grupo/documentos')).body.proximos.some((d) => d.tipo === 'contrato_empleado'));
  assert.ok((await dueno.get('/api/grupo/documentos')).body.proximos.some((d) => d.tipo === 'contrato_empleado'));
});

test('gerente digital: hallazgos de documentos vencidos, por vencer y faltantes (empresa y Dirección)', async () => {
  const g = (await admin.get('/api/gerente')).body;                                                    // EcoStone, sin ventas
  const h = g.hallazgos.filter((x) => x.area === 'documentos');
  assert.ok(h.some((x) => x.severidad === 'alta' && /vencido/.test(x.titulo)), JSON.stringify(h));
  assert.ok(h.some((x) => /por vencer/.test(x.titulo)));
  assert.ok(g.documentos.vencidos >= 1);
  // los confidenciales aparecen sin nombre del empleado
  assert.ok(!JSON.stringify(h).includes('Ana Pérez'));
  assert.ok(h.some((x) => /Documento confidencial/.test(x.detalle)));
  const gg = (await dueno.get('/api/grupo/gerente')).body;
  assert.ok(gg.grupo.hallazgos.some((x) => x.area === 'documentos' && /EcoStone/.test(x.titulo)));
  assert.equal(gg.empresas.length, 4);
});

test('motor del gerente (puro): documentos sin datos no cambian nada y con datos suman hallazgos', () => {
  const base = {
    empresa: { codigo: 'x', nombre: 'X' }, periodo: { desde: '2026-01-01', hasta: '2026-01-28', dias: 28, previo_desde: '2025-12-04' }, ventasDia: [],
    productosActual: [], productosPrevio: [], horas: [], gastosActual: [], gastosPrevio: [], mermas: { costo: 0, top: [] }, compras: 0, stock: [], vencen: { valor: 0, lotes: 0 },
    turnos: [], fiscal: [], descuento: { descuento: 0, bruto: 0 }, catalogo: [], antifraude: [],
  };
  const docs = { vencidos: [{ titulo: 'Permiso ARSA', sucursal: '10 Calle', dias: -3 }], por_vencer: [{ titulo: 'Póliza', dias: 9 }], faltantes: [{ tipo: 'Registro sanitario', sucursal: null }] };
  assert.equal(analizar(base).hallazgos.filter((x) => x.area === 'documentos').length, 0);
  assert.equal(analizar(base).documentos, null);
  // Sin ventas el aviso de documentos igual sale; con ventas también
  for (const ventasDia of [[], Array.from({ length: 28 }, (_, i) => ({ fecha: sumarDias('2026-01-01', i), neto: 500, facturas: 10 }))]) {
    const con = analizar({ ...base, ventasDia, documentos: docs });
    const h = con.hallazgos.filter((x) => x.area === 'documentos');
    assert.equal(h.length, 3);
    assert.equal(h[0].severidad, 'alta'); assert.match(h[0].detalle, /Permiso ARSA \(10 Calle\): venció hace 3 día/);
    assert.equal(h.find((x) => /por vencer/.test(x.titulo)).severidad, 'alta');                       // vence en 9 días: urgente
    assert.equal(h.find((x) => /Faltan/.test(x.titulo)).severidad, 'info');
    assert.deepEqual(con.documentos, { vencidos: 1, por_vencer: 1, faltantes: 1 });
  }
  const e = analizar({ ...base, documentos: docs });
  const g = analizarGrupo([{ ...e, salud: { puntaje: 80, nivel: 'x' }, metricas: { ventas_netas: 1, utilidad_operativa: 1, margen_bruto_pct: null }, hallazgos: e.hallazgos }]);
  assert.ok(g.hallazgos.some((x) => x.area === 'documentos' && /1 documento\(s\) vencido\(s\) y 1 por vencer/.test(x.titulo)));
  assert.equal(g.hallazgos.filter((x) => x.area === 'documentos').length, 1);                          // sin duplicar la copia por empresa
});
