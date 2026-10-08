import { fileURLToPath } from 'node:url';
import { leerConfig } from '../config.js';
import { abrirDb } from './index.js';
import { sembrarRinv } from '../modulos/rinv/siembra.js';

/** Carga (o completa) los datos reales de Italo del inventario de reposición. Idempotente. Uso: npm run seed:rinv */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = await abrirDb(leerConfig());
  const e = (await db.query("select id from core.empresas where codigo = 'italo'")).rows[0];
  if (!e) { console.error('No existe la empresa italo'); process.exit(1); }
  const r = await sembrarRinv(db, e.id);
  console.log(JSON.stringify({ ...r, ventasRistoris: { ...r.ventasRistoris, descontados: r.ventasRistoris.descontados.length } }, null, 2));
  await db.close();
}
