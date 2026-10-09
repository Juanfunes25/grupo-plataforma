// Caché de respuestas de LECTURA pesadas (catálogo, tableros, dashboard, gerente digital).
//
// Reglas que lo hacen seguro:
//  · Solo las rutas de la lista blanca de abajo, y solo GET con respuesta 200.
//  · Antes de servir una respuesta guardada se exige el MISMO permiso que pide la ruta.
//  · La clave incluye la empresa y, según la ruta, a la persona (o sus sucursales): nadie ve datos de otro.
//  · Cualquier cambio (POST/PUT/PATCH/DELETE exitoso) en una empresa borra TODAS sus entradas; los tableros de Dirección
//    se borran con un cambio en cualquier empresa. Así una venta recién cobrada se ve en el siguiente refresco.
//  · Vence solo (ttl) y se corta si hubo un cambio mientras se calculaba la respuesta.
// Un solo proceso: igual que los límites de intentos (ver «Límites actuales» en ARQUITECTURA.md).

const REGLAS = [
  // [prefijo exacto de la ruta, ttl segundos, permisos (cualquiera), compartida entre quienes ven las mismas sucursales]
  { ruta: '/api/pos/catalogo/version', ttl: 10, permisos: ['pos:vender', 'pos:catalogo', 'pos:reportes'], compartida: true },
  { ruta: '/api/pos/catalogo', ttl: 60, permisos: ['pos:vender', 'pos:catalogo', 'pos:reportes'], compartida: true },
  { ruta: '/api/pos/dashboard', ttl: 30, permisos: ['pos:reportes'] },
  { ruta: '/api/pos/reportes/resumen', ttl: 30, permisos: ['pos:reportes'] },
  { ruta: '/api/tablero', ttl: 20, permisos: ['pos:reportes'], grupo: false },
  { ruta: '/api/tablero/grupo', ttl: 20, permisos: ['grupo:ver'], grupo: true },
  { ruta: '/api/grupo/resumen', ttl: 30, permisos: ['grupo:ver'], grupo: true },
  { ruta: '/api/gerente', ttl: 60, permisos: ['gerente:ver'] },
];

// Escrituras que ocurren todo el tiempo y no cambian lo que muestran estas lecturas.
const RUIDO = /^\/api\/(auth|errores-cliente|antifraude\/(sesion|evento)|pos\/antifraude\/evento|sistema)\b/;

export function crearCache({ activo = true, max = 400, ahora = () => Date.now() } = {}) {
  const entradas = new Map();
  let epoca = 0;
  const stats = { aciertos: 0, fallos: 0, invalidaciones: 0 };

  function invalidar(empresaId) {
    epoca++; stats.invalidaciones++;
    for (const [k, e] of entradas) if (e.grupo || e.empresaId === empresaId) entradas.delete(k);
  }
  const limpiar = () => { epoca++; entradas.clear(); };

  function middleware(req, res, next) {
    if (!activo || !req.ctx) return next();
    const ruta = req.originalUrl.split('?')[0].replace(/\/+$/, '');

    // Escritura exitosa → se borra lo guardado de esa empresa.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (!RUIDO.test(ruta)) res.on('finish', () => { if (res.statusCode < 400) invalidar(req.ctx.empresa.id); });
      return next();
    }
    if (req.method !== 'GET') return next();
    const regla = REGLAS.find((r) => r.ruta === ruta);
    if (!regla || !regla.permisos.some((p) => req.ctx.permisos.has(p))) return next();

    const quien = regla.compartida ? `s:${[...req.ctx.sucursalIds].sort().join(',')}` : `u:${req.ctx.usuario.id}`;
    const clave = `${req.ctx.empresa.id}|${quien}|${req.originalUrl}`;
    const e = entradas.get(clave);
    if (e && ahora() - e.ts < regla.ttl * 1000) {
      stats.aciertos++;
      res.setHeader('X-Cache', 'HIT');
      return res.type('application/json').send(e.cuerpo);
    }
    stats.fallos++;
    res.setHeader('X-Cache', 'MISS');
    const epocaInicio = epoca;
    const json = res.json.bind(res);
    res.json = (cuerpo) => {
      if (res.statusCode === 200 && epocaInicio === epoca) {
        if (entradas.size >= max) entradas.delete(entradas.keys().next().value);
        entradas.set(clave, { ts: ahora(), cuerpo: JSON.stringify(cuerpo), empresaId: req.ctx.empresa.id, grupo: Boolean(regla.grupo) });
      }
      return json(cuerpo);
    };
    next();
  }

  return { middleware, invalidar, limpiar, stats: () => ({ ...stats, entradas: entradas.size }) };
}
