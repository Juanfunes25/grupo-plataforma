import { fechaHN, permisosDe, rtnValido, soloDigitos, UMBRAL_RTN_OBLIGATORIO } from '@grupo/shared';
import { estadoPunto, problemaCai } from '../pos/fiscal.js';

// Asistente fiscal: arma, por empresa, el estado de «lo que falta para facturar en vivo» y las alertas del CAI.

/** Sucursales que facturan: tiendas y fábricas. Bodegas y oficinas no cobran, no necesitan CAI. */
export const FACTURA = new Set(['tienda', 'fabrica']);

const esRtnDePrueba = (rtn) => /^08019000000\d{3}$/.test(soloDigitos(rtn));          // los ficticios de la migración 0026
const esTelefonoDePrueba = (t) => /^[0\s()+-]*$/.test(String(t ?? '')) || /^0{4}-?0{4}$/.test(String(t ?? ''));
const esTextoDePrueba = (t) => /pendiente|\(prueba\)|\[prueba|ficticio/i.test(String(t ?? ''));
const correoValido = (c) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(c ?? '').trim());

export async function leerConfigFiscal(q, empresaId) {
  return (await q.query(`select valor from core.config where empresa_id = $1 and clave = 'fiscal'`, [empresaId])).rows[0]?.valor ?? {};
}
export async function guardarConfigFiscal(q, empresaId, parcial) {
  await q.query(
    `insert into core.config (empresa_id, clave, valor) values ($1, 'fiscal', $2::jsonb)
     on conflict (empresa_id, clave) do update set valor = core.config.valor || $2::jsonb, updated_at = now()`, [empresaId, JSON.stringify(parcial)]);
}

/**
 * Modo de la empresa. «real» solo cuando el asistente declaró la puesta en vivo (en_vivo); mientras tanto es «prueba»,
 * aunque alguna sucursal ya tenga un CAI real cargado (entonces se marca «en preparación»: esa sucursal ya emite con valor fiscal).
 */
export function modoDe(cfgFiscal, sucursales) {
  const facturan = sucursales.filter((s) => FACTURA.has(s.tipo) && s.pe_id);
  const reales = facturan.filter((s) => !s.es_borrador).length;
  const modo = cfgFiscal.en_vivo === true ? 'real' : 'prueba';
  return { modo, sucursales_con_cai_real: reales, sucursales_que_facturan: facturan.length, en_preparacion: modo === 'prueba' && reales > 0 };
}

/** Nivel de una alerta: «critica» si ya no se puede facturar o falta muy poco; «aviso» si hay que ir pidiendo el CAI nuevo. */
export function nivelAlerta(e) {
  if (e.es_borrador) return null;
  if (e.agotado || e.vencido) return 'critica';
  const restantes = e.correlativo_hasta - e.correlativo_actual + 1;
  if ((e.dias_restantes !== null && e.dias_restantes <= 7) || e.porcentaje_usado >= 97 || restantes <= 50) return 'critica';
  if (e.alerta) return 'aviso';
  return null;
}

/**
 * Alertas de CAI (por vencerse o agotarse) de una empresa o de todo el grupo. Es la lista que consume el tablero
 * y el servicio de avisos por correo: cada elemento trae una `clave` estable para no repetir el mismo aviso.
 */
export async function alertasCai(db, { empresaId = null, sucursalIds = [], hoy = fechaHN() } = {}) {
  const { rows } = await db.query(
    `select pe.*, s.nombre as sucursal, s.tipo as sucursal_tipo, e.codigo as empresa_codigo, e.nombre as empresa_nombre
       from pos.puntos_emision pe join core.sucursales s on s.id = pe.sucursal_id join core.empresas e on e.id = pe.empresa_id
      where pe.activo and s.activo and e.activo and not pe.es_borrador and ($1::uuid is null or pe.empresa_id = $1)
        and ($2::uuid[] = '{}' or pe.sucursal_id = any($2::uuid[]))
      order by e.orden, s.orden`, [empresaId, sucursalIds]);
  const out = [];
  for (const pe of rows) {
    const fl = pe.fecha_limite_emision ? String(pe.fecha_limite_emision).slice(0, 10) : null;
    const e = estadoPunto({ ...pe, fecha_limite_emision: fl }, hoy);
    const nivel = nivelAlerta(e);
    if (!nivel) continue;
    const restantes = Math.max(0, pe.correlativo_hasta - pe.correlativo_actual + 1);
    const motivos = [];
    if (e.agotado) motivos.push('el rango de facturas se agotó');
    if (e.vencido) motivos.push(`la fecha límite venció hace ${-e.dias_restantes} día(s)`);
    if (!e.agotado && !e.vencido) {
      if (e.dias_restantes !== null && e.dias_restantes <= 15) motivos.push(`vence en ${e.dias_restantes} día(s)`);
      if (e.porcentaje_usado >= 90) motivos.push(`usó el ${e.porcentaje_usado} % del rango (quedan ${restantes} facturas)`);
    }
    out.push({
      clave: `cai:${pe.id}:${e.agotado ? 'agotado' : e.vencido ? 'vencido' : nivel}`,
      tipo: e.agotado ? 'cai_agotado' : e.vencido ? 'cai_vencido' : e.dias_restantes !== null && e.dias_restantes <= 15 ? 'cai_por_vencer' : 'cai_por_agotarse',
      nivel,
      punto_emision_id: pe.id, sucursal_id: pe.sucursal_id, sucursal: pe.sucursal,
      empresa_id: pe.empresa_id, empresa_codigo: pe.empresa_codigo, empresa: pe.empresa_nombre,
      dias_restantes: e.dias_restantes, restantes, porcentaje_usado: e.porcentaje_usado, fecha_limite_emision: fl,
      mensaje: `${pe.empresa_nombre} · ${pe.sucursal}: ${motivos.join(' y ')}. Pide el CAI nuevo al SAR.`,
    });
  }
  // Lo más urgente primero.
  return out.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'critica' ? -1 : 1));
}

/**
 * Lista de verificación «lo que falta para facturar en vivo».
 * estado: 'ok' · 'falta' (bloquea el modo real) · 'aviso' (conviene arreglar, no bloquea) · 'manual' (lo confirma una persona).
 */
export async function verificarEmpresa(db, empresa, { hoy = fechaHN() } = {}) {
  const emp = (await db.query('select * from core.empresas where id = $1', [empresa.id])).rows[0];
  const sucs = (await db.query(
    `select s.*, pe.id as pe_id, pe.cai, pe.es_borrador, pe.correlativo_desde, pe.correlativo_hasta, pe.correlativo_actual, pe.fecha_limite_emision,
            pe.punto_emision_codigo, pe.punto_venta_codigo, pe.tipo_documento_codigo, pe.activo as pe_activo
       from core.sucursales s left join pos.puntos_emision pe on pe.sucursal_id = s.id and pe.activo
      where s.empresa_id = $1 and s.activo order by s.orden, s.nombre`, [emp.id])).rows;
  const cfg = await leerConfigFiscal(db, emp.id);
  const conf = cfg.confirmaciones ?? {};
  const facturan = sucs.filter((s) => FACTURA.has(s.tipo));
  const items = [];
  const nuevo = (id, titulo, estado, detalle, extra = {}) => items.push({ id, titulo, estado, bloquea: estado === 'falta', detalle, ...extra });

  // 1. Datos de la empresa
  const faltasEmp = [];
  if (!emp.razon_social?.trim() || esTextoDePrueba(emp.razon_social)) faltasEmp.push('razón social real');
  if (!rtnValido(emp.rtn)) faltasEmp.push('RTN de 14 dígitos');
  else if (esRtnDePrueba(emp.rtn)) faltasEmp.push('RTN real (el actual es de prueba)');
  if (!emp.direccion?.trim()) faltasEmp.push('dirección');
  if (!emp.telefono?.trim() || esTelefonoDePrueba(emp.telefono)) faltasEmp.push('teléfono real');
  nuevo('datos_empresa', 'Datos fiscales de la empresa', faltasEmp.length ? 'falta' : 'ok',
    faltasEmp.length ? `Falta: ${faltasEmp.join(', ')}.` : 'Razón social, RTN, dirección y teléfono completos.', { pestana: 'datos' });
  if (!correoValido(emp.correo)) nuevo('correo_empresa', 'Correo de la empresa', 'aviso', 'Conviene un correo para enviar facturas y avisos.', { pestana: 'datos' });

  // 2. Datos de cada sucursal que factura
  const sinDir = facturan.filter((s) => !s.direccion?.trim() && !emp.direccion?.trim());
  const sinTel = facturan.filter((s) => !s.telefono?.trim() && !emp.telefono?.trim());
  nuevo('datos_sucursales', 'Dirección y teléfono de las sucursales', sinDir.length ? 'falta' : sinTel.length ? 'aviso' : 'ok',
    sinDir.length ? `Sin dirección: ${sinDir.map((s) => s.nombre).join(', ')}.` : sinTel.length ? `Sin teléfono: ${sinTel.map((s) => s.nombre).join(', ')}.` : 'Cada sucursal sale con su dirección en la factura.', { pestana: 'datos' });

  // 3. CAI por sucursal
  const pend = [];
  const alertas = await alertasCai(db, { empresaId: emp.id, hoy });
  for (const s of facturan) {
    if (!s.pe_id) { pend.push(`${s.nombre}: sin punto de emisión`); continue; }
    if (s.es_borrador) { pend.push(`${s.nombre}: sin CAI real activado`); continue; }
    const fl = s.fecha_limite_emision ? String(s.fecha_limite_emision).slice(0, 10) : null;
    const p = problemaCai({ ...s, fecha_limite_emision: fl }, hoy);
    if (p) pend.push(`${s.nombre}: ${p}`);
  }
  nuevo('cai', 'CAI vigente en cada sucursal que factura', pend.length ? 'falta' : alertas.length ? 'aviso' : 'ok',
    pend.length ? pend.join(' · ') : alertas.length ? `${alertas.length} CAI por vencerse o agotarse.` : 'Todas las sucursales tienen un CAI real activo y vigente.', { pestana: 'cai', pendientes: pend });

  // 4. Impresora (la configuración vive en cada computadora: la confirma una persona por sucursal)
  const sinImp = facturan.filter((s) => !conf[`impresora_${s.id}`]);
  nuevo('impresora', 'Impresora térmica probada en cada sucursal', sinImp.length ? 'manual' : 'ok',
    sinImp.length ? `Confirma que imprime bien: ${sinImp.map((s) => s.nombre).join(', ')} (Impresora → imprimir prueba).` : 'Confirmada en todas las sucursales.',
    { pestana: 'resumen', confirmar: sinImp.map((s) => ({ id: `impresora_${s.id}`, sucursal_id: s.id, sucursal: s.nombre })) });

  // 5. Usuarios
  const acc = (await db.query(
    `select a.rol, a.sucursal_ids, a.permisos_extra, a.permisos_quitados, u.email, u.es_dueno_grupo
       from core.accesos a join core.usuarios u on u.id = a.usuario_id where a.empresa_id = $1 and a.activo and u.activo`, [emp.id])).rows;
  const puedeCobrar = (s) => acc.some((a) => permisosDe(a.rol, a.permisos_extra, a.permisos_quitados).has('pos:vender') && (!a.sucursal_ids?.length || a.sucursal_ids.includes(s.id)));
  const sinCajero = facturan.filter((s) => !puedeCobrar(s));
  const hayDireccion = acc.some((a) => ['dueno', 'admin'].includes(a.rol) && a.email);
  const probU = [];
  if (!hayDireccion) probU.push('no hay un dueño o administrador con correo');
  if (sinCajero.length) probU.push(`nadie puede cobrar en: ${sinCajero.map((s) => s.nombre).join(', ')}`);
  nuevo('usuarios', 'Usuarios listos', probU.length ? 'falta' : 'ok', probU.length ? `Falta: ${probU.join('; ')}.` : 'Hay quien administre y quien cobre en cada sucursal.', { pestana: 'usuarios' });

  const modo = modoDe(cfg, sucs);
  const faltan = items.filter((i) => i.bloquea).length;
  const porConfirmar = items.filter((i) => i.estado === 'manual').length;
  return {
    empresa: emp, sucursales: sucs, config: cfg, items, alertas, ...modo,
    faltan, por_confirmar: porConfirmar,
    listo_para_real: faltan === 0 && porConfirmar === 0,
  };
}

export { UMBRAL_RTN_OBLIGATORIO, correoValido };
