import { useState } from 'react';
import { post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Tabs, useAccion, useAviso } from '../ui/kit.jsx';
import PanelRrhh from '../rrhh/Directorio.jsx';
import Ficha, { camposPersona } from '../rrhh/Ficha.jsx';
import Form from '../rrhh/Form.jsx';
import DocsLote from '../rrhh/DocsLote.jsx';
import { Turno } from '../rrhh/Turno.jsx';
import { Asistencia, AusenciasLista, Horarios, VacacionesLista } from '../rrhh/Operacion.jsx';
import { TIPOS_CONTRATO, TIPOS_PAGO } from '../rrhh/util.js';

// Personal de la empresa activa: equipo (resumen, directorio, calendario, ficha), turno en tienda,
// horarios, asistencia y horas, vacaciones, ausencias. La misma ficha se ve en Dirección del grupo.
export default function Personal() {
  const { puede, empresa } = useSesion();
  const ver = puede('rrhh:ver'), editar = puede('rrhh:editar');
  const tabs = [
    ...(ver ? [['equipo', 'Equipo']] : []),
    ...(puede('rrhh:asistencia') || ver ? [['turno', 'Turno de hoy']] : []),
    ...(ver ? [['horarios', 'Horarios'], ['asistencia', 'Asistencia y horas'], ['vacaciones', 'Vacaciones'], ['ausencias', 'Ausencias y permisos']] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.[0] ?? 'turno');
  const [ficha, setFicha] = useState(null);
  const [nuevo, setNuevo] = useState(false);
  const [lote, setLote] = useState(false);
  const [recarga, setRecarga] = useState(0);
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Personal</h1>{puede('rrhh:asistencia') && <Marcar />}</div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'equipo' && <PanelRrhh recargaExterna={recarga} acciones={editar && <><button className="btn" onClick={() => setLote(true)}>Subir documentos en lote</button><button className="btn primario" onClick={() => setNuevo(true)}>+ Empleado</button></>} />}
      {tab === 'turno' && <Turno />}
      {tab === 'horarios' && <Horarios />}
      {tab === 'asistencia' && <Asistencia />}
      {tab === 'vacaciones' && <VacacionesLista onFicha={(id) => setFicha(id)} />}
      {tab === 'ausencias' && <AusenciasLista onFicha={(id) => setFicha(id)} />}
      {ficha && <Ficha id={ficha} empresa={empresa} onCerrar={() => setFicha(null)} onCambio={() => setRecarga((n) => n + 1)} />}
      {lote && <DocsLote modo="empleado" onCerrar={() => setLote(false)} onListo={() => setRecarga((n) => n + 1)} />}
      {nuevo && <NuevoEmpleado onCerrar={() => setNuevo(false)} onCreado={() => { setNuevo(false); setRecarga((n) => n + 1); }} />}
    </div>
  );
}

function Marcar() {
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  return <button className="btn oro" disabled={ocupado} onClick={async () => {
    const pos = await new Promise((ok) => (navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude }), () => ok({}), { timeout: 6000 }) : ok({})));
    const r = await ejecutar(() => post('/rrhh/marcar', pos));
    if (r && r !== true) avisar(`${r.nombre}: ${r.tipo === 'entrada' ? 'entrada' : 'salida'} registrada`);
  }}>Marcar entrada / salida</button>;
}

function NuevoEmpleado({ onCerrar, onCreado }) {
  const { sucursales, puede } = useSesion();
  const sens = puede('rrhh:sensible');
  const campos = [
    { seccion: 'Empleo' },
    { k: 'puesto', etiqueta: 'Cargo / puesto', req: true }, { k: 'departamento', etiqueta: 'Departamento' },
    { k: 'sucursal_id', etiqueta: 'Sucursal', tipo: 'select', opciones: sucursales.map((s) => [s.id, s.nombre]) },
    { k: 'fecha_ingreso', etiqueta: 'Fecha de ingreso', tipo: 'date' },
    { k: 'tipo_contrato', etiqueta: 'Tipo de contrato', tipo: 'select', opciones: Object.entries(TIPOS_CONTRATO) }, { k: 'fecha_fin_contrato', etiqueta: 'Vencimiento del contrato', tipo: 'date' },
    ...(sens ? [{ k: 'tipo_pago', etiqueta: 'Tipo de pago', tipo: 'select', opciones: Object.entries(TIPOS_PAGO) }, { k: 'salario_mensual', etiqueta: 'Salario mensual (L)', tipo: 'number' }] : []),
    ...camposPersona(sens),
  ];
  return (
    <Form titulo="Nuevo empleado" campos={campos} tam="ancho" inicial={{ tipo_contrato: 'indefinido', tipo_pago: 'mensual', sucursal_id: sucursales[0]?.id ?? '' }} onCerrar={onCerrar}
      extra={<small>Si la persona ya trabaja en otra empresa del grupo, escribe su identidad: se reutiliza su ficha (una persona, un solo registro) y se le agrega este contrato.</small>}
      onGuardar={async (d) => { const limpio = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== null && v !== '')); await post('/rrhh/empleados', limpio); onCreado(); return true; }} />
  );
}
