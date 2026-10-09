// /api/mensajeria — pantalla «Correo y avisos» de Administración (solo dueño y administrador).
import { Router } from 'express';
import { z } from 'zod';
import { requierePermiso } from '../../lib/contexto.js';
import { auditar } from '../../lib/auditoria.js';
import { malaPeticion, noEncontrado, prohibido, uuid, validar } from '../../lib/http.js';
import { configurarCorreo, estadoCorreo, enviarCorreo, reintentarCorreo, normalizarDestinatarios, escaparHtml as esc } from '../../lib/correo.js';
import { TIPOS_AVISO, ORDEN_TIPOS, reglaDe, guardarRegla, listaCorreos, correosDueno } from './avisos.js';
import { enviarResumenDiario } from './resumen.js';

const PASOS_GMAIL = [
  'Entra a la cuenta de Gmail que enviará los correos y activa la verificación en dos pasos (myaccount.google.com, Seguridad).',
  'En la misma página de Seguridad busca «Contraseñas de aplicaciones» y crea una nueva con el nombre «Plataforma del Grupo».',
  'Google te muestra una clave de 16 letras. Cópiala (los espacios no importan).',
  'En Render, abre el servicio de la plataforma, entra a Environment y agrega dos variables: GMAIL_USER (el correo completo de Gmail) y GMAIL_APP_PASSWORD (la clave de 16 letras).',
  'Guarda los cambios: Render reinicia el servicio solo. Vuelve a esta pantalla y pulsa «Enviar correo de prueba».',
];

export function rutasMensajeria({ db, config }) {
  const r = Router();
  configurarCorreo({ db, config });
  r.use(requierePermiso('admin:usuarios'));
  const esDueno = (req) => req.ctx.permisos.has('grupo:ver');

  /** Tipos que ve este usuario en la empresa activa. */
  function tiposVisibles(req) {
    return ORDEN_TIPOS.filter((t) => {
      const d = TIPOS_AVISO[t];
      if (d.ambito === 'grupo') return esDueno(req);
      if (!d.solo) return true;
      return d.solo.some((m) => req.ctx.empresa.modulos.includes(m));
    });
  }

  r.get('/estado', async (req, res) => {
    const reglas = [];
    for (const tipo of tiposVisibles(req)) {
      const d = TIPOS_AVISO[tipo];
      const regla = await reglaDe(db, d.ambito === 'grupo' ? null : req.ctx.empresa.id, tipo);
      reglas.push({ ...regla, nombre: d.nombre, descripcion: d.descripcion, ambito: d.ambito, usa_hora: d.hora !== undefined, usa_umbral: d.umbral !== undefined });
    }
    const [cuenta, duenos, recientes] = await Promise.all([
      db.query(`select estado, count(*)::int as n from msg.correos where (empresa_id = $1 or ($2 and empresa_id is null)) and created_at > now() - interval '7 days' group by estado`, [req.ctx.empresa.id, esDueno(req)]),
      correosDueno(db),
      db.query(`select max(enviado_at) as ultimo from msg.correos where (empresa_id = $1 or ($2 and empresa_id is null)) and estado = 'enviado'`, [req.ctx.empresa.id, esDueno(req)]),
    ]);
    res.json({
      ...estadoCorreo(), pasos: PASOS_GMAIL, variables: ['GMAIL_USER', 'GMAIL_APP_PASSWORD'],
      reglas, destinatarios_por_defecto: duenos, ultimo_envio: recientes.rows[0]?.ultimo ?? null,
      ultimos_7_dias: Object.fromEntries(cuenta.rows.map((x) => [x.estado, x.n])),
    });
  });

  const esquemaRegla = z.object({
    activo: z.boolean(),
    destinatarios: z.union([z.array(z.string()), z.string()]).default([]),
    hora: z.coerce.number().int().min(0).max(23).optional().nullable(),
    horas_entre: z.coerce.number().int().min(1).max(168),
    umbral: z.coerce.number().min(0).max(1_000_000).optional().nullable(),
  });
  r.put('/avisos/:tipo', async (req, res) => {
    const tipo = req.params.tipo;
    const def = TIPOS_AVISO[tipo];
    if (!def || !tiposVisibles(req).includes(tipo)) throw noEncontrado('Ese aviso no existe');
    if (def.ambito === 'grupo' && !esDueno(req)) throw prohibido('Solo el dueño del grupo cambia este aviso');
    const b = validar(esquemaRegla, req.body);
    let destinatarios;
    try { destinatarios = listaCorreos(b.destinatarios); } catch (e) { throw malaPeticion(e.message); }
    const empresaId = def.ambito === 'grupo' ? null : req.ctx.empresa.id;
    await guardarRegla(db, { empresaId, tipo, activo: b.activo, destinatarios, hora: b.hora ?? def.hora ?? null, horas_entre: b.horas_entre, umbral: b.umbral ?? def.umbral ?? null, usuarioId: req.ctx.usuario.id });
    await auditar(db, req.ctx, 'aviso_configurado', 'aviso', tipo, { tipo, activo: b.activo, destinatarios, hora: b.hora ?? null, horas_entre: b.horas_entre });
    res.json(await reglaDe(db, empresaId, tipo));
  });

  r.post('/prueba', async (req, res) => {
    const b = validar(z.object({ para: z.string().trim().max(300).optional() }), req.body ?? {});
    let { validos } = normalizarDestinatarios(b.para || req.ctx.usuario.email || '');
    if (!validos.length) validos = (await correosDueno(db)).slice(0, 3);
    if (!validos.length) throw malaPeticion('Escribe el correo al que quieres mandar la prueba');
    const out = await enviarCorreo({
      empresaId: req.ctx.empresa.id, para: validos, tipo: 'prueba', usuario: req.ctx.usuario,
      asunto: `Prueba de correo – ${req.ctx.empresa.nombre}`, titulo: 'Correo de prueba',
      html: `<p style="margin:0 0 10px">Si estás leyendo esto, el correo de la plataforma funciona.</p><p style="margin:0;color:#7a716a">Enviado por ${esc(req.ctx.usuario.nombre)} desde ${esc(req.ctx.empresa.nombre)}.</p>`,
    });
    await auditar(db, req.ctx, 'correo_prueba', 'correo', out.id ?? null, { para: validos, ok: out.ok, pendiente: out.pendiente, error: out.error });
    res.json({ ...out, para: validos });
  });

  r.post('/resumen/enviar-ahora', async (req, res) => {
    if (!esDueno(req)) throw prohibido('El resumen del grupo es solo para el dueño');
    const b = validar(z.object({ para: z.string().trim().max(300).optional() }), req.body ?? {});
    const para = b.para ? normalizarDestinatarios(b.para).validos : null;
    if (b.para && !para.length) throw malaPeticion('Correo no válido');
    const out = await enviarResumenDiario({ db, ahora: new Date(), forzar: true, usuario: req.ctx.usuario, para });
    await auditar(db, req.ctx, 'resumen_enviado_manual', 'correo', null, { fecha: out.fecha ?? null, ok: out.enviado, pendiente: out.pendiente ?? false, error: out.error ?? out.motivo ?? null });
    res.json(out);
  });

  r.get('/historial', async (req, res) => {
    const f = validar(z.object({ estado: z.enum(['enviado', 'pendiente', 'fallido']).optional(), tipo: z.string().max(20).optional(), limite: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
    const { rows } = await db.query(
      `select id, tipo, referencia, para, asunto, estado, intentos, ultimo_error, enviado_at, created_at, proximo_intento, usuario_nombre,
              exists (select 1 from msg.adjuntos a where a.correo_id = c.id) as con_adjunto
         from msg.correos c
        where (c.empresa_id = $1 or ($2 and c.empresa_id is null)) and ($3::text is null or c.estado = $3) and ($4::text is null or c.tipo = $4)
        order by c.created_at desc limit $5`, [req.ctx.empresa.id, esDueno(req), f.estado ?? null, f.tipo ?? null, f.limite]);
    res.json(rows);
  });

  r.post('/historial/:id/reintentar', async (req, res) => {
    const id = validar(uuid, req.params.id);
    const { rows } = await db.query('select empresa_id from msg.correos where id = $1', [id]);
    const c = rows[0];
    if (!c || (c.empresa_id !== req.ctx.empresa.id && !(c.empresa_id === null && esDueno(req)))) throw noEncontrado('Correo no encontrado');
    const out = await reintentarCorreo(id);
    await auditar(db, req.ctx, 'correo_reintentado', 'correo', id, { ok: out.ok, error: out.error ?? null });
    res.json(out);
  });

  return r;
}
