import express from 'express';
import cors from 'cors';
import compression from 'compression';
import fs from 'node:fs';
import path from 'node:path';
import { crearContexto } from './lib/contexto.js';
import { manejadorErrores } from './lib/http.js';
import { rutasPublicas, rutasAuth } from './modulos/auth/rutas.js';
import { montarModulos } from './modulos/indice.js';

/**
 * Construye la aplicación Express. Recibe db y config: así los tests corren el
 * API completo contra un Postgres embebido, sin red.
 */
export function crearApp({ db, config, log = console.error }) {
  const app = express();
  const ctxMgr = crearContexto({ db, config });
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(compression());

  app.use('/api', cors((req, cb) => {
    const origen = req.header('Origin');
    const mismoHost = origen && req.headers.host && origen.endsWith(`://${req.headers.host}`);
    if (!origen || mismoHost || config.origenesPermitidos.includes(origen)) return cb(null, { origin: true });
    cb(new Error('Origen no permitido'));
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  app.get('/api/health', async (_req, res) => {
    try { await db.query('select 1'); res.json({ ok: true, db: db.driver }); }
    catch { res.status(503).json({ ok: false }); }
  });

  app.use('/api/publico', rutasPublicas({ db, ctxMgr }));
  const auth = rutasAuth({ db, config, ctxMgr });
  app.use('/api/auth', auth);
  app.locals.limitadores = auth.limitadores;
  app.locals.ctxMgr = ctxMgr;

  // Todo lo de negocio: sesión + empresa activa obligatorias.
  const negocio = express.Router();
  negocio.use(ctxMgr.autenticar, ctxMgr.conEmpresa);
  montarModulos(negocio, { db, config, ctxMgr });
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

  app.use(manejadorErrores(log));
  return app;
}
