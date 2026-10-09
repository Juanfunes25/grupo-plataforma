// Cola de ventas SIN CONEXIÓN del POS. Es lógica pura (sin navegador): quien la use le pasa
//   · `almacen`: dónde se guarda (IndexedDB en la caja; un Map en las pruebas) con { todos, poner, borrar, meta, ponerMeta }.
//   · `enviar(payload)`: manda UNA venta al servidor. Rechaza con un error que lleva `status` (0 = no hubo red).
//
// Garantías (probadas en packages/shared/test/cola-offline.test.js):
//   1. Cada venta nace con un `id_cliente` (UUID) que NO cambia nunca. El servidor lo usa para no crear dos facturas
//      si la misma venta llega dos veces (reintento tras un corte, dos pestañas, respuesta perdida).
//   2. Las ventas salen en el orden en que se hicieron. Si falla la red se detiene la fila entera (las demás fallarían igual).
//   3. Un rechazo definitivo del servidor (precio cambiado, producto retirado…) NO se pierde ni bloquea a las demás:
//      queda en estado «revisar» para que un encargado decida. Nunca se borra una venta por error.
//   4. Dos llamadas simultáneas a `sincronizar()` comparten el mismo trabajo: no se envía nada dos veces a la vez.
//   5. Numeración provisional por equipo: OFF-<caja>-0001, 0002… sin repetir (el número FISCAL lo asigna el servidor al sincronizar).

export const EST_PENDIENTE = 'pendiente';
export const EST_ENVIANDO = 'enviando';
export const EST_REVISAR = 'revisar';

/** ¿El fallo es de conexión/servidor (se reintenta) y no un rechazo de la venta? */
export const esFalloDeRed = (e) => {
  const s = Number(e?.status ?? 0);
  return s === 0 || s === 408 || s === 425 || s === 429 || s >= 500;
};
const esFalloDeSesion = (e) => Number(e?.status) === 401 || Number(e?.status) === 403;

export function uuidCliente() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
}

export function crearCola({ almacen, enviar, ahora = () => Date.now() }) {
  let corriendo = null;
  let cadenaNumero = Promise.resolve();

  const ordenadas = (items) => [...items].sort((a, b) => (a.creada - b.creada) || (a.seq - b.seq));

  async function recuperar() {
    // Una pestaña que se cerró a mitad de un envío deja la venta «enviando»; es seguro reenviarla porque el servidor es idempotente.
    if (corriendo) return;
    for (const it of await almacen.todos()) if (it.estado === EST_ENVIANDO) await almacen.poner({ ...it, estado: EST_PENDIENTE });
  }

  async function encolar(payload, extra = {}) {
    const id = payload.id_cliente || uuidCliente();
    const previo = (await almacen.todos()).find((x) => x.id === id);
    if (previo) return previo;   // encolar dos veces la misma venta no la duplica
    const todos = await almacen.todos();
    const seq = todos.reduce((m, x) => Math.max(m, x.seq ?? 0), 0) + 1;
    const item = { id, seq, creada: ahora(), estado: EST_PENDIENTE, intentos: 0, ultimoError: null, payload: { ...payload, id_cliente: id }, ...extra };
    await almacen.poner(item);
    return item;
  }

  async function lista() { return ordenadas(await almacen.todos()); }
  async function resumen() {
    const t = await almacen.todos();
    const pendientes = t.filter((x) => x.estado !== EST_REVISAR).length;
    const revisar = t.filter((x) => x.estado === EST_REVISAR).length;
    return { pendientes, revisar, total: t.length };
  }

  async function procesar() {
    await recuperar();
    const enviadas = [];
    let detenida = null;
    for (const it of ordenadas(await almacen.todos())) {
      if (it.estado === EST_REVISAR) continue;
      await almacen.poner({ ...it, estado: EST_ENVIANDO });
      try {
        const respuesta = await enviar(it.payload, it);
        await almacen.borrar(it.id);   // éxito (incluida la respuesta «ya existía»): la venta ya está en el servidor
        enviadas.push({ id: it.id, respuesta, item: it });
      } catch (e) {
        const intentos = (it.intentos ?? 0) + 1;
        if (esFalloDeRed(e) || esFalloDeSesion(e)) {
          await almacen.poner({ ...it, estado: EST_PENDIENTE, intentos, ultimoError: e.message ?? String(e) });
          detenida = esFalloDeSesion(e) ? 'sesion' : 'red';
          break;
        }
        await almacen.poner({ ...it, estado: EST_REVISAR, intentos, ultimoError: e.message ?? String(e), codigoError: e.codigo ?? null });
      }
    }
    return { enviadas, detenida, ...(await resumen()) };
  }

  function sincronizar() {
    if (!corriendo) corriendo = procesar().finally(() => { corriendo = null; });
    return corriendo;
  }

  async function reintentar(id) {
    const it = (await almacen.todos()).find((x) => x.id === id);
    if (it) await almacen.poner({ ...it, estado: EST_PENDIENTE });
  }
  async function descartar(id) {
    const it = (await almacen.todos()).find((x) => x.id === id);
    if (it) await almacen.borrar(id);
    return it ?? null;
  }

  /** OFF-<caja>-0001: contador por equipo, a prueba de llamadas simultáneas. */
  function siguienteNumero(caja) {
    const p = cadenaNumero.then(async () => {
      const n = (Number(await almacen.meta('contador')) || 0) + 1;
      await almacen.ponerMeta('contador', n);
      return `OFF-${String(caja).toUpperCase().slice(-4)}-${String(n).padStart(4, '0')}`;
    });
    cadenaNumero = p.catch(() => {});
    return p;
  }

  return { encolar, lista, resumen, sincronizar, reintentar, descartar, siguienteNumero, recuperar };
}

/** Almacén en memoria: pruebas, y respaldo cuando el navegador no deja usar IndexedDB. */
export function almacenEnMemoria() {
  const items = new Map(); const metas = new Map();
  return {
    async todos() { return [...items.values()].map((x) => JSON.parse(JSON.stringify(x))); },
    async poner(it) { items.set(it.id, JSON.parse(JSON.stringify(it))); },
    async borrar(id) { items.delete(id); },
    async meta(k) { return metas.get(k); },
    async ponerMeta(k, v) { metas.set(k, v); },
  };
}
