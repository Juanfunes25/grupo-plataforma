import crypto from 'node:crypto';
import { crearZip, leerZip } from '../lib/zip.js';

// Exportación completa de una empresa (ZIP con CSV y JSON por tabla) y restauración sobre una base vacía.
//
// Las tablas se DESCUBREN en la base (information_schema + llaves foráneas), no se listan a mano: una tabla nueva de
// cualquier módulo entra sola al respaldo. Una tabla pertenece a la empresa si tiene empresa_id o si cuelga, por
// llave foránea, de otra que sí (detalle_venta → ventas). Las tablas comunes del grupo (usuarios, terceros) van completas.

const ESQUEMAS_AJENOS = /^(pg_.*|information_schema|auth|storage|realtime|extensions|graphql.*|vault|pgsodium.*|supabase_.*|net|cron|pgbouncer|_realtime|_analytics|public)$/;

// Nunca se exportan (sesiones, 2FA, errores, estado interno) ni se restauran: se regeneran solos.
const EXCLUIDAS = new Set([
  'core.sesiones_activas', 'core.usuarios_mfa', 'core.mfa_recuperacion', 'core.errores_sistema', 'core.sistema_estado', 'core.seguridad_politica',
]);
// Columnas con credenciales: solo viajan si se pide expresamente («con_claves») para una restauración completa.
const CREDENCIALES = { 'core.usuarios': ['password_hash'], 'core.accesos': ['pin_hash'] };
// Columnas que no tienen sentido fuera de su proyecto de origen.
const SIEMPRE_OMITIDAS = { 'core.usuarios': ['auth_user_id'] };
// Tablas comunes a todo el grupo: se exportan completas.
const GLOBALES = new Set(['core.usuarios', 'core.terceros']);

const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const qn = (clave) => clave.split('.').map(q).join('.');

export async function descubrir(db) {
  const cols = (await db.query(
    `select c.table_schema as esq, c.table_name as tabla, c.column_name as col, c.data_type as tipo, c.udt_name as udt, c.column_default as def,
            c.is_generated = 'ALWAYS' as generada, c.is_identity = 'YES' as identidad, c.ordinal_position as pos
       from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where t.table_type = 'BASE TABLE' order by c.table_schema, c.table_name, c.ordinal_position`)).rows
    .filter((c) => !ESQUEMAS_AJENOS.test(c.esq));
  const tablas = new Map();
  for (const c of cols) {
    const k = `${c.esq}.${c.tabla}`;
    if (!tablas.has(k)) tablas.set(k, { clave: k, esq: c.esq, tabla: c.tabla, cols: [], fks: [], pk: [] });
    tablas.get(k).cols.push({ nombre: c.col, tipo: c.tipo, udt: c.udt, def: c.def, generada: c.generada, identidad: c.identidad });
  }
  const fks = (await db.query(
    `select nc.nspname as esq, c.relname as tabla, a.attname as col, nf.nspname as esq_ref, cf.relname as tabla_ref, af.attname as col_ref
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid join pg_namespace nc on nc.oid = c.relnamespace
       join pg_class cf on cf.oid = con.confrelid join pg_namespace nf on nf.oid = cf.relnamespace
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
       join pg_attribute af on af.attrelid = con.confrelid and af.attnum = con.confkey[1]
      where con.contype = 'f' and array_length(con.conkey, 1) = 1`)).rows;
  for (const f of fks) tablas.get(`${f.esq}.${f.tabla}`)?.fks.push({ col: f.col, ref: `${f.esq_ref}.${f.tabla_ref}`, colRef: f.col_ref });
  const pks = (await db.query(
    `select nc.nspname as esq, c.relname as tabla, a.attname as col, k.ord
       from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace nc on nc.oid = c.relnamespace
       cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
      where con.contype = 'p' order by k.ord`)).rows;
  for (const p of pks) tablas.get(`${p.esq}.${p.tabla}`)?.pk.push(p.col);
  for (const k of [...tablas.keys()]) if (EXCLUIDAS.has(k)) tablas.delete(k);
  return tablas;
}

/** Condición SQL (con $1 = id de la empresa) que deja solo las filas de la empresa; null si la tabla es común a todo el grupo. */
function donde(tablas, clave, alias, visitadas = new Set(), nivel = 0) {
  const t = tablas.get(clave);
  if (!t) return undefined;
  if (clave === 'core.empresas') return `${alias}.id = $1`;
  if (t.cols.some((c) => c.nombre === 'empresa_id')) return `${alias}.empresa_id = $1`;
  if (GLOBALES.has(clave)) return null;
  if (nivel >= 5 || visitadas.has(clave)) return undefined;
  const alternativas = [];
  for (const f of t.fks) {
    if (!tablas.has(f.ref) || GLOBALES.has(f.ref)) continue;
    const a2 = `p${nivel + 1}`;
    const sub = donde(tablas, f.ref, a2, new Set([...visitadas, clave]), nivel + 1);
    if (sub === undefined || sub === null) continue;
    alternativas.push(`${alias}.${q(f.col)} in (select ${a2}.${q(f.colRef)} from ${qn(f.ref)} ${a2} where ${sub})`);
  }
  return alternativas.length ? `(${alternativas.join(' or ')})` : undefined;   // undefined = sin ruta hasta una empresa
}

const hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

function celdaCsv(v, tipo) {
  if (v === null || v === undefined) return '';
  if (tipo === 'bytea') return `(binario de ${Math.max(0, String(v).length / 2 - 1)} bytes; ver el JSON)`;
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;   // evita que Excel lo ejecute como fórmula
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvDe(t, filas, columnas) {
  const tipos = Object.fromEntries(t.cols.map((c) => [c.nombre, c.udt]));
  const lineas = [columnas.map((c) => celdaCsv(c)).join(',')];
  for (const f of filas) lineas.push(columnas.map((c) => celdaCsv(f[c], tipos[c])).join(','));
  return `﻿${lineas.join('\r\n')}\r\n`;
}

const LEEME = (m) => `RESPALDO DE ${m.empresa.nombre.toUpperCase()}
Generado: ${m.generado_at} (versión de la plataforma: ${m.version_app || 'sin dato'})

Contenido
  manifiesto.json   resumen: tablas, cantidad de filas y suma de control (SHA-256) de cada archivo.
  datos/*.json      una tabla por archivo, con los tipos exactos. ESTE es el que usa el script de restauración.
  csv/*.csv         la misma información para abrir en Excel (UTF-8; las fórmulas quedan neutralizadas).

Cómo restaurar (base vacía con las migraciones aplicadas):
  node apps/api/src/db/restaurar.js ruta/al/respaldo.zip --limpiar
Las instrucciones completas están en docs/RESPALDOS.md.

Cuidado: este archivo contiene información del negocio y de su personal. Guárdalo cifrado y no lo envíes por chat ni correo sin protección.
${m.con_claves ? 'Incluye contraseñas y PIN cifrados (hash). Trátalo como un secreto.' : 'No incluye contraseñas ni PIN: al restaurar, cada persona necesitará una contraseña nueva (o vuelve a crear al dueño con npm run crear-dueno).'}
No incluye: sesiones abiertas, verificación en dos pasos, el registro de errores ni los secretos del servidor (DATABASE_URL, APP_JWT_SECRET, PIN_PEPPER).
`;

/**
 * Escribe el respaldo de la empresa en `escribir` (trozos de un ZIP). Devuelve el manifiesto.
 */
export async function exportarEmpresa(db, empresaId, escribir, { conClaves = false, version = '', paso = null } = {}) {
  const tablas = await descubrir(db);
  const emp = (await db.query('select id, codigo, nombre from core.empresas where id = $1', [empresaId])).rows[0];
  if (!emp) throw new Error('Empresa no encontrada');
  const migraciones = (await db.query('select nombre from public._migraciones order by nombre')).rows.map((r) => r.nombre);
  const zip = crearZip(escribir);
  const manifiesto = {
    formato: 1, generado_at: new Date().toISOString(), version_app: version, empresa: emp, con_claves: conClaves, migraciones, tablas: [], sin_ruta_a_empresa: [],
  };
  for (const clave of [...tablas.keys()].sort()) {
    const t = tablas.get(clave);
    const cond = donde(tablas, clave, 't');
    if (cond === undefined) { manifiesto.sin_ruta_a_empresa.push(clave); }
    const omitir = new Set([...(SIEMPRE_OMITIDAS[clave] ?? []), ...(conClaves ? [] : (CREDENCIALES[clave] ?? []))]);
    const columnas = t.cols.filter((c) => !c.generada && !omitir.has(c.nombre)).map((c) => c.nombre);
    const tieneBin = t.cols.some((c) => c.udt === 'bytea');
    const orden = t.pk.length ? t.pk.map((c) => `t.${q(c)}`).join(', ') : 't.ctid';
    const pagina = tieneBin ? 20 : 4000;
    const filas = [];
    for (let desde = 0; ; desde += pagina) {
      // Si no se sabe a qué empresa pertenece (sin ruta), se exporta completa: más vale de más que perder datos.
      const sql = `select to_jsonb(t) as j from ${qn(clave)} t ${cond ? `where ${cond}` : ''} order by ${orden} limit ${pagina} offset ${desde}`;
      const { rows } = await db.query(sql, cond && cond.includes('$1') ? [empresaId] : []);
      for (const r of rows) {
        const j = typeof r.j === 'string' ? JSON.parse(r.j) : r.j;
        const fila = {};
        for (const c of columnas) fila[c] = j[c] === undefined ? null : j[c];
        filas.push(fila);
      }
      if (rows.length < pagina) break;
    }
    const json = JSON.stringify(filas);
    const entrada = { tabla: clave, filas: filas.length, columnas, omitidas: [...omitir], global: cond === null || cond === undefined, sha256: hex(json) };
    manifiesto.tablas.push(entrada);
    if (filas.length) {
      zip.agregar(`datos/${clave}.json`, json);
      zip.agregar(`csv/${clave}.csv`, csvDe(t, filas, columnas));
    }
    paso?.(entrada);
  }
  zip.agregar('manifiesto.json', JSON.stringify(manifiesto, null, 2));
  zip.agregar('LEEME.txt', LEEME(manifiesto));
  zip.cerrar();
  return manifiesto;
}

/** Variante cómoda para pruebas y scripts: todo el ZIP en un Buffer. */
export async function exportarEmpresaBuffer(db, empresaId, opciones) {
  const trozos = [];
  const manifiesto = await exportarEmpresa(db, empresaId, (b) => trozos.push(b), opciones);
  return { zip: Buffer.concat(trozos), manifiesto };
}

// ─── Restauración ─────────────────────────────────────────────────────────────

/**
 * Restaura un respaldo en la base indicada. Pensado para una base NUEVA con las migraciones ya aplicadas.
 *  limpiar   : vacía antes las tablas de la plataforma (incluye los datos que las migraciones siembran, con otros ids).
 *              Úsalo con el PRIMER respaldo; los siguientes (otras empresas) se cargan sin limpiar.
 *  sinReplica: no intenta session_replication_role=replica (si el proveedor no lo permite se usa solo, ver docs/RESPALDOS.md).
 */
export async function restaurarZip(db, zipBuffer, { limpiar = false, sinReplica = false, log = () => {} } = {}) {
  const archivos = leerZip(zipBuffer);
  const mb = archivos.get('manifiesto.json');
  if (!mb) throw new Error('El ZIP no trae manifiesto.json: no es un respaldo de la plataforma');
  const manifiesto = JSON.parse(mb.toString('utf8'));
  if (manifiesto.formato !== 1) throw new Error(`Formato de respaldo desconocido (${manifiesto.formato})`);

  // Las migraciones del respaldo deben estar aplicadas en destino.
  const destino = new Set((await db.query('select nombre from public._migraciones')).rows.map((r) => r.nombre));
  const faltan = manifiesto.migraciones.filter((m) => !destino.has(m));
  if (faltan.length) throw new Error(`La base de destino no tiene estas migraciones: ${faltan.join(', ')}. Corre primero «npm run migrate».`);

  // Suma de control de cada tabla: detecta un archivo alterado o dañado antes de tocar la base.
  for (const t of manifiesto.tablas) {
    if (!t.filas) continue;
    const b = archivos.get(`datos/${t.tabla}.json`);
    if (!b) throw new Error(`Falta datos/${t.tabla}.json en el ZIP`);
    if (hex(b.toString('utf8')) !== t.sha256) throw new Error(`El archivo de ${t.tabla} no coincide con su suma de control: el respaldo está dañado o fue modificado`);
  }

  const reporte = { empresa: manifiesto.empresa, tablas: [], modo: '', limpiado: limpiar };
  await db.tx(async (tx) => {
    const tablas = await descubrir(tx);
    let replica = false;
    if (!sinReplica) {
      try { await tx.exec(`set local session_replication_role = replica`); replica = true; } catch { replica = false; }
    }
    reporte.modo = replica ? 'replica' : 'orden-por-dependencias';
    log(`Modo de carga: ${reporte.modo}`);

    // Sin permiso para "replica": se apagan los triggers de usuario (inventario, bitácora…) tabla por tabla y se carga por dependencias.
    const sinTriggers = [];
    if (!replica) {
      for (const k of tablas.keys()) { await tx.exec(`alter table ${qn(k)} disable trigger user`); sinTriggers.push(k); }
    }
    // La bitácora es inalterable (triggers que impiden TRUNCATE y recalculan el hash): se apaga solo aquí, para conservar los hashes originales.
    const audit = tablas.has('core.auditoria');
    if (audit && replica) await tx.exec('alter table core.auditoria disable trigger user');
    try {
      if (limpiar) {
        const todas = [...tablas.keys()].map(qn).join(', ');
        await tx.exec(`truncate ${todas} restart identity cascade`);
        log('Tablas vaciadas');
      }
      // Orden: padres antes que hijos (necesario sin "replica"; inofensivo con ella).
      const orden = ordenarPorDependencias(tablas);
      const pendientes = [...orden];
      let pasada = 0;
      while (pendientes.length && pasada < 6) {
        pasada++;
        for (const k of [...pendientes]) {
          const t = tablas.get(k);
          const b = archivos.get(`datos/${k}.json`);
          const esperado = manifiesto.tablas.find((x) => x.tabla === k);
          if (!b) { pendientes.splice(pendientes.indexOf(k), 1); continue; }
          try {
            await tx.exec('savepoint carga');
            const filas = JSON.parse(b.toString('utf8'));
            const n = await cargarTabla(tx, t, filas);
            await tx.exec('release savepoint carga');
            reporte.tablas.push({ tabla: k, esperado: esperado?.filas ?? filas.length, cargadas: n });
            log(`  ${k}: ${n}/${filas.length}`);
            pendientes.splice(pendientes.indexOf(k), 1);
          } catch (e) {
            await tx.exec('rollback to savepoint carga');
            if (replica || pasada >= 6) throw new Error(`${k}: ${e.message}`);
            // sin replica puede fallar por una llave foránea cuyo padre aún no se carga: se reintenta en la siguiente pasada
          }
        }
      }
      if (pendientes.length) throw new Error(`No se pudieron cargar: ${pendientes.join(', ')}`);
      await ajustarSecuencias(tx, tablas);
    } finally {
      if (!replica) for (const k of sinTriggers) await tx.exec(`alter table ${qn(k)} enable trigger user`);
      else if (audit) await tx.exec('alter table core.auditoria enable trigger user');
    }
  });
  reporte.tablas.sort((a, b) => a.tabla.localeCompare(b.tabla));
  return reporte;
}

function ordenarPorDependencias(tablas) {
  const salida = [], estado = new Map();
  const visitar = (k) => {
    if (estado.get(k)) return;
    estado.set(k, 1);
    for (const f of tablas.get(k).fks) if (f.ref !== k && tablas.has(f.ref)) visitar(f.ref);
    salida.push(k);
  };
  for (const k of [...tablas.keys()].sort()) visitar(k);
  return salida;
}

async function cargarTabla(tx, t, filas) {
  if (!filas.length) return 0;
  const destino = new Set(t.cols.filter((c) => !c.generada).map((c) => c.nombre));
  const presentes = Object.keys(filas[0]).filter((c) => destino.has(c));
  if (!presentes.length) return 0;
  const lista = presentes.map(q).join(', ');
  const identidad = t.cols.some((c) => c.identidad) ? 'overriding system value' : '';
  let total = 0;
  for (let i = 0; i < filas.length; i += 1000) {
    const trozo = filas.slice(i, i + 1000);
    const r = await tx.query(
      `insert into ${qn(t.clave)} (${lista}) ${identidad} select ${lista} from jsonb_populate_recordset(null::${qn(t.clave)}, $1::jsonb) on conflict do nothing`,
      [JSON.stringify(trozo)]);
    total += r.rowCount;
  }
  return total;
}

/** Deja cada secuencia en el máximo cargado, para que los próximos registros no choquen con los restaurados. */
async function ajustarSecuencias(tx, tablas) {
  for (const t of tablas.values()) {
    for (const c of t.cols) {
      let seq = null;
      const m = /nextval\('([^']+)'/.exec(c.def ?? '');
      if (m) seq = m[1].replace(/::regclass$/, '');
      else if (c.identidad) seq = (await tx.query(`select pg_get_serial_sequence($1, $2) as s`, [qn(t.clave), c.nombre])).rows[0]?.s;
      if (!seq) continue;
      const max = (await tx.query(`select max(${q(c.nombre)}) as m from ${qn(t.clave)}`)).rows[0].m;
      if (max !== null && max !== undefined) await tx.query(`select setval($1::regclass, $2::bigint, true)`, [seq, Number(max)]);
    }
  }
}
