import { useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Tabs } from '../ui/kit.jsx';
import { ContenidoUsuarios } from './Usuarios.jsx';
import { ContenidoEmpresa, ContenidoSucursales } from './Sucursales.jsx';
import { ContenidoCai } from './Cai.jsx';
import { ContenidoBitacora } from './Bitacora.jsx';

// Administración reúne en pestañas lo mismo que tienen por separado Usuarios, Sucursales, CAI / Emisión y Bitácora
// (cada pantalla exporta su contenido; aquí no se repite lógica).
export default function Admin({ inicial }) {
  const { puede } = useSesion();
  const tabs = [
    ...(puede('admin:usuarios') ? [['usuarios', 'Usuarios y accesos']] : []),
    ...(puede('admin:empresa') ? [['sucursales', 'Sucursales'], ['empresa', 'Datos de la empresa']] : []),
    ...(puede('pos:fiscal') ? [['fiscal', 'Facturación (CAI)']] : []),
    ...(puede('auditoria:ver') ? [['auditoria', 'Bitácora']] : []),
  ];
  const [tab, setTab] = useState(tabs.some((t) => t[0] === inicial) ? inicial : tabs[0]?.[0]);
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Administración</h1></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'usuarios' && <ContenidoUsuarios />}
      {tab === 'sucursales' && <ContenidoSucursales />}
      {tab === 'empresa' && <ContenidoEmpresa />}
      {tab === 'fiscal' && <ContenidoCai />}
      {tab === 'auditoria' && <ContenidoBitacora />}
    </div>
  );
}
