// Temporizador interno (sin cron externo): cada minuto reintenta la cola de correos, manda el resumen diario a su hora
// y, cada 10 minutos, evalúa las alertas. Todo es idempotente (claves en msg.avisos_estado), así que reinicios o
// dos instancias del servicio no duplican avisos.
import { configurarCorreo, iniciarColaCorreo, procesarCola, detenerColaCorreo } from '../../lib/correo.js';
import { ganchoErrores } from '../../lib/http.js';
import { enviarResumenDiario } from './resumen.js';
import { evaluarAlertas, avisarErroresGraves, registrarErrorGrave } from './alertas.js';
import { empresasActivas } from './resumen.js';

let reloj = null;
let ocupado = false;
let vueltas = 0;

export async function vuelta({ db, ahora = new Date(), alertas = true } = {}) {
  const out = { resumen: null, alertas: [], errores: null };
  out.resumen = await enviarResumenDiario({ db, ahora }).catch((e) => ({ enviado: false, motivo: e.message }));
  if (alertas) {
    out.alertas = await evaluarAlertas({ db, empresas: await empresasActivas(db), ahora }).catch((e) => { console.error('[avisos]', e.message); return []; });
    out.errores = await avisarErroresGraves({ db, ahora }).catch(() => null);
  }
  return out;
}

export function iniciarMensajeria({ db, config, cada = 60_000 }) {
  configurarCorreo({ db, config });
  ganchoErrores.fn = registrarErrorGrave;
  iniciarColaCorreo();
  if (reloj) return;
  reloj = setInterval(async () => {
    if (ocupado) return;
    ocupado = true;
    try { vueltas += 1; await vuelta({ db, alertas: vueltas % 10 === 1 }); }
    catch (e) { console.error('[mensajeria]', e.message); }
    finally { ocupado = false; }
  }, cada);
  reloj.unref?.();
  console.log('[mensajeria] temporizador de correo y avisos activo');
}

export function detenerMensajeria() {
  if (reloj) clearInterval(reloj);
  reloj = null;
  detenerColaCorreo();
  ganchoErrores.fn = null;
}
export { procesarCola };
