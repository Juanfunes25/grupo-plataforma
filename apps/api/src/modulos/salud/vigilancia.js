// Vigilancia interna: latido cada minuto, caídas detectadas al arrancar y aviso por correo cuando se repiten.
//
// Límite honesto: un proceso caído no puede avisar que cayó. Lo que sí hace es dejar un latido en la base cada minuto;
// al volver a arrancar compara con el último latido y registra la caída ("estuvo sin responder X minutos"). Si se repite
// (3 veces en 24 h por defecto) manda el correo. Para enterarse EN EL MOMENTO de una caída, hay que apuntar un monitor
// externo gratuito (UptimeRobot, Better Stack) a /api/salud: ver docs/RESPALDOS.md.

const MIN_BRECHA_MS = 4 * 60_000;   // un reinicio de despliegue tarda menos; más que esto se cuenta como caída

/** Reclama (de forma atómica) el derecho a mandar este aviso: no se repite antes de `horas`. */
export async function reclamarAviso(db, clave, horas) {
  const r = await db.query(
    `insert into core.sistema_estado (clave, valor, updated_at) values ($1, '{}'::jsonb, now())
     on conflict (clave) do update set updated_at = now() where core.sistema_estado.updated_at <= now() - ($2::int * interval '1 hour')
     returning clave`, [`aviso:${clave}`, horas]);
  return r.rowCount > 0;
}

/**
 * Manda un aviso al dueño usando el servicio de correo de la plataforma. Si el correo no está configurado queda
 * constancia en «Estado del sistema» como aviso pendiente (nunca falla).
 */
export async function avisarDueno({ db, errores, clave, horas = 12, asunto, lineas }) {
  try {
    if (!(await reclamarAviso(db, clave, horas))) return { enviado: false, motivo: 'repetido' };
    let correo, avisos;
    try { [correo, avisos] = await Promise.all([import('../../lib/correo.js'), import('../mensajeria/avisos.js')]); }
    catch { correo = null; }
    const pendiente = async (porque) => { await errores?.registrar({ origen: 'aviso', mensaje: `Aviso sin enviar (${porque}): ${asunto}`, extra: { lineas, clave } }); return { enviado: false, motivo: porque }; };
    if (!correo || !correo.correoConfigurado?.()) return pendiente('correo sin configurar: faltan GMAIL_USER y GMAIL_APP_PASSWORD');
    const para = await avisos.correosDueno(db);
    if (!para.length) return pendiente('no hay un correo de dueño registrado');
    const esc = correo.escaparHtml ?? ((t) => String(t));
    const r = await correo.enviarCorreo({
      para, tipo: 'alerta', referencia: `sistema:${clave}`, asunto, titulo: asunto,
      html: `<ul style="padding-left:18px">${lineas.map((l) => `<li style="margin:4px 0">${esc(l)}</li>`).join('')}</ul><p style="color:#7a716a;font-size:12px">Revisa la pantalla «Estado del sistema» en Administración. Este aviso no se repite antes de ${horas} horas.</p>`,
    });
    return { enviado: Boolean(r.ok || r.pendiente), motivo: r.ok ? 'enviado' : r.pendiente ? 'en cola' : r.error };
  } catch (e) {
    console.error('[vigilancia] no se pudo avisar:', e.message);
    return { enviado: false, motivo: e.message };
  }
}

export function iniciarVigilancia({ db, config, errores, cadaMs = 60_000, minCaidas = Number(process.env.AVISO_CAIDAS_MIN) || 3, log = console.log }) {
  let fallos = 0, desde = null, parado = false, temporizador = null;

  async function evaluarRepeticion() {
    const n = (await db.query(`select count(*)::int as n from core.errores_sistema where origen = 'caida' and created_at > now() - interval '24 hours'`)).rows[0].n;
    if (n >= minCaidas && minCaidas > 0) {
      await avisarDueno({
        db, errores, clave: 'caidas_repetidas', horas: 12, asunto: `Aviso: el sistema se cayó ${n} veces en 24 horas`,
        lineas: [`Se detectaron ${n} caídas o reinicios con interrupción en las últimas 24 horas.`, 'Entra a Estado del sistema (Administración) para ver cuándo ocurrieron y qué error las acompaña.',
          'Si estás en un plan gratuito que «duerme» el servidor, esos reinicios son normales; en ese caso conviene un plan sin suspensión.'],
      });
    }
    return n;
  }

  async function alArrancar() {
    try {
      const prev = (await db.query(`select valor, updated_at from core.sistema_estado where clave = 'latido'`)).rows[0];
      if (prev) {
        const brecha = Date.now() - new Date(prev.valor?.at ?? prev.updated_at).getTime();
        if (brecha > MIN_BRECHA_MS) {
          const min = Math.round(brecha / 60_000);
          await errores.registrar({ origen: 'caida', mensaje: `El servicio estuvo sin responder unos ${min} minuto(s) (último latido ${new Date(prev.valor?.at ?? prev.updated_at).toISOString()})`, extra: { minutos: min, desde: prev.valor?.at ?? null, hasta: new Date().toISOString() } });
          log(`[vigilancia] caída detectada: ${min} min sin latido`);
        }
      }
      await latir();
      await evaluarRepeticion();
    } catch (e) { console.error('[vigilancia] arranque:', e.message); }
  }

  async function latir() {
    await db.query(
      `insert into core.sistema_estado (clave, valor, updated_at) values ('latido', $1::jsonb, now())
       on conflict (clave) do update set valor = excluded.valor, updated_at = now()`, [JSON.stringify({ at: new Date().toISOString(), version: config.version })]);
  }

  async function vuelta() {
    if (parado) return;
    try {
      await Promise.race([db.query('select 1'), new Promise((_, no) => setTimeout(() => no(new Error('la base no respondió en 8 s')), 8000))]);
      if (fallos >= 3) {
        const min = Math.max(1, Math.round((Date.now() - desde) / 60_000));
        await errores.registrar({ origen: 'caida', mensaje: `La base de datos dejó de responder unos ${min} minuto(s) y volvió`, extra: { minutos: min, desde: new Date(desde).toISOString() } });
        await evaluarRepeticion();
      }
      fallos = 0; desde = null;
      await latir();
    } catch (e) {
      if (fallos === 0) desde = Date.now();
      fallos++;
      if (fallos === 3) console.error(`[vigilancia] la base no responde (${e.message})`);
    }
  }

  alArrancar();
  temporizador = setInterval(vuelta, cadaMs);
  temporizador.unref?.();
  return { detener() { parado = true; clearInterval(temporizador); }, vuelta, evaluarRepeticion };
}
