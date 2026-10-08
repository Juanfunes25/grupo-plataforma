import { lazy } from 'react';
import { useSesion } from '../sesion.jsx';

// «Cotizaciones» es una sola ruta, pero cada tipo de empresa tiene la suya: eventos (Italo), proyectos de piedra (EcoStone) o proyectos DISERCO.
const Eventos = lazy(() => import('./Cotizaciones.jsx'));
const Eco = lazy(() => import('./CotizacionesEco.jsx'));
const Dis = lazy(() => import('./CotizacionesDis.jsx'));

export default function CotizacionesRuta() {
  const { modulos } = useSesion();
  const ids = new Set(modulos.map((m) => m.id));
  if (ids.has('cot_eco')) return <Eco />;
  if (ids.has('cot_dis')) return <Dis />;
  return <Eventos />;
}
