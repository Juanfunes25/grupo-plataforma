// Lectura de la hoja de pesaje manuscrita por foto. El original usaba Gemini; aquí se usa la API de
// Claude (Anthropic) y SOLO si el servidor tiene ANTHROPIC_API_KEY. Sin llave queda desactivado: el
// pesaje manual funciona igual. El humano siempre revisa y corrige antes de guardar.

const MODELO = () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
export const lecturaDisponible = (env = process.env) => Boolean(env.ANTHROPIC_API_KEY);

const SYSTEM_PROMPT = `Eres un asistente experto en transcribir formularios de pesaje de gelato de una heladería (Italo Gelateria, Honduras) escritos A MANO.

Recibes la FOTO de un formulario donde el personal anotó, sabor por sabor, el peso restante de gelato en GRAMOS. A veces hay un nombre de empleado y una fecha escritos a mano en el encabezado.

TU ÚNICA SALIDA es una llamada a la herramienta "registrar_pesaje". No escribas texto fuera de la herramienta.

REGLAS CRÍTICAS:

1. NUNCA inventes valores. Si un peso está borroso, tachado o ilegible, pon "total": null, "legible": false y "confianza": "baja". Es preferible dejar un campo vacío para que un humano lo corrija, que adivinar.

2. SUMAS (a veces pesan pana por pana): un mismo sabor puede tener varios números sumados, ej. "4564 + 4525". En ese caso:
   - "componentes": lista con cada número leído, ej. [4564, 4525]
   - "total": la SUMA de los componentes, ej. 9089
   Si hay un solo número, "componentes" tiene un elemento y "total" es ese número.

3. MAPEO DE NOMBRES: el nombre escrito a mano puede tener variantes de ortografía. Mapea al nombre canónico EXACTO de la lista oficial que te doy cuando sea claramente el mismo sabor (mayúsculas/tildes, errores de tipeo obvios). Si NO corresponde claramente a ninguno de la lista, escribe el nombre tal como se lee - no lo fuerces a la lista.

4. CONFIANZA por cada campo: "alta" (número claro y nítido), "media" (legible pero con alguna duda), "baja" (muy dudoso o casi ilegible). Sé honesto.

5. Casillas vacías: si un sabor de la lista NO aparece o no tiene peso escrito, NO lo incluyas.

6. Captura también, si están escritos: la fecha ("fecha_escrita") y el nombre del empleado ("responsable_escrito"). Son solo de referencia para quien revisa.

El humano revisará y corregirá antes de guardar, así que tu trabajo es leer fielmente, marcar dudas y nunca rellenar lo que no ves.`;

const HERRAMIENTA = {
  name: 'registrar_pesaje',
  description: 'Devuelve los pesos de gelato leídos de la foto del formulario manuscrito.',
  input_schema: {
    type: 'object',
    properties: {
      fecha_escrita: { type: ['string', 'null'] },
      responsable_escrito: { type: ['string', 'null'] },
      items: {
        type: 'array',
        description: 'Todos los sabores leídos en la foto, coincidan o no con la lista oficial.',
        items: {
          type: 'object',
          properties: {
            nombre: { type: 'string', description: 'Nombre del sabor, canónico si coincide con la lista oficial' },
            componentes: { type: 'array', items: { type: 'number' } },
            total: { type: ['number', 'null'] },
            texto_crudo: { type: 'string' },
            confianza: { type: 'string', enum: ['alta', 'media', 'baja'] },
            legible: { type: 'boolean' },
          },
          required: ['nombre', 'componentes', 'total', 'texto_crudo', 'confianza', 'legible'],
        },
      },
      notas: { type: 'string' },
    },
    required: ['items'],
  },
};

/** Separa lo leído en «sabores» (coincide con el catálogo activo de la sucursal) y «sabores_nuevos» (máx. 5, para revisión). */
export function clasificarItems(items, nombresSabores) {
  const normalizar = (s) => s.trim().toUpperCase();
  const catalogo = new Map(nombresSabores.map((n) => [normalizar(n), n]));
  const sabores = []; const saboresNuevos = [];
  for (const item of items) {
    const canonico = catalogo.get(normalizar(item.nombre || ''));
    if (canonico) sabores.push({ ...item, nombre: canonico });
    else if (saboresNuevos.length < 5) saboresNuevos.push(item);
  }
  return { sabores, sabores_nuevos: saboresNuevos };
}

export async function extraerPesajeDeFoto({ imageBase64, mediaType, nombresSabores, fetchFn = fetch, env = process.env }) {
  if (!lecturaDisponible(env)) throw new Error('La lectura por foto no está configurada en el servidor');
  const lista = nombresSabores.map((n) => `- ${n}`).join('\n');
  const r = await fetchFn('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env.ANTHROPIC_MODEL || MODELO(),
      max_tokens: 4096,
      system: `${SYSTEM_PROMPT}\n\nLISTA OFICIAL DE SABORES DE ESTA SUCURSAL:\n${lista}`,
      tools: [HERRAMIENTA],
      tool_choice: { type: 'tool', name: HERRAMIENTA.name },
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: 'Extrae el pesaje de gelato de esta foto. No inventes valores; marca como ilegible lo que no puedas leer.' },
      ] }],
    }),
  });
  if (!r.ok) throw new Error(`El servicio de lectura respondió ${r.status}. Reintenta con una foto más nítida o cárgalo a mano.`);
  const data = await r.json();
  const llamada = (data.content || []).find((c) => c.type === 'tool_use');
  if (!llamada) throw new Error('El modelo no devolvió datos estructurados. Reintenta con una foto más nítida.');
  const { fecha_escrita = null, responsable_escrito = null, items = [], notas = '' } = llamada.input;
  return { fecha_escrita, responsable_escrito, notas, ...clasificarItems(items, nombresSabores) };
}

// ── Freno de uso (en memoria; se reinicia con el servidor) ──
export const LIMITE_POR_HORA = 20;
export const LIMITE_DIARIO_GLOBAL = 120;
export const MAX_MB_ARCHIVO = 8;
const usos = { dia: '', global: 0, porClave: new Map() };

export function registrarUsoIA(clave, ahora = new Date()) {
  const dia = ahora.toISOString().slice(0, 10);
  const hora = ahora.toISOString().slice(0, 13);
  if (usos.dia !== dia) { usos.dia = dia; usos.global = 0; usos.porClave.clear(); }
  if (usos.global >= LIMITE_DIARIO_GLOBAL) return { permitido: false, motivo: 'Se alcanzó el límite de lecturas automáticas de hoy. Cárgalo a mano o prueba mañana.' };
  const k = `${clave}|${hora}`;
  if ((usos.porClave.get(k) || 0) >= LIMITE_POR_HORA) return { permitido: false, motivo: 'Demasiadas lecturas seguidas. Espera unos minutos o cárgalo a mano.' };
  usos.porClave.set(k, (usos.porClave.get(k) || 0) + 1); usos.global += 1;
  return { permitido: true };
}
export const reiniciarUsoIA = () => { usos.dia = ''; usos.global = 0; usos.porClave.clear(); };

export function errorDeTamano(base64) {
  const limpio = String(base64 || '').replace(/^data:[^,]*,/, '');
  const relleno = limpio.endsWith('==') ? 2 : limpio.endsWith('=') ? 1 : 0;
  const mb = (Math.floor((limpio.length * 3) / 4) - relleno) / (1024 * 1024);
  return mb > MAX_MB_ARCHIVO ? `El archivo pesa ${mb.toFixed(1)} MB y el máximo es ${MAX_MB_ARCHIVO} MB. Saca la foto con menos resolución.` : null;
}
