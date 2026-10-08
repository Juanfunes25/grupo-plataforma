import { useEffect, useState } from 'react';
import { get, post, put } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Modal, useAccion, useAviso } from '../ui/kit.jsx';
import { subirNuevo } from './cliente.js';
import ZonaArchivos from './ZonaArchivos.jsx';

const VACIO = { tipo: '', titulo: '', numero: '', entidad_emisora: '', fecha_emision: '', fecha_vencimiento: '', dias_aviso: '', sucursal_id: '', empleado_id: '', contraparte: '', monto: '', etiquetas: '', confidencialidad: '', descripcion: '' };

/** Alta (con o sin archivo) y edición de los datos de un documento. */
export default function Formulario({ doc, tipos, inicial, onCerrar, onGuardado }) {
  const { sucursales, puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const activos = tipos.filter((t) => t.activo || t.codigo === doc?.tipo);
  const [f, setF] = useState(() => (doc
    ? { ...VACIO, ...Object.fromEntries(Object.keys(VACIO).map((k) => [k, k === 'etiquetas' ? (doc.etiquetas ?? []).join(', ') : doc[k] ?? ''])) }
    : { ...VACIO, tipo: activos[0]?.codigo ?? '', ...inicial }));
  const [archivo, setArchivo] = useState(inicial?.archivo ?? null);
  const [empleados, setEmpleados] = useState([]);
  const t = tipos.find((x) => x.codigo === f.tipo);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  // Empleados de la empresa (solo si el usuario puede ver Personal y el tipo es de empleado)
  useEffect(() => {
    if (!(t?.de_empleado || f.empleado_id) || !puede('rrhh:ver')) return;
    get('/rrhh/empleados').then((l) => setEmpleados(l.filter((e) => e.estado !== 'baja' || e.id === f.empleado_id))).catch(() => {});
  }, [t?.de_empleado, f.empleado_id, puede]);

  const cambiarTipo = (e) => {
    const n = tipos.find((x) => x.codigo === e.target.value);
    setF((s) => ({ ...s, tipo: e.target.value, ...(doc ? {} : { dias_aviso: '', confidencialidad: n?.confidencial ? 'restringido' : s.confidencialidad === 'restringido' && !s.empleado_id ? '' : s.confidencialidad }) }));
  };

  const datos = () => ({
    tipo: f.tipo, titulo: f.titulo.trim() || (archivo ? archivo.name.replace(/\.[^.]+$/, '') : ''), descripcion: f.descripcion, numero: f.numero, entidad_emisora: f.entidad_emisora,
    contraparte: f.contraparte, fecha_emision: f.fecha_emision, fecha_vencimiento: f.fecha_vencimiento, sucursal_id: f.sucursal_id, empleado_id: f.empleado_id,
    ...(f.dias_aviso !== '' ? { dias_aviso: Number(f.dias_aviso) } : {}),
    monto: f.monto === '' ? null : Number(f.monto), etiquetas: f.etiquetas.split(',').map((x) => x.trim()).filter(Boolean),
    ...(f.confidencialidad ? { confidencialidad: f.confidencialidad } : {}),
  });

  const guardar = async () => {
    const d = datos();
    if (d.titulo.length < 2) return avisar('Escribe el título del documento', 'mal');
    const r = await ejecutar(async () => {
      if (doc) return put(`/documentos/${doc.id}`, d);
      if (archivo) {
        const { etiquetas, monto, ...resto } = d;
        const p = Object.fromEntries(Object.entries({ ...resto, monto: monto ?? undefined, etiquetas: etiquetas.join(',') }).filter(([, v]) => v !== '' && v != null && v !== undefined));
        return subirNuevo(archivo, p);
      }
      return post('/documentos', d);
    }, doc ? 'Cambios guardados' : 'Documento guardado');
    if (r) onGuardado(r);
  };

  return (
    <Modal titulo={doc ? 'Editar documento' : 'Nuevo documento'} onCerrar={onCerrar} tam="ancho"
      pie={<button className="btn primario" disabled={ocupado} onClick={guardar}>{doc ? 'Guardar cambios' : archivo ? 'Guardar y subir archivo' : 'Guardar sin archivo'}</button>}>
      {!doc && (archivo
        ? <div className="aviso-caja ok fila espacio"><span>Archivo: <b>{archivo.name}</b> ({(archivo.size / 1048576).toFixed(2)} MB)</span><button className="btn chico fantasma" onClick={() => setArchivo(null)}>Quitar</button></div>
        : <ZonaArchivos onArchivos={(a) => setArchivo(a[0])} onError={(m) => avisar(m, 'mal')} texto="Suelta aquí el archivo o tómale una foto" />)}
      <div className="rejilla cols-2">
        <Campo etiqueta="Tipo de documento"><select value={f.tipo} onChange={cambiarTipo}>{activos.map((x) => <option key={x.codigo} value={x.codigo}>{x.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Título"><input value={f.titulo} onChange={set('titulo')} maxLength={200} placeholder={archivo ? archivo.name : 'Ej.: Arrendamiento local 10 Calle'} /></Campo>
        <Campo etiqueta="Número o referencia"><input value={f.numero} onChange={set('numero')} maxLength={80} /></Campo>
        <Campo etiqueta="Entidad emisora"><input value={f.entidad_emisora} onChange={set('entidad_emisora')} maxLength={160} placeholder="ARSA, Alcaldía, aseguradora…" /></Campo>
        <Campo etiqueta="Fecha de emisión"><input type="date" value={f.fecha_emision} onChange={set('fecha_emision')} /></Campo>
        <Campo etiqueta={t?.requiere_vencimiento === false ? 'Fecha de vencimiento (si aplica)' : 'Fecha de vencimiento'}><input type="date" value={f.fecha_vencimiento} onChange={set('fecha_vencimiento')} /></Campo>
        <Campo etiqueta="Avisar con (días de anticipación)" ayuda={t ? `Por defecto ${t.dias_aviso} días` : undefined}><input type="number" min="0" max="730" inputMode="numeric" value={f.dias_aviso} onChange={set('dias_aviso')} placeholder={t ? String(t.dias_aviso) : '30'} /></Campo>
        <Campo etiqueta="Sucursal" ayuda="Déjalo vacío si es de toda la empresa">
          <select value={f.sucursal_id} onChange={set('sucursal_id')}><option value="">Toda la empresa</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Con quién (arrendador, proveedor…)"><input value={f.contraparte} onChange={set('contraparte')} maxLength={160} /></Campo>
        <Campo etiqueta="Monto o renta (L)"><input type="number" min="0" step="0.01" inputMode="decimal" value={f.monto} onChange={set('monto')} /></Campo>
        {(t?.de_empleado || f.empleado_id) && (
          <Campo etiqueta="Empleado" ayuda={puede('rrhh:ver') ? undefined : 'No tienes acceso a Personal'}>
            <select value={f.empleado_id} onChange={set('empleado_id')}><option value="">— Ninguno —</option>{empleados.map((e) => <option key={e.id} value={e.id}>{e.nombres} {e.apellidos}</option>)}</select></Campo>)}
        <Campo etiqueta="Confidencialidad">
          <select value={f.confidencialidad || (t?.confidencial || f.empleado_id ? 'restringido' : 'normal')} onChange={set('confidencialidad')}>
            <option value="normal">Normal (quien tenga acceso a Documentos)</option><option value="restringido">Restringido (solo dueño y administrador)</option></select></Campo>
      </div>
      <Campo etiqueta="Etiquetas" ayuda="Separadas por coma"><input value={f.etiquetas} onChange={set('etiquetas')} placeholder="local, renovación 2026" /></Campo>
      <Campo etiqueta="Descripción o notas"><textarea rows={3} value={f.descripcion} onChange={set('descripcion')} maxLength={2000} /></Campo>
    </Modal>
  );
}
