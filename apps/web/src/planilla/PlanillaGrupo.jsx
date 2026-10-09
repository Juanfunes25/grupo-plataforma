// Planilla en Dirección del Grupo → Recursos humanos: las cuatro empresas, con filtro por empresa.
import { useState } from 'react';
import { fechaHN, lempiras } from '@grupo/shared';
import { get, qs } from '../api.js';
import { Estado, useDatos } from '../ui/kit.jsx';
import { PlanillaPanel } from './Planilla.jsx';
import './planilla.css';

export default function PlanillaGrupo() {
  const hoy = fechaHN();
  const [empresa, setEmpresa] = useState(null);
  const d = useDatos(() => get(`/planilla/grupo${qs({ anio: hoy.slice(0, 4), mes: Number(hoy.slice(5, 7)) })}`), []);
  return (
    <Estado d={d}>{(g) => (
      <div style={{ display: 'grid', gap: 12 }}>
        <div className="pl-chips" role="group" aria-label="Empresa">
          <button className={`pl-chip ${!empresa ? 'activa' : ''}`} style={{ '--c': '#555' }} onClick={() => setEmpresa(null)}>Todas</button>
          {g.empresas.map((e) => <button key={e.codigo} className={`pl-chip ${empresa === e.codigo ? 'activa' : ''}`} style={{ '--c': e.color || '#555' }} onClick={() => setEmpresa(e.codigo)}>{e.nombre}</button>)}
        </div>
        {!empresa ? (
          <div className="iu-tarjetas">{g.empresas.map((e) => (
            <div key={e.codigo} className="tarjeta iu-grupo-emp" style={{ '--c': e.color }}>
              <h3>{e.nombre}</h3><small>Este mes</small>
              <table><tbody>{e.planillas.map((p) => <tr key={p.id}><td>{p.etiqueta}<br /><small>{p.empleados} empleados · {p.estado}{p.por_confirmar ? ' · sin confirmar' : ''}</small></td><td className="der num">{lempiras(p.total)}</td></tr>)}
                {e.planillas.length === 0 && <tr><td><small>Sin planillas este mes</small></td><td /></tr>}
                <tr className="pl-tot"><td><b>Total</b></td><td className="der num"><b>{lempiras(e.total)}</b></td></tr></tbody></table>
              <button className="btn" onClick={() => setEmpresa(e.codigo)}>Abrir planilla</button>
            </div>))}</div>
        ) : <PlanillaPanel empresa={empresa} />}
        {!empresa && <small>Total de planillas del mes en el grupo: <b>{lempiras(g.total)}</b></small>}
      </div>
    )}</Estado>
  );
}
