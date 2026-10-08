import { useState } from 'react';
import { get, qs } from '../api.js';
import { Estado, useDatos } from '../ui/kit.jsx';
import { InformeEmpresa, ListaHallazgos } from '../ui/GerenteDigital.jsx';
import { useSesion } from '../sesion.jsx';

export default function GerenteEmpresa() {
  const { contexto } = useSesion();
  const [dias, setDias] = useState(28);
  const d = useDatos(() => get(`/gerente${qs({ dias })}`), [dias]);
  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <div><h1>Gerente digital</h1><small>Lee los números de {contexto.empresa.nombre} y te dice qué importa, qué cuesta dinero y qué hacer.</small></div>
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Periodo"><option value={14}>Últimos 14 días</option><option value={28}>Últimos 28 días</option><option value={60}>Últimos 60 días</option></select>
      </div>
      <Estado d={d}>{(r) => (
        <>
          <InformeEmpresa r={r} />
          <h2>Hallazgos ({r.hallazgos.length})</h2>
          <ListaHallazgos hallazgos={r.hallazgos} />
          <small className="tenue">El análisis compara los últimos {r.periodo.dias} días contra los {r.periodo.dias} anteriores y usa solo datos registrados en el sistema: si falta capturar recetas, compras o gastos, el gerente digital lo avisa porque limita la precisión.</small>
        </>
      )}</Estado>
    </div>
  );
}
