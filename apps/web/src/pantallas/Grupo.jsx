import { useState } from 'react';
import { fechaHN, lempiras, sumarDias } from '@grupo/shared';
import { get, qs } from '../api.js';
import { BarrasH, Columnas, Estado, Kpi, useDatos } from '../ui/kit.jsx';

const PERIODOS = () => { const h = fechaHN(); return { 'Este mes': [`${h.slice(0, 8)}01`, h], '7 días': [sumarDias(h, -6), h], '30 días': [sumarDias(h, -29), h], Hoy: [h, h] }; };

export default function Grupo() {
  const [per, setPer] = useState('Este mes');
  const [desde, hasta] = PERIODOS()[per];
  const d = useDatos(() => get(`/grupo/resumen${qs({ desde, hasta })}`), [desde, hasta]);
  const alertas = useDatos(() => get('/grupo/alertas'), []);
  const nAlertas = alertas.datos ? Object.values(alertas.datos).reduce((s, l) => s + l.length, 0) : 0;

  return (
    <div className="pagina" style={{ maxWidth: 1360 }}>
      <div className="encabezado-pagina"><div><h1>Dirección del grupo</h1><small>Todas las empresas en una sola vista · {desde} a {hasta}</small></div>
        <select value={per} onChange={(e) => setPer(e.target.value)} aria-label="Periodo">{Object.keys(PERIODOS()).map((p) => <option key={p}>{p}</option>)}</select></div>
      <Estado d={d}>{(r) => r.empresas.length === 0 ? <div className="aviso-caja">Tu usuario no tiene permiso para ver el consolidado.</div> : (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas netas consolidadas" valor={lempiras(r.total.ventas_netas_consolidadas)} sub={r.total.eliminacion_intercompania > 0 ? `Eliminadas ${lempiras(r.total.eliminacion_intercompania)} entre empresas` : `${r.total.facturas} facturas`} />
            <Kpi etiqueta="Vendido hoy" valor={lempiras(r.total.hoy)} />
            <Kpi etiqueta="Utilidad bruta" valor={lempiras(r.total.utilidad_bruta)} sub={`Costo de ventas ${lempiras(r.total.costo_ventas)}`} />
            <Kpi etiqueta="Utilidad operativa" valor={lempiras(r.total.utilidad_operativa)} sub={`Gastos ${lempiras(r.total.gastos_operativos)}`} />
          </div>
          <div className="rejilla cols-2">
            <div className="tarjeta"><h3>Ventas netas por empresa</h3><BarrasH datos={r.empresas} etiqueta={(e) => e.nombre} valor={(e) => e.ventas_netas} formato={lempiras} color={(e) => e.color} /></div>
            <div className="tarjeta"><h3>Utilidad operativa por empresa</h3><BarrasH datos={r.empresas.map((e) => ({ ...e, u: Math.max(0, e.utilidad_operativa) }))} etiqueta={(e) => e.nombre} valor={(e) => e.u} formato={(v) => lempiras(v)} color={(e) => e.color} /></div>
          </div>
          <div className="rejilla cols-2">
            {r.empresas.map((e) => (
              <section key={e.codigo} className="tarjeta" style={{ borderTop: `4px solid ${e.color}`, display: 'grid', gap: 10 }}>
                <div className="fila espacio"><h2>{e.nombre}</h2><span className="chip">hoy {lempiras(e.hoy.total)}</span></div>
                <div className="rejilla cols-3" style={{ gap: 8 }}>
                  <div><small>Ventas netas</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600 }}>{lempiras(e.ventas_netas)}</div></div>
                  <div><small>Margen bruto</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600 }}>{e.margen_bruto_pct == null ? '—' : `${e.margen_bruto_pct}%`}</div></div>
                  <div><small>Utilidad op.</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600, color: e.utilidad_operativa < 0 ? 'var(--peligro)' : undefined }}>{lempiras(e.utilidad_operativa)}</div></div>
                </div>
                {e.serie.length > 1 && <Columnas datos={e.serie} etiqueta={(x) => x.fecha.slice(8)} valor={(x) => x.total} formato={lempiras} />}
                {e.sucursales.length > 1 && <BarrasH datos={e.sucursales} etiqueta={(s) => s.sucursal} valor={(s) => s.total} formato={lempiras} />}
                {e.venta_sin_costo > 0 && <small style={{ color: 'var(--aviso)' }}>⚠ {lempiras(e.venta_sin_costo)} vendidos sin receta: costo no capturado.</small>}
              </section>
            ))}
          </div>
        </>
      )}</Estado>

      <h2 style={{ marginTop: 8 }}>Alertas {nAlertas > 0 && <span className="chip mal">{nAlertas}</span>}</h2>
      <Estado d={alertas}>{(a) => nAlertas === 0 ? <div className="aviso-caja ok">Todo en orden: sin CAI por vencer, sin stock negativo, sin perecederos críticos.</div> : (
        <div className="rejilla cols-2">
          {a.cai.length > 0 && <div className="tarjeta"><h3>Facturación (CAI)</h3>{a.cai.map((x, i) => <div key={i} className="aviso-caja mal" style={{ marginTop: 6 }}>{x.empresa} · {x.sucursal}: vence {x.vence}, quedan {x.restantes} facturas</div>)}</div>}
          {a.stock_negativo.length > 0 && <div className="tarjeta"><h3>Stock negativo</h3>{a.stock_negativo.map((x, i) => <div key={i} className="aviso-caja" style={{ marginTop: 6 }}>{x.empresa} · {x.sucursal}: {x.insumo} ({x.cantidad})</div>)}</div>}
          {a.por_vencer.length > 0 && <div className="tarjeta"><h3>Por vencer (48 h)</h3>{a.por_vencer.map((x, i) => <div key={i} className="aviso-caja" style={{ marginTop: 6 }}>{x.empresa} · {x.sucursal}: {x.insumo} vence {x.vence}</div>)}</div>}
          {a.turnos_olvidados.length > 0 && <div className="tarjeta"><h3>Turnos de caja sin cerrar</h3>{a.turnos_olvidados.map((x, i) => <div key={i} className="aviso-caja mal" style={{ marginTop: 6 }}>{x.empresa} · {x.sucursal}: {x.cajero}</div>)}</div>}
        </div>
      )}</Estado>
    </div>
  );
}
