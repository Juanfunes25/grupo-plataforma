import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import { Tabs } from '../ui/kit.jsx';
import Captura, { TandasDeHoy } from '../prod/Captura.jsx';
import Consumo from '../prod/Consumo.jsx';
import Plan from '../prod/Plan.jsx';
import Rango from '../prod/Rango.jsx';
import Trazabilidad from '../prod/Trazabilidad.jsx';
import '../prod/prod.css';

/**
 * Producción de gelato (Los Andes): cargar las tandas del día con el dedo, ver/corregir lo de hoy, y — según el permiso —
 * materia prima por tanda, plan de producción, reporte por período y trazabilidad. Quien produce NO ve recetas ni costos.
 */
export default function ProduccionGelato() {
  const { puede } = useSesion();
  const [params] = useSearchParams();
  const tabs = [
    ...(puede('rep:producir') ? [['cargar', 'Cargar'], ['hoy', 'Hoy']] : []),
    ...(puede('rep:costeo') || puede('rep:inventario') ? [['consumo', 'Materia prima']] : []),
    ...(puede('rep:costeo') || puede('rep:despachar') ? [['plan', 'Plan de producción']] : []),
    ...(puede('rep:costeo') ? [['reporte', 'Reporte']] : []),
    ...(puede('rep:costeo') || puede('rep:inventario') ? [['trazabilidad', 'Trazabilidad']] : []),
  ];
  const pedido = params.get('tab');
  const [tab, setTab] = useState(tabs.some(([id]) => id === pedido) ? pedido : tabs[0]?.[0]);
  const [n, setN] = useState(0);
  if (!tabs.length) return <div className="pagina"><div className="aviso-caja mal">No tienes permiso para esta pantalla.</div></div>;
  return (
    <div className="pagina pg">
      <div className="encabezado-pagina"><h1>Producción de gelato</h1></div>
      <Tabs tabs={tabs} valor={tab} onCambio={(t) => { setTab(t); setN((x) => x + 1); }} />
      {tab === 'cargar' && <Captura alRegistrar={() => { setTab('hoy'); setN((x) => x + 1); }} />}
      {tab === 'hoy' && <TandasDeHoy recargarClave={n} />}
      {tab === 'consumo' && <Consumo />}
      {tab === 'plan' && <Plan />}
      {tab === 'reporte' && <Rango />}
      {tab === 'trazabilidad' && <Trazabilidad />}
    </div>
  );
}
