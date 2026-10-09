import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { crearContexto } from './lib/contexto.js';
import { ErrorHttp, manejadorErrores } from './lib/http.js';
import { rutasPublicas, rutasAuth } from './modulos/auth/rutas.js';
import { montarModulos } from './modulos/indice.js';
import { crearRegistroErrores } from './lib/errores.js';
import { crearLimitador } from './lib/limitador.js';

/**
 * Construye la aplicación Express. Recibe db y config: así los tests corren el
 * API completo contra un Postgres embebido, sin red.
 */
export function crearApp({ db, config, log = console.error }) {
  const app = express();
  const ctxMgr = crearContexto({ db, config });
  const errores = crearRegistroErrores({ db, config });
  app.locals.errores = errores;
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(compression());

  // Encabezados de seguridad básicos (sin CSP: la app usa estilos en línea). HSTS solo en producción (detrás de HTTPS).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
    if (config.produccion) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });

  app.use('/api', cors((req, cb) => {
    const origen = req.header('Origin');
    const mismoHost = origen && req.headers.host && origen.endsWith(`://${req.headers.host}`);
    if (!origen || mismoHost || config.origenesPermitidos.includes(origen)) return cb(null, { origin: true });
    cb(new ErrorHttp(403, 'Origen no permitido', 'origen'));
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Todo error 5xx queda en core.errores_sistema (con ruta, usuario y empresa) y se avisa al módulo de correo si existe.
  app.use('/api', (req, res, next) => {
    res.on('finish', () => {
      if (res.statusCode < 500) return;
      const err = res.locals.errorServidor;
      errores.registrar({
        origen: 'servidor', mensaje: err?.message ?? `HTTP ${res.statusCode}`, pila: err?.stack, ruta: String(req.originalUrl ?? '').split('?')[0], metodo: req.method,
        estado: res.statusCode, usuarioId: req.ctx?.usuario?.id ?? req.auth?.usuario?.id, empresaId: req.ctx?.empresa?.id, agente: req.headers['user-agent'],
      });
      if (err) alertaGrave?.(req, err);
    });
    next();
  });
  // El aviso por correo de errores graves (módulo de mensajería) se engancha aquí si está disponible.
  let alertaGrave = null;
  import('./modulos/mensajeria/alertas.js').then((m) => { alertaGrave = m.registrarErrorGrave ?? null; }).catch(() => {});

  // Único endpoint público de salud (para monitores externos como UptimeRobot): sin datos sensibles. El detalle vive en /api/sistema/estado (dueño).
  app.get('/api/health', async (_req, res) => {
    const t0 = Date.now();
    try { await db.query('select 1'); res.json({ ok: true, db: db.driver, ms: Date.now() - t0, version: config.version || null }); }
    catch { res.status(503).json({ ok: false }); }
  });

  // Errores de pantalla que reportan los navegadores. Abierto (puede ocurrir antes de entrar), por eso con tope por IP y tamaño.
  const limErrores = crearLimitador({ max: 40, ventanaMs: 10 * 60_000 });
  app.post('/api/errores-cliente', (req, res) => {
    const ip = req.ip || '';
    if (limErrores.bloqueado(ip)) return res.status(429).json({ ok: false });
    limErrores.fallo(ip);   // cuenta cada reporte
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    errores.registrar({
      origen: 'navegador', mensaje: String(b.mensaje ?? '').slice(0, 600), pila: String(b.pila ?? '').slice(0, 4000), ruta: String(b.ruta ?? '').slice(0, 200),
      agente: req.headers['user-agent'], version: String(b.version ?? '').slice(0, 40), extra: { empresa: String(b.empresa ?? '').slice(0, 40), tipo: String(b.tipo ?? '').slice(0, 30) },
    });
    res.status(202).json({ ok: true });
  });

  app.use('/api/publico', rutasPublicas({ db, ctxMgr }));
  const auth = rutasAuth({ db, config, ctxMgr });
  app.use('/api/auth', auth);
  app.locals.limitadores = auth.limitadores;
  app.locals.ctxMgr = ctxMgr;

  // Todo lo de negocio: sesión + empresa activa obligatorias.
  const negocio = express.Router();
  negocio.use(ctxMgr.autenticar, ctxMgr.conEmpresa);
  montarModulos(negocio, { db, config, ctxMgr, errores });
  app.use('/api', negocio);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // Frontend compilado (PWA) servido por el mismo servicio.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, {
      setHeaders(res, f) {
        if (path.basename(f) === 'sw.js' || path.basename(f) === 'index.html') res.setHeader('Cache-Control', 'no-cache');
        else if (/\.(js|css|woff2?|png|svg)$/.test(f)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html')));
  }

  // Deja el error a mano para el registro de arriba (res.on('finish')) y sigue al manejador normal.
  app.use((err, _req, res, next) => { res.locals.errorServidor = err; next(err); });
  app.use(manejadorErrores(log));
  return app;
}
