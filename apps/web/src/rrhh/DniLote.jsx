// Subir varios DNI de golpe: se eligen los archivos, el sistema los empareja con cada empleado por el nombre del archivo y tú confirmas.
import { useState } from 'react';
import { get } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { problemaConArchivo, subirNuevo } from '../documentos/cliente.js';
import { emparejarArchivo } from './emparejar.js';

export default function DniLote({ onCerrar, onListo }) {
  const { empresa } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const personal = useDatos(() => get('/rrhh/personal'), []);
  const empleados = (personal.datos ?? []).filter((e) => e.estado !== 'baja');
  const [filas, setFilas] = useState([]);   // [{ archivo, empleado_id }]

  const elegir = (lista) => {
    const nuevas = [...lista].map((archivo) => ({ archivo, empleado_id: emparejarArchivo(archivo.name, empleados) }));
    setFilas(nuevas);
  };
  const listos = filas.filter((f) => f.empleado_id && !problemaConArchivo(f.archivo));
  const subir = () => ejecutar(async () => {
    let n = 0;
    for (const f of listos) { await subirNuevo(f.archivo, { tipo: 'identidad_empleado', titulo: 'DNI', empleado_id: f.empleado_id }, empresa); n++; }
    avisar(`${n} documento${n === 1 ? '' : 's'} guardado${n === 1 ? '' : 's'} en el perfil`);
    onListo?.(); onCerrar();
  });
  return (
    <Modal titulo="Subir DNI en lote" onCerrar={onCerrar} tam="ancho"
      pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || listos.length === 0} onClick={subir}>Subir {listos.length || ''} DNI</button></>}>
      <small>Elige los archivos (PDF o foto). Se emparejan con cada empleado por el nombre del archivo, por ejemplo <b>Cabrera_Lopez_Astrid_Abigail.pdf</b>. Revisa que cada uno quede con la persona correcta.</small>
      <input type="file" multiple accept=".pdf,image/*" onChange={(e) => elegir(e.target.files)} />
      {filas.map((f, i) => {
        const prob = problemaConArchivo(f.archivo);
        return (
          <div className="fila espacio" key={i} style={{ alignItems: 'center', gap: 8 }}>
            <span style={{ flex: '1 1 40%', wordBreak: 'break-all' }}>{f.archivo.name}{prob && <small className="mal"> · {prob}</small>}</span>
            <select style={{ flex: '1 1 50%' }} value={f.empleado_id} onChange={(e) => setFilas(filas.map((x, k) => (k === i ? { ...x, empleado_id: e.target.value } : x)))}>
              <option value="">¿De quién es? Elige…</option>
              {empleados.map((e) => <option key={e.id} value={e.id}>{`${e.nombres} ${e.apellidos ?? ''}`.trim()}{e.sucursal ? ` · ${e.sucursal}` : ''}</option>)}
            </select>
          </div>
        );
      })}
    </Modal>
  );
}
