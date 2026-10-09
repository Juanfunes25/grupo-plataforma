import { useState } from 'react';
import { fechaHN } from '@grupo/shared';
import { EncabezadoPagina, Tabs } from '../ui/kit.jsx';
import { useSesion } from '../sesion.jsx';
import { SelectorPeriodo } from '../fin/comun.jsx';
import Resultados from '../fin/Resultados.jsx';
import Flujo from '../fin/Flujo.jsx';
import { PorCobrar, PorPagar } from '../fin/Cartera.jsx';
import Presupuesto from '../fin/Presupuesto.jsx';
import EntreEmpresas from '../fin/EntreEmpresas.jsx';
import Gastos, { NuevoGasto } from '../fin/Gastos.jsx';

const TABS = [['resultados', 'Resultados'], ['flujo', 'Flujo de caja'], ['cobrar', 'Por cobrar'], ['pagar', 'Por pagar'], ['presupuesto', 'Presupuesto'], ['gastos', 'Gastos'], ['interco', 'Entre empresas']];
const CON_PERIODO = new Set(['resultados', 'flujo', 'gastos']);

export default function Finanzas() {
  const { puede } = useSesion();
  const hoy = fechaHN();
  const [tab, setTab] = useState('resultados');
  const [rango, setRango] = useState([`${hoy.slice(0, 8)}01`, hoy]);
  const [nuevo, setNuevo] = useState(false);
  const [version, setVersion] = useState(0);
  return (
    <div className="pagina">
      <EncabezadoPagina titulo="Finanzas" descripcion="Resultados por sucursal, flujo de caja, cuentas por cobrar y por pagar, presupuesto del mes y cuentas entre empresas."
        acciones={puede('fin:gastos') && <button className="btn primario" onClick={() => setNuevo(true)}>+ Gasto</button>} />
      <Tabs tabs={TABS} valor={tab} onCambio={setTab} />
      {CON_PERIODO.has(tab) && <SelectorPeriodo desde={rango[0]} hasta={rango[1]} onCambio={(d, h) => setRango([d, h])} />}
      <div key={version} style={{ display: 'contents' }}>
        {tab === 'resultados' && <Resultados desde={rango[0]} hasta={rango[1]} />}
        {tab === 'flujo' && <Flujo desde={rango[0]} hasta={rango[1]} />}
        {tab === 'cobrar' && <PorCobrar />}
        {tab === 'pagar' && <PorPagar />}
        {tab === 'presupuesto' && <Presupuesto />}
        {tab === 'gastos' && <Gastos desde={rango[0]} hasta={rango[1]} recargarTodo={() => setVersion((v) => v + 1)} />}
        {tab === 'interco' && <EntreEmpresas />}
      </div>
      {nuevo && <NuevoGasto onCerrar={() => setNuevo(false)} onListo={() => { setNuevo(false); setVersion((v) => v + 1); }} />}
    </div>
  );
}
