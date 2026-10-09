import { useState } from 'react';
import { fechaHN, lempiras, sumarDias } from '@grupo/shared';
import { get, post, put, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { BarrasH, Campo, Columnas, Estado, Kpi, Modal, Tabs, useAccion, useDatos } from '../ui/kit.jsx';
import { Anillo, InformeEmpresa, ListaHallazgos } from '../ui/GerenteDigital.jsx';
import GrupoDocumentos from '../documentos/GrupoDocumentos.jsx';
import PanelRrhh from '../rrhh/Directorio.jsx';
import InventarioGrupo from '../inventario/InventarioGrupo.jsx';
import Consolidado from '../fin/Consolidado.jsx';
import { pedirRecorrido } from '../ayuda/recorridoEstado.js';
import TableroGrupo from '../tablero/TableroGrupo.jsx';

const PERIODOS = () => { const h = fechaHN(); return { 'Este mes': [`${h.slice(0, 8)}01`, h], '7 días': [sumarDias(h, -6), h], '30 días': [sumarDias(h, -29), h], Hoy: [h, h] }; };
const ROLES = [['ventas', 'Ventas'], ['gerente', 'Manager'], ['admin', 'Administrador'], ['dueno', 'Dueño de la empresa'], ['cajero', 'Cajero'], ['produccion', 'Producción / cocina'], ['bodega', 'Bodega'], ['contador', 'Contador'], ['solo_lectura', 'Solo lectura']];
const rolNombre = (id) => ROLES.find((r) => r[0] === id)?.[1] ?? id;

export default function Grupo() {
  const { usuario } = useSesion();
  const [tab, setTab] = useState('hoy');
  const tabs = [['hoy', 'Hoy'], ['resumen', 'Resumen del periodo'], ['gerente', 'Gerente digital'], ['finanzas', 'Finanzas del grupo'], ['alertas', 'Alertas'], ['inventario', 'Inventario'], ['rrhh', 'Recursos humanos'], ['documentos', 'Documentos'], ...(usuario?.es_dueno_grupo ? [['usuarios', 'Administradores y accesos']] : [])];
  return (
    <div className="pagina" style={{ maxWidth: 1360 }}>
      <div className="encabezado-pagina"><div><h1>Dirección del grupo</h1><small>Las cuatro empresas en una sola vista. Cada empresa lleva su propio inventario y operación; aquí ves y controlas todo.</small></div><button className="btn chico" onClick={() => pedirRecorrido('dueno')}>Ayuda</button></div>
      <Tabs tabs={tabs} valor={tab} onCambio={setTab} />
      {tab === 'hoy' && <TableroGrupo />}
      {tab === 'resumen' && <Resumen />}
      {tab === 'gerente' && <GerenteGrupo />}
      {tab === 'finanzas' && <Finanzas />}
      {tab === 'alertas' && <Alertas />}
      {tab === 'inventario' && <InventarioGrupo />}
      {tab === 'rrhh' && <PanelRrhh grupo />}
      {tab === 'documentos' && <GrupoDocumentos />}
      {tab === 'usuarios' && <Administradores />}
    </div>
  );
}

function Selector({ per, setPer }) {
  return <select value={per} onChange={(e) => setPer(e.target.value)} aria-label="Periodo">{Object.keys(PERIODOS()).map((p) => <option key={p}>{p}</option>)}</select>;
}

function Resumen() {
  const [per, setPer] = useState('Este mes');
  const [desde, hasta] = PERIODOS()[per];
  const d = useDatos(() => get(`/grupo/resumen${qs({ desde, hasta })}`), [desde, hasta]);
  return (
    <>
      <div className="fila espacio"><small>{desde} a {hasta}</small><Selector per={per} setPer={setPer} /></div>
      <Estado d={d}>{(r) => r.empresas.length === 0 ? <div className="aviso-caja">Tu usuario no tiene permiso para ver el consolidado.</div> : (
        <>
          <div className="rejilla cols-4">
            <Kpi acento etiqueta="Ventas netas consolidadas" valor={lempiras(r.total.ventas_netas_consolidadas)} sub={r.total.eliminacion_intercompania > 0 ? `Eliminadas ${lempiras(r.total.eliminacion_intercompania)} entre empresas` : `${r.total.facturas} facturas`} />
            <Kpi etiqueta="Vendido hoy" valor={lempiras(r.total.hoy)} />
            <Kpi etiqueta="Utilidad bruta" valor={lempiras(r.total.utilidad_bruta)} sub={`Costo de ventas ${lempiras(r.total.costo_ventas)}`} />
            <Kpi etiqueta="Utilidad operativa" valor={lempiras(r.total.utilidad_operativa)} sub={`Gastos ${lempiras(r.total.gastos_operativos)}`} />
          </div>
          <div className="rejilla cols-2">
            <div className="tarjeta"><h3>Ventas netas por empresa</h3><BarrasH datos={r.empresas} etiqueta={(e) => e.nombre} valor={(e) => e.ventas_netas} formato={lempiras} color={(e) => e.color} /></div>
            <div className="tarjeta"><h3>Utilidad operativa por empresa</h3><BarrasH datos={r.empresas.map((e) => ({ ...e, u: Math.max(0, e.utilidad_operativa) }))} etiqueta={(e) => e.nombre} valor={(e) => e.u} formato={lempiras} color={(e) => e.color} /></div>
          </div>
          <div className="rejilla cols-2">
            {r.empresas.map((e) => (
              <section key={e.codigo} className="tarjeta" style={{ borderTop: `4px solid ${e.color}`, display: 'grid', gap: 10 }}>
                <div className="fila espacio"><h2>{e.nombre}</h2><span className="chip">hoy {lempiras(e.hoy.total)}</span></div>
                <div className="rejilla cols-3" style={{ gap: 8 }}>
                  <div><small>Ventas netas</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600 }}>{lempiras(e.ventas_netas)}</div></div>
                  <div><small>Margen bruto</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600 }}>{e.margen_bruto_pct == null ? '—' : `${e.margen_bruto_pct}%`}</div></div>
                  <div><small>Utilidad op.</small><div className="num" style={{ fontSize: '1.3rem', fontWeight: 600, color: e.utilidad_operativa < 0 ? 'var(--peligro)' : undefined }}>{lempiras(e.utilidad_operativa)}</div></div>
                </div>
                {e.serie.length > 1 && <Columnas datos={e.serie} etiqueta={(x) => x.fecha.slice(8)} valor={(x) => x.total} formato={lempiras} />}
                {e.sucursales.length > 1 && <BarrasH datos={e.sucursales} etiqueta={(s) => s.sucursal} valor={(s) => s.total} formato={lempiras} />}
                {e.venta_sin_costo > 0 && <small style={{ color: 'var(--aviso)' }}>⚠ {lempiras(e.venta_sin_costo)} vendidos sin receta: costo no capturado.</small>}
              </section>
            ))}
          </div>
        </>
      )}</Estado>
    </>
  );
}

function GerenteGrupo() {
  const [dias, setDias] = useState(28);
  const d = useDatos(() => get(`/grupo/gerente${qs({ dias })}`), [dias]);
  const [abierta, setAbierta] = useState(null);
  return (
    <>
      <div className="fila espacio"><small>Gerente digital de Dirección: analiza cada empresa y luego las compara entre sí.</small>
        <select value={dias} onChange={(e) => setDias(Number(e.target.value))} aria-label="Periodo"><option value={14}>Últimos 14 días</option><option value={28}>Últimos 28 días</option><option value={60}>Últimos 60 días</option></select></div>
      <Estado d={d}>{({ grupo, empresas }) => (
        <>
          <div className="tarjeta" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 18, alignItems: 'center' }}>
            {grupo.salud != null ? <Anillo valor={grupo.salud} nivel="salud del grupo" /> : <div className="chip">sin datos</div>}
            <b style={{ fontSize: '1.05rem', lineHeight: 1.45 }}>{grupo.resumen}</b>
          </div>
          {grupo.ranking.length > 0 && (
            <div className="rejilla cols-4">{grupo.ranking.map((e, i) => (
              <button key={e.codigo} className="tarjeta" style={{ textAlign: 'left' }} onClick={() => setAbierta(abierta === e.codigo ? null : e.codigo)}>
                <small className="tenue">#{i + 1} por utilidad</small><h3>{e.nombre}</h3>
                <div className="num" style={{ fontSize: '1.4rem', fontWeight: 600, color: e.utilidad_operativa < 0 ? 'var(--peligro)' : undefined }}>{lempiras(e.utilidad_operativa)}</div>
                <small>Salud {e.salud}/100 · {e.nivel}</small>
              </button>))}</div>
          )}
          <h2>Lo más importante del grupo</h2>
          <ListaHallazgos hallazgos={grupo.hallazgos} max={12} />
          <h2>Gerente digital de cada empresa</h2>
          {empresas.map((e) => (
            <section key={e.empresa.codigo} className="tarjeta" style={{ display: 'grid', gap: 12 }}>
              <button className="fila espacio" style={{ background: 'none', border: 0, textAlign: 'left' }} onClick={() => setAbierta(abierta === e.empresa.codigo ? null : e.empresa.codigo)}>
                <h3>{e.empresa.nombre}</h3><small>{e.salud ? `Salud ${e.salud.puntaje}/100 · ${e.hallazgos.length} hallazgos` : 'Sin ventas aún'} · {abierta === e.empresa.codigo ? 'ocultar' : 'ver análisis'}</small>
              </button>
              {abierta === e.empresa.codigo && (<><InformeEmpresa r={e} /><ListaHallazgos hallazgos={e.hallazgos} /></>)}
            </section>
          ))}
        </>
      )}</Estado>
    </>
  );
}

function Finanzas() {
  const [sub, setSub] = useState('consolidado');
  return (
    <>
      <Tabs tabs={[['consolidado', 'Consolidado'], ['control', 'Gastos y entre empresas']]} valor={sub} onCambio={setSub} estilo="pildora" />
      {sub === 'consolidado' ? <Consolidado /> : <FinanzasControl />}
    </>
  );
}

function FinanzasControl() {
  const [per, setPer] = useState('Este mes');
  const [desde, hasta] = PERIODOS()[per];
  const res = useDatos(() => get(`/grupo/resumen${qs({ desde, hasta })}`), [desde, hasta]);
  const gastos = useDatos(() => get(`/grupo/gastos${qs({ desde, hasta })}`), [desde, hasta]);
  const interco = useDatos(() => get('/grupo/intercompania'), []);
  const [modal, setModal] = useState(null);
  const [ejecutar] = useAccion();
  return (
    <>
      <div className="fila espacio"><div className="fila"><button className="btn primario" onClick={() => setModal('gasto')}>+ Gasto en una empresa</button><button className="btn" onClick={() => setModal('interco')}>+ Operación entre empresas</button></div><Selector per={per} setPer={setPer} /></div>
      <Estado d={res}>{(r) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Empresa</th><th className="der">Ventas netas</th><th className="der">Costo de ventas</th><th className="der">Utilidad bruta</th><th className="der">Gastos</th><th className="der">Utilidad operativa</th></tr></thead>
          <tbody>
            {r.empresas.map((e) => <tr key={e.codigo}><td><i style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: e.color, marginRight: 8 }} />{e.nombre}</td><td className="der num">{lempiras(e.ventas_netas)}</td><td className="der num">{lempiras(e.costo_ventas)}</td><td className="der num">{lempiras(e.utilidad_bruta)}</td><td className="der num">{lempiras(e.gastos_operativos)}</td><td className="der num"><b style={{ color: e.utilidad_operativa < 0 ? 'var(--peligro)' : undefined }}>{lempiras(e.utilidad_operativa)}</b></td></tr>)}
            <tr style={{ background: 'var(--panel-2)' }}><td><b>Total grupo</b></td><td className="der num"><b>{lempiras(r.total.ventas_netas)}</b></td><td className="der num"><b>{lempiras(r.total.costo_ventas)}</b></td><td className="der num"><b>{lempiras(r.total.utilidad_bruta)}</b></td><td className="der num"><b>{lempiras(r.total.gastos_operativos)}</b></td><td className="der num"><b>{lempiras(r.total.utilidad_operativa)}</b></td></tr>
            {r.total.eliminacion_intercompania > 0 && <tr><td colSpan={5} className="der tenue">Menos ventas entre empresas del grupo</td><td className="der num">−{lempiras(r.total.eliminacion_intercompania)}</td></tr>}
          </tbody>
        </table></div></div>
      )}</Estado>
      <h2>Gastos de todas las empresas</h2>
      <Estado d={gastos}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Fecha</th><th>Empresa</th><th>Descripción</th><th>Categoría</th><th className="der">Monto</th></tr></thead>
          <tbody>{l.map((g) => <tr key={g.id} style={{ opacity: g.anulado ? 0.4 : 1 }}><td className="num">{g.fecha}</td><td>{g.empresa_nombre}</td><td>{g.descripcion}{g.sucursal ? <small> · {g.sucursal}</small> : ''}</td><td><small>{g.categoria}</small></td><td className="der num">{lempiras(g.monto)}</td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin gastos en el periodo.</div>}</div></div>
      )}</Estado>
      <h2>Entre empresas del grupo</h2>
      <Estado d={interco}>{(l) => (
        <div className="tarjeta pad0"><table>
          <thead><tr><th>Fecha</th><th>De</th><th>A</th><th>Concepto</th><th className="der">Monto</th><th></th></tr></thead>
          <tbody>{l.map((i) => <tr key={i.id}><td className="num">{i.fecha}</td><td>{i.origen}</td><td>{i.destino}</td><td>{i.concepto}</td><td className="der num">{lempiras(i.monto)}</td>
            <td className="der">{i.estado === 'pendiente' ? <button className="btn chico" onClick={async () => { await ejecutar(() => put(`/grupo/intercompania/${i.id}/conciliar`), 'Conciliado'); interco.recargar(); }}>Conciliar</button> : <span className="chip ok">conciliado</span>}</td></tr>)}</tbody>
        </table>{l.length === 0 && <div className="vacio">Sin operaciones entre empresas.</div>}</div>
      )}</Estado>
      {modal === 'gasto' && <GastoGrupo onCerrar={() => setModal(null)} onListo={() => { setModal(null); gastos.recargar(); res.recargar(); }} />}
      {modal === 'interco' && <IntercoModal onCerrar={() => setModal(null)} onListo={() => { setModal(null); interco.recargar(); res.recargar(); }} />}
    </>
  );
}

function GastoGrupo({ onCerrar, onListo }) {
  const { empresas } = useSession2();
  const cats = useDatos(() => get('/grupo/categorias-gasto'), []);
  const [f, setF] = useState({ empresa: empresas[0]?.codigo ?? '', categoria_id: '', descripcion: '', monto: '', isv: '', fecha: fechaHN() });
  const [ejecutar, ocupado] = useAccion();
  const delaEmpresa = (cats.datos ?? []).filter((c) => c.empresa === f.empresa);
  const guardar = async () => { if (await ejecutar(() => post('/grupo/gastos', { empresa: f.empresa, categoria_id: f.categoria_id, descripcion: f.descripcion, monto: parseFloat(f.monto), isv: parseFloat(f.isv) || 0, fecha: f.fecha }), 'Gasto registrado')) onListo(); };
  return (
    <Modal titulo="Registrar gasto en una empresa" onCerrar={onCerrar} pie={<button className="btn primario" disabled={ocupado || !f.categoria_id || f.descripcion.trim().length < 3 || !(parseFloat(f.monto) > 0)} onClick={guardar}>Guardar</button>}>
      <div className="rejilla cols-2">
        <Campo etiqueta="Empresa"><select value={f.empresa} onChange={(e) => setF({ ...f, empresa: e.target.value, categoria_id: '' })}>{empresas.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select></Campo>
        <Campo etiqueta="Categoría"><select value={f.categoria_id} onChange={(e) => setF({ ...f, categoria_id: e.target.value })}><option value="">Elegir…</option>{delaEmpresa.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}</select></Campo>
      </div>
      <Campo etiqueta="Descripción"><input value={f.descripcion} onChange={(e) => setF({ ...f, descripcion: e.target.value })} /></Campo>
      <div className="rejilla cols-3">
        <Campo etiqueta="Total (ISV incluido, L)"><input inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} /></Campo>
        <Campo etiqueta="De ese total, ISV"><input inputMode="decimal" value={f.isv} onChange={(e) => setF({ ...f, isv: e.target.value })} /></Campo>
        <Campo etiqueta="Fecha"><input type="date" value={f.fecha} onChange={(e) => setF({ ...f, fecha: e.target.value })} /></Campo>
      </div>
    </Modal>
  );
}
// Empresas que el usuario puede ver, para los selectores de Dirección.
function useSession2() { const s = useSesion(); return { empresas: s.empresas }; }

function IntercoModal({ onCerrar, onListo }) {
  const { empresas } = useSession2();
  const [f, setF] = useState({ origen: empresas[0]?.codigo ?? '', destino: empresas[1]?.codigo ?? '', concepto: '', monto: '' });
  const [ejecutar, ocupado] = useAccion();
  const guardar = async () => { if (await ejecutar(() => post('/grupo/intercompania', { ...f, monto: parseFloat(f.monto) }), 'Registrado')) onListo(); };
  return (
    <Modal titulo="Operación entre empresas" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || f.origen === f.destino || f.concepto.trim().length < 3 || !(parseFloat(f.monto) > 0)} onClick={guardar}>Guardar</button>}>
      <small>Lo que una empresa le vende o le cobra a otra del grupo. Se resta en el consolidado para no contar la misma venta dos veces.</small>
      <div className="rejilla cols-2">
        <Campo etiqueta="Vende / cobra"><select value={f.origen} onChange={(e) => setF({ ...f, origen: e.target.value })}>{empresas.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select></Campo>
        <Campo etiqueta="A"><select value={f.destino} onChange={(e) => setF({ ...f, destino: e.target.value })}>{empresas.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select></Campo>
      </div>
      <Campo etiqueta="Concepto"><input value={f.concepto} onChange={(e) => setF({ ...f, concepto: e.target.value })} /></Campo>
      <Campo etiqueta="Monto (L)"><input inputMode="decimal" value={f.monto} onChange={(e) => setF({ ...f, monto: e.target.value })} /></Campo>
    </Modal>
  );
}

function Alertas() {
  const a = useDatos(() => get('/grupo/alertas'), []);
  return (
    <Estado d={a}>{(x) => {
      const n = Object.values(x).reduce((s, l) => s + l.length, 0);
      return n === 0 ? <div className="aviso-caja ok">Todo en orden: sin CAI por vencer, sin stock negativo, sin perecederos críticos ni turnos de caja olvidados.</div> : (
        <div className="rejilla cols-2">
          {x.cai.length > 0 && <div className="tarjeta"><h3>Facturación (CAI)</h3>{x.cai.map((c, i) => <div key={i} className="aviso-caja mal" style={{ marginTop: 6 }}>{c.empresa} · {c.sucursal}: vence {c.vence}, quedan {c.restantes} facturas</div>)}</div>}
          {x.stock_negativo.length > 0 && <div className="tarjeta"><h3>Stock negativo</h3>{x.stock_negativo.map((c, i) => <div key={i} className="aviso-caja" style={{ marginTop: 6 }}>{c.empresa} · {c.sucursal}: {c.insumo} ({c.cantidad})</div>)}</div>}
          {x.por_vencer.length > 0 && <div className="tarjeta"><h3>Por vencer (48 h)</h3>{x.por_vencer.map((c, i) => <div key={i} className="aviso-caja" style={{ marginTop: 6 }}>{c.empresa} · {c.sucursal}: {c.insumo} vence {c.vence}</div>)}</div>}
          {x.turnos_olvidados.length > 0 && <div className="tarjeta"><h3>Turnos de caja sin cerrar</h3>{x.turnos_olvidados.map((c, i) => <div key={i} className="aviso-caja mal" style={{ marginTop: 6 }}>{c.empresa} · {c.sucursal}: {c.cajero}</div>)}</div>}
        </div>
      );
    }}</Estado>
  );
}

function Administradores() {
  const { usuario } = useSesion();
  const d = useDatos(() => get('/grupo/usuarios'), []);
  const [modal, setModal] = useState(null);
  const [ejecutar] = useAccion();
  const toggle = async (u) => { await ejecutar(() => put(`/grupo/usuarios/${u.id}/administrador-general`, { valor: !u.es_dueno_grupo }), u.es_dueno_grupo ? 'Ya no es administrador general' : 'Ahora es administrador general'); d.recargar(); };
  return (
    <>
      <div className="aviso-caja"><b>Administrador general</b> = quien ve y controla las cuatro empresas (el “administrador de todos los administradores”). Cada empresa además tiene tres perfiles: <b>Ventas</b>, <b>Manager</b> y <b>Administrador</b>.</div>
      <div><button className="btn primario" onClick={() => setModal({ tipo: 'nuevo' })}>+ Usuario con correo</button></div>
      <Estado d={d}>{(l) => (
        <div className="tarjeta pad0"><div className="tabla-wrap"><table>
          <thead><tr><th>Persona</th><th>Perfil por empresa</th><th>Administrador general</th><th></th></tr></thead>
          <tbody>{l.map((u) => (
            <tr key={u.id} style={{ opacity: u.activo ? 1 : 0.45 }}>
              <td>{u.nombre}<br /><small>{u.email ?? 'solo PIN'}</small></td>
              <td>{u.accesos.length === 0 ? <small>sin acceso</small> : u.accesos.map((a) => <span key={a.empresa} className="chip" style={{ marginRight: 6, opacity: a.activo ? 1 : 0.4 }}>{a.empresa} · {rolNombre(a.rol)}</span>)}</td>
              <td>{u.es_dueno_grupo ? <span className="chip aviso">sí</span> : <small>no</small>}</td>
              <td className="der"><button className="btn chico" onClick={() => setModal({ tipo: 'acceso', u })}>Dar acceso</button>{' '}
                {u.id !== usuario.id && u.email && <button className="btn chico fantasma" onClick={() => toggle(u)}>{u.es_dueno_grupo ? 'Quitar general' : 'Hacer general'}</button>}</td>
            </tr>))}</tbody>
        </table></div></div>
      )}</Estado>
      {modal?.tipo === 'nuevo' && <NuevoUsuario onCerrar={() => setModal(null)} onListo={() => { setModal(null); d.recargar(); }} />}
      {modal?.tipo === 'acceso' && <AccesoModal u={modal.u} onCerrar={() => setModal(null)} onListo={() => { setModal(null); d.recargar(); }} />}
    </>
  );
}

function NuevoUsuario({ onCerrar, onListo }) {
  const [f, setF] = useState({ nombre: '', email: '', password: '', es_dueno_grupo: false });
  const [ejecutar, ocupado] = useAccion();
  return (
    <Modal titulo="Nuevo usuario con correo" onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado || f.nombre.trim().length < 2 || !f.email.includes('@') || f.password.length < 10} onClick={async () => { if (await ejecutar(() => post('/grupo/usuarios', f), 'Usuario creado')) onListo(); }}>Crear</button>}>
      <Campo etiqueta="Nombre"><input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} autoFocus /></Campo>
      <Campo etiqueta="Correo"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Campo>
      <Campo etiqueta="Contraseña inicial (mínimo 10)"><input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="off" /></Campo>
      <label className="fila"><input type="checkbox" checked={f.es_dueno_grupo} onChange={(e) => setF({ ...f, es_dueno_grupo: e.target.checked })} /> Administrador general (ve y controla las cuatro empresas)</label>
      <small>Después usa “Dar acceso” para asignarle su perfil en cada empresa.</small>
    </Modal>
  );
}

function AccesoModal({ u, onCerrar, onListo }) {
  const { empresas } = useSession2();
  const [f, setF] = useState({ empresa: empresas[0]?.codigo ?? '', rol: 'ventas', activo: true });
  const [ejecutar, ocupado] = useAccion();
  return (
    <Modal titulo={`Acceso de ${u.nombre}`} onCerrar={onCerrar} tam="angosto" pie={<button className="btn primario" disabled={ocupado} onClick={async () => { if (await ejecutar(() => put(`/grupo/usuarios/${u.id}/acceso`, f), 'Acceso guardado')) onListo(); }}>Guardar</button>}>
      <Campo etiqueta="Empresa"><select value={f.empresa} onChange={(e) => setF({ ...f, empresa: e.target.value })}>{empresas.map((e) => <option key={e.codigo} value={e.codigo}>{e.nombre}</option>)}</select></Campo>
      <Campo etiqueta="Perfil en esa empresa"><select value={f.rol} onChange={(e) => setF({ ...f, rol: e.target.value })}>{ROLES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}</select></Campo>
      <label className="fila"><input type="checkbox" checked={f.activo} onChange={(e) => setF({ ...f, activo: e.target.checked })} /> Acceso activo</label>
      <small>Ventas: cobra y consulta. Manager: opera la empresa y ve el gerente digital. Administrador: usuarios, catálogo, fiscal y todo lo de su empresa.</small>
    </Modal>
  );
}
