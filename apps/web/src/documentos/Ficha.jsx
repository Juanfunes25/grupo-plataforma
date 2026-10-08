import { useRef, useState } from 'react';
import { ACCEPT_DOC, lempiras } from '@grupo/shared';
import { api, get, post } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Estado, Modal, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { ESTADO_INFO, descargar, esVisible, fechaCorta, problemaConArchivo, subirVersion, tamanoLegible, textoVence } from './cliente.js';
import { MotivoModal } from './piezas.jsx';
import Vista from './Vista.jsx';

const Dato = ({ k, children }) => children ? <div><small className="tenue">{k}</small><div>{children}</div></div> : null;

/** Ficha completa de un documento: datos, archivo actual con vista previa, historial de versiones y acciones. */
export default function Ficha({ id, empresa, soloLectura = false, onCerrar, onCambio, onEditar }) {
  const { puede } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const d = useDatos(() => get(`/documentos/${id}`, { empresa }), [id, empresa]);
  const editar = !soloLectura && puede('doc:editar');
  const [ver, setVer] = useState(null), [motivo, setMotivo] = useState(null);
  const entrada = useRef(null);
  const cambio = () => { d.recargar(); onCambio?.(); };

  const nuevaVersion = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    const p = problemaConArchivo(f);
    if (p) return avisar(p, 'mal');
    ejecutar(async () => { await subirVersion(id, f, {}, empresa); cambio(); }, 'Versión nueva guardada');
  };

  return (
    <Modal titulo="Documento" tam="ancho" onCerrar={onCerrar}>
      <Estado d={d}>{(x) => {
        const est = ESTADO_INFO[x.estado];
        return (
          <>
            <div className="fila espacio">
              <div><h2 style={{ margin: 0 }}>{x.titulo}</h2><small className="tenue">{x.tipo_nombre}{x.sucursal ? ` · ${x.sucursal}` : ''}</small></div>
              <div className="fila"><span className={`chip ${est.clase}`}>{est.texto}</span>{x.fecha_vencimiento && x.estado !== 'archivado' && <span className={`chip ${est.clase}`}>{textoVence(x)}</span>}{x.confidencialidad === 'restringido' && <span className="chip aviso">Restringido</span>}</div>
            </div>
            {x.estado === 'archivado' && <div className="aviso-caja">Archivado: {x.archivado_motivo}</div>}
            <div className="rejilla cols-3" style={{ gap: 12 }}>
              <Dato k="Número o referencia">{x.numero}</Dato>
              <Dato k="Entidad emisora">{x.entidad_emisora}</Dato>
              <Dato k="Emisión">{x.fecha_emision && fechaCorta(x.fecha_emision)}</Dato>
              <Dato k="Vencimiento">{x.fecha_vencimiento && fechaCorta(x.fecha_vencimiento)}</Dato>
              <Dato k="Aviso desde">{x.fecha_vencimiento && `${fechaCorta(x.fecha_aviso)} (${x.dias_aviso} días antes)`}</Dato>
              <Dato k="Con quién">{x.contraparte}</Dato>
              <Dato k="Monto o renta">{x.monto != null && lempiras(x.monto)}</Dato>
              <Dato k="Empleado">{x.empleado}</Dato>
              <Dato k="Etiquetas">{x.etiquetas?.length > 0 && x.etiquetas.map((e) => <span key={e} className="chip" style={{ marginRight: 4 }}>{e}</span>)}</Dato>
            </div>
            {x.descripcion && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{x.descripcion}</p>}

            <h3>Archivo</h3>
            {x.version_actual === 0 ? <div className="aviso-caja">Este documento todavía no tiene archivo.</div> : (
              <div className="fila espacio">
                <div><b>{x.nombre_archivo}</b><div><small className="tenue">{tamanoLegible(x.tamano)} · versión {x.version_actual}</small></div></div>
                <div className="fila">
                  {esVisible(x.mime) && <button className="btn primario" onClick={() => setVer({})}>Ver</button>}
                  <button className="btn" onClick={() => ejecutar(() => descargar(x.id, x.nombre_archivo, { empresa }))}>Descargar</button>
                </div>
              </div>)}
            {editar && x.estado !== 'archivado' && <div><button className="btn" disabled={ocupado} onClick={() => entrada.current?.click()}>{x.version_actual ? 'Subir versión nueva (renovación)' : 'Subir archivo'}</button><input ref={entrada} type="file" hidden accept={ACCEPT_DOC} onChange={nuevaVersion} /></div>}

            {x.versiones.length > 1 && (
              <>
                <h3>Historial de versiones</h3>
                <div className="tarjeta pad0">{x.versiones.map((v) => (
                  <div className="doc-fila" key={v.id}>
                    <div><b>v{v.numero}</b> {v.numero === x.version_actual && <span className="chip ok">actual</span>} <small>{v.nombre_archivo} · {tamanoLegible(v.tamano)} · {fechaCorta(String(v.created_at).slice(0, 10))}{v.subido_por_nombre ? ` · ${v.subido_por_nombre}` : ''}</small>{v.nota && <div><small className="tenue">{v.nota}</small></div>}</div>
                    <div className="acciones">{!v.purgada && <>{esVisible(v.mime) && <button className="btn chico" onClick={() => setVer({ v: v.numero })}>Ver</button>}<button className="btn chico" onClick={() => ejecutar(() => descargar(x.id, v.nombre_archivo, { version: v.numero, empresa }))}>Descargar</button></>}</div>
                  </div>))}</div>
              </>)}

            {editar && (
              <div className="fila" style={{ justifyContent: 'flex-end', borderTop: '1px solid var(--borde)', paddingTop: 12 }}>
                <button className="btn" onClick={() => onEditar(x)}>Editar datos</button>
                {x.archivado
                  ? <button className="btn" disabled={ocupado} onClick={() => ejecutar(() => post(`/documentos/${x.id}/restaurar`, {}, { empresa }).then(cambio), 'Documento restaurado')}>Restaurar</button>
                  : <button className="btn" onClick={() => setMotivo('archivar')}>Archivar</button>}
                <button className="btn peligro" onClick={() => setMotivo('borrar')}>Borrar</button>
              </div>)}
            {ver && <Vista doc={x} version={ver.v} empresa={empresa} onCerrar={() => setVer(null)} />}
            {motivo === 'archivar' && <MotivoModal titulo="Archivar documento" boton="Archivar" aviso="Deja de contar en vencimientos y faltantes; se puede restaurar." onCerrar={() => setMotivo(null)}
              onConfirmar={async (m) => { await post(`/documentos/${x.id}/archivar`, { motivo: m }, { empresa }); cambio(); avisar('Documento archivado'); }} />}
            {motivo === 'borrar' && <MotivoModal titulo="Borrar documento" boton="Borrar" peligro aviso="Se eliminan el documento y todos sus archivos. No se puede deshacer; queda constancia en la bitácora." onCerrar={() => setMotivo(null)}
              onConfirmar={async (m) => { await api(`/documentos/${x.id}`, { metodo: 'DELETE', cuerpo: { motivo: m }, empresa }); onCambio?.(); onCerrar(); avisar('Documento borrado'); }} />}
          </>
        );
      }}</Estado>
    </Modal>
  );
}
