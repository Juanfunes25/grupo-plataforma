import { useState } from 'react';
import { EncabezadoPagina, Tabs, useAviso } from '../ui/kit.jsx';
import { useSesion } from '../sesion.jsx';
import { BotonExcel } from '../fin/comun.jsx';
import Ordenes from './Ordenes.jsx';
import Proveedores from './Proveedores.jsx';
import Precios from './Precios.jsx';
import Reorden from './Reorden.jsx';
import OrdenEditor from './OrdenEditor.jsx';

const TABS = [['ordenes', 'Órdenes'], ['reorden', 'Reorden'], ['precios', 'Precios'], ['proveedores', 'Proveedores']];
const EXCEL = { ordenes: ['ordenes', 'ordenes-de-compra.xlsx'], precios: ['precios', 'comparativo-de-precios.xlsx'], reorden: ['reorden', 'sugerencias-de-reorden.xlsx'] };

export default function Compras() {
  const { puede } = useSesion();
  const avisar = useAviso();
  const [tab, setTab] = useState('ordenes');
  const [editor, setEditor] = useState(false);
  const [version, setVersion] = useState(0);
  const [abrir, setAbrir] = useState(null);
  const x = EXCEL[tab];
  return (
    <div className="pagina">
      <EncabezadoPagina titulo="Compras" descripcion="Órdenes de compra a proveedores: lo que llega entra al inventario con su costo, y cada precio queda en el historial para comparar."
        acciones={<>{x && tab !== 'reorden' && <BotonExcel ruta={`/compras/exportar?reporte=${x[0]}`} nombre={x[1]} />}{puede('compras:editar') && <button className="btn primario" onClick={() => setEditor(true)}>+ Nueva orden</button>}</>} />
      <Tabs tabs={TABS} valor={tab} onCambio={setTab} />
      {tab === 'ordenes' && <Ordenes abrirId={abrir} onAbierto={() => setAbrir(null)} version={version} />}
      {tab === 'reorden' && <Reorden onOrdenes={(m) => { avisar(m); setVersion((v) => v + 1); setTab('ordenes'); }} />}
      {tab === 'precios' && <Precios />}
      {tab === 'proveedores' && <Proveedores />}
      {editor && <OrdenEditor onCerrar={() => setEditor(false)} onListo={(o, correo) => {
        setEditor(false); setTab('ordenes'); setVersion((v) => v + 1); setAbrir(o.id);
        if (correo) avisar(correo.ok ? 'Orden enviada por correo' : correo.pendiente ? 'Correo pendiente: Gmail aún no está configurado en el servidor' : (correo.error ?? 'No se pudo enviar el correo'), correo.ok ? 'ok' : 'mal');
      }} />}
    </div>
  );
}
