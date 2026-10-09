import { useMemo, useState } from 'react';
import { GRUPOS_DOC } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { Campo, Estado, Kpi, Modal, Tabs, useAccion, useAviso, useDatos } from '../ui/kit.jsx';
import { ESTADO_INFO, fechaCorta, tamanoLegible, textoVence } from '../documentos/cliente.js';
import Formulario from '../documentos/Formulario.jsx';
import Ficha from '../documentos/Ficha.jsx';
import ZonaArchivos from '../documentos/ZonaArchivos.jsx';

/** Documentos de la empresa activa: contratos, permisos (ARSA, alcaldía…), registros sanitarios, pólizas… con vencimientos. */
import { qInicial } from '../busqueda/qInicial.js';

export default function Documentos() {
  const { puede, sucursales, contexto } = useSesion();
  const avisar = useAviso();
  const editar = puede('doc:editar');
  const [tab, setTab] = useState('docs');
  const resumen = useDatos(() => get('/documentos/resumen'), []);
  const tiposD = useDatos(() => get('/documentos/tipos'), []);
  const [filtros, setFiltros] = useState({ q: qInicial(), tipo: '', sucursal_id: '', estado: 'activos', vence_en: '' });
  const [vista, setVista] = useState('tipos');
  const [abierto, setAbierto] = useState(null);       // id de la ficha
  const [form, setForm] = useState(null);             // { doc? , inicial? }
  const [subiendo, setSubiendo] = useState(false);

  const tipos = tiposD.datos?.tipos ?? [];
  const lista = useDatos(() => get(`/documentos${qs({ ...filtros, limite: 300, orden: 'vencimiento' })}`), [filtros.q, filtros.tipo, filtros.sucursal_id, filtros.estado, filtros.vence_en]);
  const todo = () => { resumen.recargar(); lista.recargar(); tiposD.recargar(); };
  const f = (k) => (e) => setFiltros((s) => ({ ...s, [k]: e.target.value }));
  const filtrar = (cambios) => { setTab('docs'); setFiltros({ q: '', tipo: '', sucursal_id: '', estado: 'activos', vence_en: '', ...cambios }); };

  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <div><h1>Documentos</h1><small>Contratos, permisos, registros sanitarios y todo lo que vence. {contexto?.empresa?.nombre}.</small></div>
        {editar && <div className="fila"><button className="btn primario" onClick={() => setSubiendo(true)}>+ Subir documento</button></div>}
      </div>

      <Estado d={resumen}>{({ kpis: k, checklist: cl }) => (
        <>
          <div className="rejilla cols-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
            <Boton onClick={() => filtrar({})}><Kpi etiqueta="Vigentes" valor={k.vigentes} sub={`${k.activos} en total`} /></Boton>
            <Boton onClick={() => filtrar({ vence_en: 30 })}><Kpi etiqueta="Vencen en 30 días" valor={k.d30} acento={k.d30 > 0} /></Boton>
            <Boton onClick={() => filtrar({ vence_en: 60 })}><Kpi etiqueta="Vencen en 60 días" valor={k.d30 + k.d60} /></Boton>
            <Boton onClick={() => filtrar({ vence_en: 90 })}><Kpi etiqueta="Vencen en 90 días" valor={k.d30 + k.d60 + k.d90} /></Boton>
            <Boton onClick={() => filtrar({ estado: 'vencido' })}><Kpi etiqueta="Vencidos" valor={k.vencidos} acento={k.vencidos > 0} sub={k.vencidos ? 'Requieren renovación' : 'Todo al día'} /></Boton>
            <Boton onClick={() => setTab('checklist')}><Kpi etiqueta="Faltan por registrar" valor={cl.resumen.falta + cl.resumen.vencido} sub={`de ${cl.resumen.total} esperados`} acento={cl.resumen.falta + cl.resumen.vencido > 0} /></Boton>
          </div>
          {k.vencidos > 0 && <div className="aviso-caja mal">Hay {k.vencidos} documento(s) vencido(s). Operar sin un permiso o licencia vigente puede traer multas o cierre. <button className="btn chico" style={{ marginLeft: 8 }} onClick={() => filtrar({ estado: 'vencido' })}>Verlos</button></div>}
        </>
      )}</Estado>

      <Tabs tabs={[['docs', 'Documentos'], ['checklist', 'Qué debe tener la empresa'], ...(editar ? [['tipos', 'Tipos de documento']] : [])]} valor={tab} onCambio={setTab} />

      {tab === 'docs' && (
        <>
          <div className="rejilla cols-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', alignItems: 'end' }}>
            <Campo etiqueta="Buscar"><input type="search" placeholder="Título, número, emisor, etiqueta…" value={filtros.q} onChange={f('q')} /></Campo>
            <Campo etiqueta="Tipo"><select value={filtros.tipo} onChange={f('tipo')}><option value="">Todos</option>{tipos.filter((t) => t.activo || t.documentos > 0).map((t) => <option key={t.codigo} value={t.codigo}>{t.nombre}</option>)}</select></Campo>
            {sucursales.length > 1 && <Campo etiqueta="Sucursal"><select value={filtros.sucursal_id} onChange={f('sucursal_id')}><option value="">Todas</option>{sucursales.map((s) => <option key={s.id} value={s.id}>{s.nombre}</option>)}</select></Campo>}
            <Campo etiqueta="Estado"><select value={filtros.estado} onChange={(e) => setFiltros((s) => ({ ...s, estado: e.target.value, vence_en: '' }))}>
              <option value="activos">Activos</option><option value="vigente">Vigentes</option><option value="por_vencer">Por vencer</option><option value="vencido">Vencidos</option><option value="archivado">Archivados</option><option value="todos">Todos</option></select></Campo>
            <Campo etiqueta="Ver como"><select value={vista} onChange={(e) => setVista(e.target.value)}><option value="tipos">Tarjetas por tipo</option><option value="lista">Lista</option></select></Campo>
          </div>
          {filtros.vence_en && <div className="fila"><span className="chip aviso">Vencen en los próximos {filtros.vence_en} días</span><button className="btn chico fantasma" onClick={() => setFiltros((s) => ({ ...s, vence_en: '' }))}>Quitar</button></div>}
          <Estado d={lista}>{({ filas, total }) => filas.length === 0
            ? <div className="vacio">No hay documentos con estos filtros.{editar && ' Usa «Subir documento» para registrar el primero.'}</div>
            : <>
              {vista === 'lista' ? <Tabla filas={filas} onAbrir={setAbierto} /> : <PorTipo filas={filas} tipos={tipos} onAbrir={setAbierto} />}
              {total > filas.length && <small className="tenue">Mostrando {filas.length} de {total}. Afina la búsqueda para ver el resto.</small>}
            </>}</Estado>
        </>
      )}

      {tab === 'checklist' && <Checklist onAbrir={setAbierto} puedeSubir={editar} onSubir={(i) => setForm({ inicial: { tipo: i.tipo, sucursal_id: i.sucursal_id ?? '' } })} />}
      {tab === 'tipos' && editar && <Tipos d={tiposD} sinGuardar={todo} />}

      {subiendo && (
        <Modal titulo="Subir documento" tam="angosto" onCerrar={() => setSubiendo(false)}>
          <ZonaArchivos onArchivos={(a) => { setSubiendo(false); setForm({ inicial: { archivo: a[0] } }); }} onError={(m) => avisar(m, 'mal')} texto="Suelta aquí el archivo o tómale una foto" />
          <button className="btn fantasma" onClick={() => { setSubiendo(false); setForm({}); }}>Registrar sin archivo</button>
        </Modal>)}
      {form && tipos.length > 0 && <Formulario doc={form.doc} inicial={form.inicial} tipos={tipos} onCerrar={() => setForm(null)} onGuardado={(d) => { setForm(null); todo(); setAbierto(d.id); }} />}
      {abierto && <Ficha id={abierto} onCerrar={() => setAbierto(null)} onCambio={todo} onEditar={(doc) => { setAbierto(null); setForm({ doc }); }} />}
    </div>
  );
}

const Boton = ({ onClick, children }) => <button type="button" onClick={onClick} style={{ textAlign: 'left', background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer' }}>{children}</button>;

const Estatus = ({ d }) => {
  const e = ESTADO_INFO[d.estado];
  return <span className={`chip ${e.clase}`}>{d.estado === 'archivado' ? e.texto : d.fecha_vencimiento ? textoVence(d) : 'Sin vencimiento'}</span>;
};

function Tarjeta({ d, onAbrir }) {
  return (
    <button className="tarjeta doc-tarjeta" onClick={() => onAbrir(d.id)}>
      <div className="fila espacio"><b>{d.titulo}</b>{d.confidencialidad === 'restringido' && <span className="chip aviso" title="Solo dueño y administrador">🔒</span>}</div>
      <small className="tenue">{[d.sucursal, d.empleado, d.contraparte, d.numero && `N.º ${d.numero}`].filter(Boolean).join(' · ') || d.tipo_nombre}</small>
      <div className="fila"><Estatus d={d} />{d.fecha_vencimiento && <small className="tenue">{fechaCorta(d.fecha_vencimiento)}</small>}</div>
      <small className="tenue">{d.nombre_archivo ? `${d.nombre_archivo} · ${tamanoLegible(d.tamano)}${d.version_actual > 1 ? ` · v${d.version_actual}` : ''}` : 'Sin archivo'}</small>
    </button>
  );
}

function PorTipo({ filas, tipos, onAbrir }) {
  const grupos = useMemo(() => {
    const m = new Map();
    for (const d of filas) { if (!m.has(d.tipo)) m.set(d.tipo, []); m.get(d.tipo).push(d); }
    const orden = (c) => tipos.findIndex((t) => t.codigo === c);
    return [...m.entries()].sort((a, b) => orden(a[0]) - orden(b[0]));
  }, [filas, tipos]);
  return grupos.map(([codigo, docs]) => {
    const t = tipos.find((x) => x.codigo === codigo);
    return (
      <section key={codigo} style={{ display: 'grid', gap: 10 }}>
        <div className="fila"><h3 style={{ margin: 0 }}>{t?.nombre ?? codigo}</h3><span className="chip">{docs.length}</span>{t && <small className="tenue">{GRUPOS_DOC[t.grupo]}</small>}</div>
        <div className="rejilla cols-3">{docs.map((d) => <Tarjeta key={d.id} d={d} onAbrir={onAbrir} />)}</div>
      </section>
    );
  });
}

function Tabla({ filas, onAbrir }) {
  return (
    <div className="tarjeta pad0"><div className="tabla-wrap"><table>
      <thead><tr><th>Documento</th><th>Tipo</th><th>Sucursal</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
      <tbody>{filas.map((d) => (
        <tr key={d.id} onClick={() => onAbrir(d.id)} style={{ cursor: 'pointer' }}>
          <td><b>{d.titulo}</b>{d.confidencialidad === 'restringido' && ' 🔒'}<div><small className="tenue">{d.numero && `N.º ${d.numero}`}{d.empleado && ` ${d.empleado}`}</small></div></td>
          <td>{d.tipo_nombre}</td><td>{d.sucursal ?? '—'}</td><td className="num">{fechaCorta(d.fecha_vencimiento)}</td><td><Estatus d={d} /></td>
          <td className="der"><button className="btn chico fantasma">Abrir</button></td>
        </tr>))}</tbody>
    </table></div></div>
  );
}

const ETQ = { ok: ['Vigente', 'ok'], por_vencer: ['Por vencer', 'aviso'], vencido: ['Vencido: renovar', 'mal'], falta: ['Falta', 'mal'] };

function Checklist({ onAbrir, onSubir, puedeSubir }) {
  const d = useDatos(() => get('/documentos/checklist'), []);
  return (
    <Estado d={d}>{({ items, resumen }) => items.length === 0
      ? <div className="vacio">No hay documentos esperados configurados. Actívalos en «Tipos de documento».</div>
      : (
        <>
          <div className={`aviso-caja ${resumen.falta + resumen.vencido ? '' : 'ok'}`}>
            {resumen.falta + resumen.vencido === 0 ? 'Tienes al día todos los documentos esperados.' : `Faltan ${resumen.falta} y hay ${resumen.vencido} sin versión vigente (vencidos). Un documento cuenta como «vigente» si no está vencido ni archivado.`}
          </div>
          <div className="doc-lista-check">{items.map((i) => {
            const [txt, clase] = ETQ[i.estado];
            return (
              <div key={`${i.tipo}-${i.sucursal_id}`} className={`doc-check ${i.estado}`}>
                <span className="doc-punto" aria-hidden />
                <div><b>{i.tipo_nombre}</b>{i.sucursal && <span className="tenue"> · {i.sucursal}</span>}{i.vence && <div><small className="tenue">Vence {fechaCorta(i.vence)}</small></div>}</div>
                <div className="fila"><span className={`chip ${clase}`}>{txt}</span>
                  {i.documento_id && <button className="btn chico fantasma" onClick={() => onAbrir(i.documento_id)}>Ver</button>}
                  {puedeSubir && (i.estado === 'falta' || i.estado === 'vencido') && <button className="btn chico primario" onClick={() => onSubir(i)}>{i.estado === 'falta' ? 'Registrar' : 'Renovar'}</button>}
                </div>
              </div>);
          })}</div>
        </>)}</Estado>
  );
}

function Tipos({ d, sinGuardar }) {
  const [ejecutar] = useAccion();
  const [nuevo, setNuevo] = useState(false);
  const cambiar = (t, cambios) => ejecutar(async () => { await put(`/documentos/tipos/${t.codigo}`, cambios); sinGuardar(); });
  return (
    <Estado d={d}>{({ tipos, grupos }) => (
      <>
        <div className="fila espacio"><small>Lista de tipos de esta empresa. Marca «esperado» para que aparezca en el checklist y «por sucursal» si se necesita uno en cada sucursal.</small><button className="btn" onClick={() => setNuevo(true)}>+ Nuevo tipo</button></div>
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Tipo</th><th>Esperado</th><th>Por sucursal</th><th>Avisar (días)</th><th>Confidencial</th><th>Activo</th></tr></thead>
          <tbody>{tipos.map((t) => (
            <tr key={t.codigo} style={{ opacity: t.activo ? 1 : 0.55 }}>
              <td><b>{t.nombre}</b><div><small className="tenue">{grupos[t.grupo]} · {t.documentos} documento(s)</small></div></td>
              <td><input type="checkbox" checked={t.esperado} onChange={(e) => cambiar(t, { esperado: e.target.checked })} aria-label={`${t.nombre} esperado`} /></td>
              <td><input type="checkbox" checked={t.por_sucursal} onChange={(e) => cambiar(t, { por_sucursal: e.target.checked })} aria-label={`${t.nombre} por sucursal`} /></td>
              <td><input type="number" min="0" max="730" defaultValue={t.dias_aviso} style={{ width: 80 }} onBlur={(e) => Number(e.target.value) !== t.dias_aviso && cambiar(t, { dias_aviso: Number(e.target.value) })} /></td>
              <td><input type="checkbox" checked={t.confidencial} onChange={(e) => cambiar(t, { confidencial: e.target.checked })} aria-label={`${t.nombre} confidencial`} /></td>
              <td><input type="checkbox" checked={t.activo} onChange={(e) => cambiar(t, { activo: e.target.checked })} aria-label={`${t.nombre} activo`} /></td>
            </tr>))}</tbody>
        </table></div></div>
        {nuevo && <NuevoTipo grupos={grupos} onCerrar={() => setNuevo(false)} onGuardado={() => { setNuevo(false); sinGuardar(); }} />}
      </>)}</Estado>
  );
}

function NuevoTipo({ grupos, onCerrar, onGuardado }) {
  const [t, setT] = useState({ nombre: '', grupo: 'otro', esperado: false, por_sucursal: false, requiere_vencimiento: true, confidencial: false, dias_aviso: 30 });
  const [ejecutar, ocupado] = useAccion();
  const set = (k) => (e) => setT({ ...t, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal titulo="Nuevo tipo de documento" tam="angosto" onCerrar={onCerrar}
      pie={<button className="btn primario" disabled={ocupado || t.nombre.trim().length < 2} onClick={async () => { if (await ejecutar(() => post('/documentos/tipos', { ...t, dias_aviso: Number(t.dias_aviso) }), 'Tipo creado')) onGuardado(); }}>Crear</button>}>
      <Campo etiqueta="Nombre"><input value={t.nombre} onChange={set('nombre')} autoFocus placeholder="Ej.: Licencia de rótulos" /></Campo>
      <Campo etiqueta="Grupo"><select value={t.grupo} onChange={set('grupo')}>{Object.entries(grupos).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Campo>
      <Campo etiqueta="Avisar con (días)"><input type="number" min="0" max="730" value={t.dias_aviso} onChange={set('dias_aviso')} /></Campo>
      <label className="fila"><input type="checkbox" checked={t.esperado} onChange={set('esperado')} /> Es obligatorio tenerlo (entra al checklist)</label>
      <label className="fila"><input type="checkbox" checked={t.por_sucursal} onChange={set('por_sucursal')} /> Se necesita uno por sucursal</label>
      <label className="fila"><input type="checkbox" checked={t.requiere_vencimiento} onChange={set('requiere_vencimiento')} /> Tiene fecha de vencimiento</label>
      <label className="fila"><input type="checkbox" checked={t.confidencial} onChange={set('confidencial')} /> Confidencial (solo dueño y administrador)</label>
    </Modal>
  );
}
