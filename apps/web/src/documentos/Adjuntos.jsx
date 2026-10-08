// ════════════════════════════════════════════════════════════════════════════
// Adjuntos — documentos de UN empleado (contrato, identidad…): lista, sube, ve y descarga.
//
// Uso (RRHH, ficha del empleado, pestaña «Documentos»):
//
//   import Adjuntos from '../documentos/Adjuntos.jsx';
//   <Adjuntos empleadoId={empleado.id} />
//
// Props:
//   empleadoId  (obligatoria) id de rrhh.empleados.
//   empresa     código de la empresa del empleado ('italo'…). Por defecto, la empresa activa.
//   tipos       códigos de tipo sugeridos. Por defecto ['contrato_empleado','identidad_empleado','certificado_otro'].
//   titulo      encabezado (por defecto «Documentos del empleado»).
//   soloLectura fuerza el modo solo ver/descargar (sin ella, se sube si el usuario tiene 'doc:editar').
//   onCambio    se llama después de subir, reemplazar o borrar.
//
// Los documentos de empleados nacen «restringidos»: solo el dueño y el administrador los ven y descargan;
// cualquier descarga queda en la bitácora. Al subir un archivo nuevo del mismo documento («Nueva versión»)
// el anterior queda en el historial.
// ════════════════════════════════════════════════════════════════════════════
import { useRef, useState } from 'react';
import { api, get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { ESTADO_INFO, descargar, esVisible, fechaCorta, problemaConArchivo, subirNuevo, subirVersion, tamanoLegible, textoVence } from './cliente.js';
import { MotivoModal, Versiones } from './piezas.jsx';
import Vista from './Vista.jsx';
import ZonaArchivos from './ZonaArchivos.jsx';
import { ACCEPT_DOC } from '@grupo/shared';

const SUGERIDOS = ['contrato_empleado', 'identidad_empleado', 'certificado_otro'];

export default function Adjuntos({ empleadoId, empresa, tipos = SUGERIDOS, titulo = 'Documentos del empleado', soloLectura = false, onCambio }) {
  const { puede, contexto } = useSesion();
  const avisar = useAviso();
  const [ejecutar, ocupado] = useAccion();
  const editar = !soloLectura && puede('doc:editar');
  const privilegiado = ['dueno', 'admin'].includes(contexto?.rol);
  const lista = useDatos(() => get(`/documentos${qs({ empleado_id: empleadoId, estado: 'activos', limite: 100 })}`, { empresa }), [empleadoId, empresa]);
  const catalogo = useDatos(() => get('/documentos/tipos', { empresa }), [empresa]);
  const [tipo, setTipo] = useState(tipos[0]);
  const [tit, setTit] = useState('');
  const [vence, setVence] = useState('');
  const [ver, setVer] = useState(null), [versiones, setVersiones] = useState(null), [borrar, setBorrar] = useState(null);
  const nuevaVersion = useRef(null);
  const [paraVersion, setParaVersion] = useState(null);

  const tiposDisp = (catalogo.datos?.tipos ?? []).filter((t) => t.activo && tipos.includes(t.codigo));
  const info = tiposDisp.find((t) => t.codigo === tipo);
  const cambio = () => { lista.recargar(); onCambio?.(); };

  const subir = (archivos) => ejecutar(async () => {
    await subirNuevo(archivos[0], { tipo, titulo: tit.trim() || undefined, empleado_id: empleadoId, fecha_vencimiento: vence || undefined }, empresa);
    setTit(''); setVence(''); cambio();
  }, 'Documento guardado');

  const reemplazar = (e) => {
    const f = e.target.files?.[0]; e.target.value = '';
    const p = problemaConArchivo(f);
    if (p) return avisar(p, 'mal');
    ejecutar(async () => { await subirVersion(paraVersion.id, f, {}, empresa); cambio(); }, 'Versión nueva guardada');
  };

  return (
    <section className="tarjeta pad0" aria-label={titulo}>
      <div className="fila espacio" style={{ padding: '14px 14px 8px' }}><h3>{titulo}</h3>{privilegiado ? <span className="chip aviso">Confidencial</span> : <small className="tenue">Los contratos son confidenciales</small>}</div>
      <Estado d={lista}>{({ filas }) => (
        <>
          {filas.length === 0 && <div className="vacio" style={{ padding: 22 }}>{privilegiado || !editar ? 'Aún no hay documentos de este empleado.' : 'No hay documentos visibles. Los contratos solo los ven el dueño y el administrador.'}</div>}
          {filas.map((d) => (
            <div className="doc-fila" key={d.id}>
              <div>
                <b>{d.titulo}</b> <span className="chip">{d.tipo_nombre}</span> {d.version_actual > 1 && <span className="chip">v{d.version_actual}</span>}
                {d.fecha_vencimiento && <span className={`chip ${ESTADO_INFO[d.estado].clase}`} style={{ marginLeft: 6 }}>{textoVence(d)}</span>}
                <div><small className="tenue">{d.nombre_archivo ? `${d.nombre_archivo} · ${tamanoLegible(d.tamano)} · ` : 'Sin archivo · '}{fechaCorta(String(d.version_fecha ?? d.created_at).slice(0, 10))}</small></div>
              </div>
              <div className="acciones">
                {d.version_actual > 0 && esVisible(d.mime) && <button className="btn chico" onClick={() => setVer(d)}>Ver</button>}
                {d.version_actual > 0 && <button className="btn chico" onClick={() => ejecutar(() => descargar(d.id, d.nombre_archivo, { empresa }))}>Descargar</button>}
                {d.version_actual > 1 && <button className="btn chico fantasma" onClick={() => setVersiones(d)}>Versiones</button>}
                {editar && <button className="btn chico fantasma" disabled={ocupado} onClick={() => { setParaVersion(d); setTimeout(() => nuevaVersion.current?.click(), 0); }}>{d.version_actual ? 'Nueva versión' : 'Subir archivo'}</button>}
                {editar && <button className="btn chico fantasma" onClick={() => setBorrar(d)}>Borrar</button>}
              </div>
            </div>
          ))}
        </>
      )}</Estado>
      {editar && (
        <div style={{ padding: 14, display: 'grid', gap: 10, borderTop: '1px solid var(--borde)' }}>
          <div className="rejilla cols-3" style={{ gap: 10 }}>
            <Campo etiqueta="Tipo"><select value={tipo} onChange={(e) => setTipo(e.target.value)}>{(tiposDisp.length ? tiposDisp : tipos.map((c) => ({ codigo: c, nombre: c }))).map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select></Campo>
            <Campo etiqueta="Título (opcional)"><input value={tit} onChange={(e) => setTit(e.target.value)} placeholder="Si lo dejas vacío usa el nombre del archivo" maxLength={200} /></Campo>
            {(info?.requiere_vencimiento ?? true) && <Campo etiqueta="Vence (opcional)"><input type="date" value={vence} onChange={(e) => setVence(e.target.value)} /></Campo>}
          </div>
          <ZonaArchivos ocupado={ocupado} onArchivos={subir} onError={(m) => avisar(m, 'mal')} texto={`Arrastra aquí ${info ? `el ${info.nombre.toLowerCase()}` : 'el documento'}`} />
        </div>
      )}
      <input ref={nuevaVersion} type="file" hidden accept={ACCEPT_DOC} onChange={reemplazar} />
      {ver && <Vista doc={ver} empresa={empresa} onCerrar={() => setVer(null)} />}
      {versiones && <Versiones doc={versiones} empresa={empresa} onCerrar={() => setVersiones(null)} />}
      {borrar && <MotivoModal titulo={`Borrar «${borrar.titulo}»`} peligro boton="Borrar documento" aviso="Se eliminan el documento y todas sus versiones. No se puede deshacer."
        onConfirmar={async (motivo) => { await api(`/documentos/${borrar.id}`, { metodo: 'DELETE', cuerpo: { motivo }, empresa }); cambio(); }} onCerrar={() => setBorrar(null)} />}
    </section>
  );
}
