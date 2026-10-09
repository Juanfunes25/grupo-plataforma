import { useState } from 'react';
import { fechaHN, lempiras, sumarDias } from '@grupo/shared';
import { descargarArchivo } from '../diserco/archivos.js';
import { useAviso } from '../ui/kit.jsx';
import Icono from '../ui/Icono.jsx';
import './fin.css';

export { lempiras };
export const fmt = (n) => lempiras(n);
export const pct = (n) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${String(n).replace('.', ',')} %`);
export const neg = (n) => (n < 0 ? 'fin-neg' : undefined);

/** Descarga un reporte de Excel del API (necesita el token, por eso no es un enlace directo). */
export function BotonExcel({ ruta, nombre, etiqueta = 'Excel' }) {
  const avisar = useAviso();
  const [bajando, setBajando] = useState(false);
  return (
    <button type="button" className="btn" disabled={bajando} onClick={async () => {
      setBajando(true);
      try { await descargarArchivo(ruta, nombre); } catch (e) { avisar(e.message, 'mal'); } finally { setBajando(false); }
    }}><Icono n="descargar" tam={16} />{bajando ? 'Preparando…' : etiqueta}</button>
  );
}

export const periodos = () => {
  const h = fechaHN();
  const mesPasado = (() => { const ini = `${h.slice(0, 8)}01`; const fin = sumarDias(ini, -1); return [`${fin.slice(0, 8)}01`, fin]; })();
  return { 'Este mes': [`${h.slice(0, 8)}01`, h], 'Mes pasado': mesPasado, 'Últimos 30 días': [sumarDias(h, -29), h], 'Últimos 90 días': [sumarDias(h, -89), h], Hoy: [h, h] };
};

/** Selector de periodo con fechas libres. */
export function SelectorPeriodo({ desde, hasta, onCambio }) {
  const lista = periodos();
  const actual = Object.entries(lista).find(([, [d, h]]) => d === desde && h === hasta)?.[0] ?? 'personalizado';
  return (
    <div className="fin-barra">
      <label>Periodo
        <select value={actual} onChange={(e) => { const p = lista[e.target.value]; if (p) onCambio(p[0], p[1]); }}>
          {actual === 'personalizado' && <option value="personalizado">Personalizado</option>}
          {Object.keys(lista).map((k) => <option key={k}>{k}</option>)}
        </select>
      </label>
      <label>Desde<input type="date" value={desde} max={hasta} onChange={(e) => e.target.value && onCambio(e.target.value, hasta)} /></label>
      <label>Hasta<input type="date" value={hasta} min={desde} onChange={(e) => e.target.value && onCambio(desde, e.target.value)} /></label>
    </div>
  );
}

/** Barra apilada con leyenda: antigüedad de saldos. segmentos = [{ etq, valor, clase }] (clase fin-c1…fin-c4). */
export function BarraApilada({ segmentos, formato = fmt, total }) {
  const suma = total ?? segmentos.reduce((s, x) => s + x.valor, 0);
  return (
    <div>
      <div className="fin-apilada" role="img" aria-label={segmentos.map((s) => `${s.etq}: ${formato(s.valor)}`).join('; ')}>
        {suma > 0 ? segmentos.filter((s) => s.valor > 0).map((s) => <i key={s.etq} className={s.clase} style={{ flexGrow: s.valor }} title={`${s.etq}: ${formato(s.valor)}`} />) : <i style={{ flexGrow: 1 }} />}
      </div>
      <div className="fin-leyenda">{segmentos.map((s) => <span key={s.etq}><i className={`fin-punto ${s.clase}`} />{s.etq} <b>{formato(s.valor)}</b></span>)}</div>
    </div>
  );
}

const ETQ_PER = { dia: (p) => p.slice(8) + '/' + p.slice(5, 7), semana: (p) => p.slice(8) + '/' + p.slice(5, 7), mes: (p) => ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][Number(p.slice(5, 7)) - 1] + ' ' + p.slice(2, 4) };
const corto = (n) => (Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** Entradas contra salidas por periodo. Solo dos colores: teal entradas, terracota salidas. */
export function GraficaFlujo({ serie, agrupar }) {
  const max = Math.max(1, ...serie.flatMap((s) => [s.entradas, s.salidas]));
  const alto = (v) => Math.max(2, Math.round((v / max) * 140));
  return (
    <div>
      <div className="fin-flujo" role="img" aria-label={serie.map((s) => `${s.periodo}: entradas ${fmt(s.entradas)}, salidas ${fmt(s.salidas)}`).join('; ')}>
        {serie.map((s) => (
          <div className="fin-flujo-grupo" key={s.periodo} title={`${s.periodo}\nEntradas ${fmt(s.entradas)}\nSalidas ${fmt(s.salidas)}\nNeto ${fmt(s.neto)}`}>
            <b className={neg(s.neto)}>{corto(s.neto)}</b>
            <div className="fin-flujo-barras"><i className="e" style={{ height: alto(s.entradas) }} /><i className="s" style={{ height: alto(s.salidas) }} /></div>
            <small>{(ETQ_PER[agrupar] ?? ETQ_PER.dia)(s.periodo)}</small>
          </div>
        ))}
      </div>
      <div className="fin-leyenda"><span><i className="fin-punto" style={{ background: '#2e9e8f' }} />Entradas</span><span><i className="fin-punto" style={{ background: '#c5603c' }} />Salidas</span><span className="fin-nota">El número de arriba es el flujo neto del periodo.</span></div>
    </div>
  );
}

export const ESTADO_PRES = { ok: ['ok', 'En orden'], riesgo: ['aviso', 'En riesgo'], excedido: ['mal', 'Excedido'], bajo: ['aviso', 'Por debajo'], sin_presupuesto: ['', 'Sin presupuesto'] };
export const Semaforo = ({ estado }) => { const [c, t] = ESTADO_PRES[estado] ?? ['', estado]; return <span className={`chip ${c}`}>{t}</span>; };
