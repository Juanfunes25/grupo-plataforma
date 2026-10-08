import {
  GRAVEDAD, NIVEL, crearLimpieza, agruparPor, compuerta, crearHallazgo, diasEntre, fechaCorta, plural, resultado, sinDatos,
} from '../nucleo.js';

const AREA = 'sistema';
const fechaDeSQL = (texto) => String(texto || '').slice(0, 10);
const nombreTienda = (datos, id) => (id ? datos.sucursales.find((s) => s.id === id)?.nombre || id : 'Fábrica');

const BASE_SEGURIDAD = {
  id: 'seguridad_configuracion',
  nombre: 'Seguridad y configuración de la app',
  area: AREA,
};

/**
 * Lo que la app necesita para estar bien cerrada. Es la única verificación que mira cómo está
 * configurado el propio servidor, no los datos del negocio.
 *
 * Sin JWT_SECRET las sesiones se firman con una clave derivada de otra variable, y sin ninguna
 * de las dos con una clave que está escrita en el código y es pública: cualquiera que la
 * conozca puede fabricarse un acceso de dueño sin saber ningún PIN.
 *
 * Nunca se muestra el valor de ninguna variable, solo si existe.
 */
export function seguridadConfiguracion(datos) {
  const e = datos.entorno || {};
  if (!e.produccion) return sinDatos(BASE_SEGURIDAD, 'Estás corriendo en desarrollo: la configuración de producción no se puede auditar desde acá.');

  const hallazgos = [];
  if (!e.jwtSecret) {
    const peorCaso = !e.tursoToken;
    hallazgos.push(crearHallazgo({
      verificacion: BASE_SEGURIDAD.id, area: AREA, clave: 'jwt-secret',
      titulo: peorCaso
        ? 'Las sesiones están firmadas con una clave pública: cualquiera podría entrar como dueño'
        : 'Falta APP_JWT_SECRET: las sesiones se firman con una clave de respaldo',
      detalle: peorCaso
        ? 'No hay JWT_SECRET ni token de la base: la app usa la clave de desarrollo, que está escrita en el código.'
        : 'Se está usando una clave derivada del token de la base de datos. Funciona, pero si ese token cambia, se cierra la sesión de todos, y no es una clave pensada para firmar sesiones.',
      gravedad: peorCaso ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA,
      nivel: NIVEL.CONFIRMADO,
      evidencia: [
        'APP_JWT_SECRET: no definida',
        `Token de la base (TURSO_AUTH_TOKEN): ${e.tursoToken ? 'definido' : 'no definido'}`,
      ],
      compuertas: [
        compuerta('La app corre en producción (hay una base remota configurada)', true),
        compuerta('La variable no existe en el servidor', true),
        compuerta('Es un hecho de configuración: no depende de interpretar datos', true),
      ],
      descartado: ['No es un falso positivo: se leyó el entorno real del servidor.'],
      accion: 'En Railway → tu servicio → Variables, agregá APP_JWT_SECRET con un texto largo y al azar (32 caracteres o más) y volvé a desplegar. Todos van a tener que entrar de nuevo una vez.',
    }));
  }
  if (!e.gemini) {
    hallazgos.push(crearHallazgo({
      verificacion: BASE_SEGURIDAD.id, area: AREA, clave: 'gemini',
      titulo: 'La lectura de pesajes por foto está apagada',
      detalle: 'Falta ANTHROPIC_API_KEY: la lectura de la hoja de pesaje por foto queda desactivada (el pesaje manual funciona igual).',
      gravedad: GRAVEDAD.BAJA, nivel: NIVEL.OBSERVAR,
      evidencia: ['ANTHROPIC_API_KEY: no definida'],
      compuertas: [compuerta('La variable no existe en el servidor', true)],
      descartado: [],
      accion: 'Si querés usar la lectura por foto, agregá ANTHROPIC_API_KEY en Railway → Variables. Si no la usás, ignorá este aviso.',
    }));
  }
  return resultado(BASE_SEGURIDAD, { hallazgos, revisado: '3 variables de configuración del servidor' });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_INCIDENCIAS = {
  id: 'incidencias_sin_cerrar',
  nombre: 'Incidencias abiertas hace demasiado',
  area: AREA,
};

// Cuánto es "demasiado" depende de qué tan grave es: una alta no puede esperar una semana.
const DIAS_MAXIMOS = { alta: 2, media: 7, baja: 21 };

export function incidenciasSinCerrar(datos) {
  if (!datos.incidencias.length) return sinDatos(BASE_INCIDENCIAS, 'No hay incidencias abiertas.');
  const viejas = datos.incidencias
    .map((i) => ({ ...i, edad: diasEntre(fechaDeSQL(i.creado_en), datos.hoy) }))
    .filter((i) => i.estado !== 'cerrada' && i.edad >= (DIAS_MAXIMOS[i.gravedad] ?? 7))
    .sort((a, b) => (b.gravedad === 'alta') - (a.gravedad === 'alta') || b.edad - a.edad);
  if (!viejas.length) return resultado(BASE_INCIDENCIAS, { revisado: `${datos.incidencias.length} incidencias abiertas` });

  const hayAlta = viejas.some((i) => i.gravedad === 'alta');
  return resultado(BASE_INCIDENCIAS, {
    revisado: `${datos.incidencias.length} incidencias abiertas`,
    hallazgos: [crearHallazgo({
      verificacion: BASE_INCIDENCIAS.id, area: AREA, clave: 'global',
      titulo: `${viejas.length} ${plural(viejas.length, 'incidencia abierta', 'incidencias abiertas')} hace más de lo razonable`,
      detalle: 'Se reportó algo y nadie lo cerró: o sigue sin resolverse, o se resolvió y falta cerrarlo.',
      gravedad: hayAlta ? GRAVEDAD.ALTA : GRAVEDAD.MEDIA, nivel: NIVEL.CONFIRMADO,
      evidencia: viejas.slice(0, 5).map((i) => `${i.gravedad.toUpperCase()} · ${nombreTienda(datos, i.sucursal_id)} · hace ${i.edad} días: ${String(i.descripcion).slice(0, 70)}`),
      compuertas: [
        compuerta('Se comparó la antigüedad contra el límite de su gravedad (alta 2 días, media 7, baja 21)', true),
        compuerta('Siguen abiertas o en revisión', true),
      ],
      descartado: ['No son incidencias nuevas: todas pasaron su plazo.'],
      accion: 'Revisalas en Calidad: cerrá las que ya se resolvieron y atendé las que no.',
    })],
  });
}

// ──────────────────────────────────────────────────────────────────────────────────────────

const BASE_MANTENIMIENTO = {
  id: 'mantenimiento_pendiente',
  nombre: 'Equipos que siguen sin repararse',
  area: AREA,
};

/**
 * Un reporte de equipo que lleva semanas sin marcarse como listo casi siempre es un registro que
 * nadie cerró (ya se arregló, o se decidió no arreglar), no una avería activa. Por eso no es una
 * alarma: se muestra como "por ordenar", con el nombre de cada equipo para que lo veas.
 */
export function mantenimientoPendiente(datos) {
  if (!datos.mantenimientos.length) return sinDatos(BASE_MANTENIMIENTO, 'No hay reportes de mantenimiento.');
  const viejos = datos.mantenimientos.filter((m) => !m.listo && diasEntre(m.fecha, datos.hoy) >= 14);
  const limpieza = [];
  if (viejos.length) {
    limpieza.push(crearLimpieza({
      verificacion: BASE_MANTENIMIENTO.id, area: AREA, clave: 'reportes-viejos',
      titulo: `${viejos.length} ${plural(viejos.length, 'reporte de equipo', 'reportes de equipos')} sin cerrar hace 2 semanas o más`,
      detalle: 'Se reportaron y nadie los marcó como listos. Suele ser que ya se arreglaron o se dejaron así, y solo falta cerrarlos.',
      accion: 'Revisa la lista: si algún equipo sigue roto de verdad, atiéndelo; los demás ciérralos.',
      evidencia: viejos.slice(0, 5).map((m) => `${m.equipo} · ${nombreTienda(datos, m.sucursal_id || null)} (${fechaCorta(m.fecha)}, hace ${diasEntre(m.fecha, datos.hoy)} días)`),
      filas: [...agruparPor(viejos, (m) => m.sucursal_id || 'fabrica')].map(([id, l]) => ({
        tienda: nombreTienda(datos, id === 'fabrica' ? null : id), cantidad: l.length, mas_vieja_dias: Math.max(...l.map((m) => diasEntre(m.fecha, datos.hoy))),
      })),
    }));
  }
  return resultado(BASE_MANTENIMIENTO, { revisado: `${datos.mantenimientos.length} reportes de mantenimiento`, limpieza });
}

export const VERIFICACIONES_SISTEMA = [seguridadConfiguracion, incidenciasSinCerrar, mantenimientoPendiente];
