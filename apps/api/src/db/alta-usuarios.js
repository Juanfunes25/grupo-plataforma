// Alta de usuarios iniciales desde la variable de entorno ALTA_USUARIOS (JSON). Idempotente: si la persona ya tiene acceso a la empresa, no se toca.
// Sirve para crear gente con su PIN sin dejar PIN ni nombres en el repositorio; terminada la carga se quita la variable.
//   [{ "nombre": "Ana", "accesos": [{ "empresa": "italo", "rol": "cajero", "pin": "1234", "sucursal": "Mackey" }] }]
import { ROLES, ROLES_CON_PIN } from '@grupo/shared';
import { hashPin } from '../auth/pin.js';

export async function altaUsuariosDesdeEnv(db, config, { raw = process.env.ALTA_USUARIOS, log = console.log } = {}) {
  if (!raw) return { creados: 0, saltados: 0 };
  let lista;
  try { lista = JSON.parse(raw); } catch { log('[alta] ALTA_USUARIOS no es un JSON válido; se ignora'); return { creados: 0, saltados: 0 }; }
  let creados = 0, saltados = 0;
  for (const p of Array.isArray(lista) ? lista : []) {
    try {
      let usuarioId = (await db.query('select id from core.usuarios where nombre = $1 and email is null limit 1', [p.nombre])).rows[0]?.id ?? null;
      for (const a of p.accesos ?? []) {
        if (!ROLES[a.rol]) { log(`[alta] rol desconocido «${a.rol}» (${p.nombre})`); continue; }
        if (a.pin && !ROLES_CON_PIN.includes(a.rol)) { log(`[alta] el rol ${a.rol} no entra con PIN (${p.nombre})`); continue; }
        const emp = (await db.query('select id from core.empresas where codigo = $1', [a.empresa])).rows[0];
        if (!emp) { log(`[alta] empresa desconocida «${a.empresa}» (${p.nombre})`); continue; }
        if (usuarioId && (await db.query('select 1 from core.accesos where usuario_id = $1 and empresa_id = $2', [usuarioId, emp.id])).rowCount) { saltados++; continue; }
        const suc = a.sucursal ? (await db.query('select id from core.sucursales where empresa_id = $1 and (lower(nombre) = lower($2) or alias = lower($2)) limit 1', [emp.id, a.sucursal])).rows[0] : null;
        if (a.sucursal && !suc) { log(`[alta] sucursal desconocida «${a.sucursal}» (${p.nombre})`); continue; }
        if (!usuarioId) usuarioId = (await db.query('insert into core.usuarios (nombre) values ($1) returning id', [p.nombre])).rows[0].id;
        await db.query(
          `insert into core.accesos (usuario_id, empresa_id, rol, sucursal_ids, pin_hash, pin_cambiado_at) values ($1,$2,$3,$4::uuid[],$5,$6)`,
          [usuarioId, emp.id, a.rol, suc ? [suc.id] : [], a.pin ? hashPin(config, emp.id, String(a.pin)) : null, a.pin ? new Date() : null]);
        creados++;
      }
    } catch (e) { log(`[alta] no se pudo crear a ${p.nombre}: ${e.message}`); }
  }
  log(`[alta] usuarios iniciales: ${creados} acceso(s) creado(s), ${saltados} ya existían`);
  return { creados, saltados };
}
