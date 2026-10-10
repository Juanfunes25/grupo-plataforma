// Subir varios documentos de golpe. El sistema adivina tipo, título, fecha y (en personal) la persona por el nombre del archivo;
// tú revisas y confirmas. modo = 'empleado' (documentos de personas) o 'empresa' (documentos de la empresa).
import { useState } from 'react';
import { get } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { problemaConArchivo, subirNuevo } from '../documentos/cliente.js';
import { adivinarTipo, emparejarArchivo, fechaDeArchivo, leerCsv, metaDeIndice, numeroDeArchivo, tituloDeArchivo } from './emparejar.js';

export default function DocsLote({ modo = 'empresa', empresa: empresaProp, onCerrar, onListo }) {
  const { empresa: empresaSesion } = useSesion();
  const empresa = empresaProp ?? empresaSesion;   // en la Dirección del grupo se elige la empresa a la que van los documentos
  const op = empresaProp ? { empresa: empresaProp } : undefined;
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const esEmp = modo === 'empleado';
  const personal = useDatos(() => (esEmp ? get('/rrhh/personal', op) : Promise.resolve([])), [empresa]);
  const tiposD = useDatos(() => get('/documentos/tipos', op), [empresa]);
  const empleados = personal.datos ?? [];   // también los dados de baja: sus contratos y terminaciones se guardan en su perfil
  const tipos = (tiposD.datos?.tipos ?? []).filter((t) => t.activo && !!t.de_empleado === esEmp);
  const [filas, setFilas] = useState([]);

  // Si entre los archivos viene el índice (00_INDICE.csv), de ahí salen la descripción, las fechas y el vencimiento de cada uno.
  const elegir = async (lista) => {
    const todos = [...lista];
    const indice = todos.find((a) => /indice.*\.csv$/i.test(a.name));
    const meta = indice ? metaDeIndice(leerCsv(await indice.text())) : new Map();
    setFilas(todos.filter((a) => a !== indice).map((archivo) => {
      const m = meta.get(archivo.name.toLowerCase()) ?? {};
      const emp = esEmp ? emparejarArchivo(archivo.name, empleados) : '';
      const tipo = adivinarTipo(archivo.name, !!emp);
      return { archivo, empleado_id: emp, tipo: tipos.some((t) => t.codigo === tipo) ? tipo : '', titulo: tituloDeArchivo(archivo.name), fecha_emision: m.fecha_emision || fechaDeArchivo(archivo.name),
        fecha_vencimiento: m.fecha_vencimiento || '', numero: numeroDeArchivo(archivo.name), descripcion: m.descripcion || '', entidad_emisora: '' };
    }));
  };
  const cambiar = (i, c) => setFilas((fs) => fs.map((x, k) => (k === i ? { ...x, ...c } : x)));
  const listo = (f) => f.tipo && (!esEmp || f.empleado_id) && !problemaConArchivo(f.archivo);
  const listos = filas.filter(listo);
  const subir = () => ejecutar(async () => {
    let n = 0;
    for (const f of listos) {
      await subirNuevo(f.archivo, { tipo: f.tipo, titulo: f.titulo || undefined, fecha_emision: f.fecha_emision || undefined, numero: f.numero || undefined, fecha_vencimiento: f.fecha_vencimiento || undefined, descripcion: f.descripcion || undefined, ...(esEmp ? { empleado_id: f.empleado_id } : {}) }, empresa);
      n++;
    }
    avisar(`${n} documento${n === 1 ? '' : 's'} guardado${n === 1 ? '' : 's'}`);
    onListo?.(); onCerrar();
  });
  return (
    <Modal titulo={esEmp ? 'Subir documentos de personal en lote' : 'Subir varios documentos'} onCerrar={onCerrar} tam="ancho"
      pie={<><button className="btn" onClick={onCerrar}>Cancelar</button><button className="btn primario" disabled={ocupado || listos.length === 0} onClick={subir}>Subir {listos.length || ''}</button></>}>
      <small>Elige los archivos (PDF o foto); si tienes el índice <b>00_INDICE.csv</b>, elígelo junto con ellos y de ahí se toman la descripción, las fechas y el vencimiento. Se adivina el tipo{esEmp ? ', la persona' : ''}, el título y la fecha por el nombre del archivo; revisa cada uno antes de subir.</small>
      <input type="file" multiple accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.csv" onChange={(e) => elegir(e.target.files)} />
      {filas.map((f, i) => {
        const prob = problemaConArchivo(f.archivo);
        return (
          <div className="tarjeta" key={i} style={{ display: 'grid', gap: 6 }}>
            <b style={{ wordBreak: 'break-all' }}>{f.archivo.name}{prob && <small className="mal"> · {prob}</small>}</b>
            <div className="rejilla cols-2">
              <select value={f.tipo} onChange={(e) => cambiar(i, { tipo: e.target.value })}><option value="">Tipo de documento…</option>{tipos.map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select>
              {esEmp && (
                <select value={f.empleado_id} onChange={(e) => cambiar(i, { empleado_id: e.target.value })}>
                  <option value="">¿De quién es? Elige…</option>
                  {empleados.map((e) => <option key={e.id} value={e.id}>{`${e.nombres} ${e.apellidos ?? ''}`.trim()}{e.sucursal ? ` · ${e.sucursal}` : ''}</option>)}
                </select>
              )}
              <input value={f.titulo} onChange={(e) => cambiar(i, { titulo: e.target.value })} placeholder="Título" />
              <input value={f.numero} onChange={(e) => cambiar(i, { numero: e.target.value })} placeholder="Número o registro (opcional)" />
              <input type="date" value={f.fecha_emision} onChange={(e) => cambiar(i, { fecha_emision: e.target.value })} title="Fecha de emisión" />
              <input type="date" value={f.fecha_vencimiento} onChange={(e) => cambiar(i, { fecha_vencimiento: e.target.value })} title="Fecha de vencimiento (si tiene)" />
            </div>
          </div>
        );
      })}
    </Modal>
  );
}
