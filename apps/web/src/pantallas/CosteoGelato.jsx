import { useState } from 'react';
import { Tabs } from '../ui/kit.jsx';
import CostPanorama from '../prod/CostPanorama.jsx';
import CostInsumos from '../prod/CostInsumos.jsx';
import CostRecetas from '../prod/CostRecetas.jsx';
import CostTipoCambio from '../prod/CostTipoCambio.jsx';
import '../prod/prod.css';

/** Recetas y costeo de gelato: cuánto cuesta realmente producir cada sabor con los precios reales (dolarizados y cambiantes). */
export default function CosteoGelato() {
  const [tab, setTab] = useState('panorama');
  return (
    <div className="pagina pg">
      <div className="encabezado-pagina"><h1>Recetas y costeo</h1></div>
      <Tabs tabs={[['panorama', 'Panorama'], ['insumos', 'Insumos y precios'], ['recetas', 'Recetas'], ['cambio', 'Tipo de cambio']]} valor={tab} onCambio={setTab} />
      {tab === 'panorama' && <CostPanorama />}
      {tab === 'insumos' && <CostInsumos />}
      {tab === 'recetas' && <CostRecetas />}
      {tab === 'cambio' && <CostTipoCambio />}
    </div>
  );
}
