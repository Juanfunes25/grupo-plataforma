import { get, qs } from '../api.js';
import { Estado, Kpi, useDatos } from '../ui/kit.jsx';
import { fechaCorta, hoyIso, nf } from './util.js';

/** Qué producir cada día: lo que sale mañana hacia las tiendas menos lo que ya hay en cámara. Va justo a propósito. */
export default function Plan() {
  const d = useDatos(() => get(`/prod/plan${qs({ hoy: hoyIso() })}`), []);
  return (
    <Estado d={d}>{(p) => p.sabores.length === 0 ? (
      <div className="vacio">Todavía no hay suficiente historial de despachos para proyectar qué hace falta producir.</div>
    ) : (
      <>
        <div className="aviso-caja">Cuánto hacer <b>cada día</b>: lo que sale al día siguiente hacia las tiendas (la agenda de despacho, que ya descuenta lo que cada tienda tiene en vitrina) menos lo que ya hay en cámara. Va justo a propósito: el colchón ya está en el objetivo de cada tienda y repetirlo aquí sería producir de más todos los días. Cada día produce para la salida del siguiente; si un día queda muy pesado, adelanta parte al día anterior (el plan no conoce tu capacidad).</div>
        <div className="aviso-caja"><b>Incluye +{Math.round(p.factorLosAndes * 100)}% por {p.excluidas?.map((s) => s.nombre).join(', ') || 'Los Andes'}.</b> Se sirve directo de la fábrica sin registrar despacho, así que no aparece en los datos pero consume igual. Es un supuesto (la cuarta tienda mueve más o menos como una), no una medición.</div>
        <div className="rejilla" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))' }}>
          <Kpi acento etiqueta={`A producir (${p.horizonteDias} días)`} valor={`${nf(p.totalKgAProducir, 1)} kg`} />
          <Kpi etiqueta="Hay en cámara" valor={`${nf(p.totalKgEnCamara, 1)} kg`} />
        </div>
        <h3 style={{ margin: '8px 0 0' }}>Qué toca cada día</h3>
        {p.porDia.map((dia) => (
          <div key={dia.fecha} className={`tarjeta pg-dia ${dia.sabores.length ? '' : 'vacio-dia'}`}>
            <div className="pg-fila" style={{ border: 0, padding: 0 }}>
              <b>{dia.esHoy ? 'Hoy' : fechaCorta(dia.fecha)}{dia.esHoy && <span className="tenue"> · {fechaCorta(dia.fecha)}</span>}</b>
              {dia.sabores.length > 0 && <span className="chip">{dia.totalPanas} pana{dia.totalPanas === 1 ? '' : 's'} · {dia.totalKg} kg</span>}
            </div>
            {dia.sabores.length === 0 ? <small className="pg-sub">Nada que producir. Con lo que hay en cámara alcanza para la salida del {fechaCorta(dia.paraSalidaDel)}.</small> : (
              <>
                <small className="pg-sub">Para la salida del {fechaCorta(dia.paraSalidaDel)}.</small>
                {dia.sabores.map((s) => (
                  <div className="pg-fila" key={s.sabor_id}>
                    <div className="info"><b>{s.nombre}</b><span className="pg-sub">salen {s.kgParaSalida} kg{s.kgEnCamaraAntes > 0 ? ` · ya hay ${s.kgEnCamaraAntes} kg en cámara` : ''}{s.tiendas.length ? ` · para ${s.tiendas.join(', ')}` : ''}</span></div>
                    <div className="pg-num"><b style={{ fontSize: '1.1rem' }}>{s.panas} pana{s.panas === 1 ? '' : 's'}</b><span className="pg-sub">{s.kg} kg</span></div>
                  </div>))}
              </>)}
          </div>))}
        <h3 style={{ margin: '8px 0 0' }}>Total por sabor</h3>
        <div className="tarjeta">{p.sabores.map((s) => (
          <div className="pg-fila" key={s.sabor_id}>
            <div className="info"><b>{s.nombre}</b><span className="pg-sub">salen {s.kgSalidas} kg · en cámara {s.kgEnCamara} kg{s.primerDia ? ` · empieza el ${fechaCorta(s.primerDia)}` : ''}</span></div>
            {s.kgAProducir > 0 ? <div className="pg-num"><b>{s.panasAProducir} pana{s.panasAProducir === 1 ? '' : 's'}</b><span className="pg-sub">{s.kgAProducir} kg</span></div> : <span className="chip ok">alcanza</span>}
          </div>))}</div>
      </>
    )}</Estado>
  );
}
