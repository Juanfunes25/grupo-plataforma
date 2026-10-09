import crypto from 'node:crypto';

// Registro de errores del servidor y del navegador en core.errores_sistema, con un resumen para «Estado del sistema».
// Nunca debe romper la petición que lo origina: todo es best-effort.

const recortar = (t, n) => (t == null ? null : String(t).slice(0, n));

/** Quita lo que cambia entre repeticiones del mismo error (ids, números largos) para agruparlos. */
function normalizar(msg) {
  return String(msg ?? '').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>').replace(/\d{3,}/g, '<n>').slice(0, 200);
}
const primerMarco = (pila) => String(pila ?? '').split('\n').find((l) => /\bat\b|@/.test(l))?.replace(/\d+/g, '#').trim().slice(0, 160) ?? '';
export const huellaDe = (origen, mensaje, pila, ruta) =>
  crypto.createHash('sha1').update(`${origen}|${normalizar(mensaje)}|${primerMarco(pila)}|${origen === 'servidor' ? ruta ?? '' : ''}`).digest('hex').slice(0, 16);

export function crearRegistroErrores({ db, config }) {
  let inserciones = 0;
  const colaFallos = [];

  async function registrar({ origen, mensaje, pila, ruta, metodo, estado, usuarioId, empresaId, agente, version, extra }) {
    try {
      if (!['servidor', 'navegador', 'caida', 'aviso'].includes(origen)) return;
      const msg = recortar(mensaje, 600) || '(sin mensaje)';
      const huella = huellaDe(origen, msg, pila, ruta);
      // El mismo error repetido en el último minuto suma una repetición en vez de llenar la tabla.
      const rep = await db.query(
        `update core.errores_sistema set extra = jsonb_set(extra, '{repeticiones}', to_jsonb(coalesce((extra->>'repeticiones')::int, 1) + 1))
          where id = (select id from core.errores_sistema where huella = $1 and created_at > now() - interval '60 seconds' order by id desc limit 1) returning id`, [huella]);
      if (rep.rowCount) return;
      await db.query(
        `insert into core.errores_sistema (origen, mensaje, pila, huella, ruta, metodo, estado, usuario_id, empresa_id, agente, version, extra)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [origen, msg, recortar(pila, 4000), huella, recortar(ruta, 200), recortar(metodo, 10), Number.isInteger(estado) ? estado : null,
          usuarioId ?? null, empresaId ?? null, recortar(agente, 200), recortar(version ?? config.version, 40), JSON.stringify(extra ?? {})]);
      // Poda ocasional: 30 días y como máximo 5 000 filas.
      if (++inserciones % 50 === 0) {
        await db.query(`delete from core.errores_sistema where created_at < now() - interval '30 days'
                        or id < (select coalesce(max(id), 0) - 5000 from core.errores_sistema)`);
      }
    } catch (e) {
      if (colaFallos.length < 20) colaFallos.push(e.message);
    }
  }

  /** Resumen para la pantalla: totales por origen y los errores más repetidos. */
  async function resumen({ horas = 24 * 7 } = {}) {
    const por = (await db.query(
      `select origen, count(*) filter (where created_at > now() - interval '24 hours')::int as h24,
              count(*) filter (where created_at > now() - ($1 || ' hours')::interval)::int as periodo,
              coalesce(sum(coalesce((extra->>'repeticiones')::int, 1)) filter (where created_at > now() - interval '24 hours'), 0)::int as veces24
         from core.errores_sistema group by origen`, [String(horas)])).rows;
    const top = (await db.query(
      `select huella, origen, max(mensaje) as mensaje, max(ruta) as ruta, max(metodo) as metodo, count(*)::int as registros,
              sum(coalesce((extra->>'repeticiones')::int, 1))::int as veces, max(created_at) as ultima, min(created_at) as primera
         from core.errores_sistema where created_at > now() - ($1 || ' hours')::interval and origen in ('servidor','navegador')
        group by huella, origen order by sum(coalesce((extra->>'repeticiones')::int, 1)) desc, max(created_at) desc limit 12`, [String(horas)])).rows;
    return { por_origen: por, mas_repetidos: top };
  }

  async function recientes({ origen = null, limite = 50 } = {}) {
    return (await db.query(
      `select id, created_at, origen, mensaje, pila, ruta, metodo, estado, agente, version, extra
         from core.errores_sistema where ($1::text is null or origen = $1) order by id desc limit $2`, [origen, Math.min(200, limite)])).rows;
  }

  return { registrar, resumen, recientes, fallos: () => colaFallos };
}
