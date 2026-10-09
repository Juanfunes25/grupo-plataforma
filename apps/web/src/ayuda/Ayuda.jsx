// Pantalla «Ayuda»: manual por rol navegable, búsqueda dentro del manual y botón para repetir el recorrido.
import { useMemo, useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Buscador, EncabezadoPagina } from '../ui/kit.jsx';
import { MANUAL, ROLES_AYUDA, rolDeAyuda } from './contenido.js';
import { pedirRecorrido } from './recorridoEstado.js';
import './ayuda.css';

const plano = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function ManualRol({ rolId, consulta = '' }) {
  const secciones = useMemo(() => {
    const q = plano(consulta).trim();
    return MANUAL[rolId].filter((s) => !q || plano(`${s.titulo} ${s.pasos.join(' ')}`).includes(q));
  }, [rolId, consulta]);
  return (
    <div className="ay-pagina">
      <nav className="ay-indice" aria-label="Contenido del manual">{secciones.map((s) => <a key={s.id} href={`#ay-${s.id}`}>{s.titulo}</a>)}</nav>
      <div style={{ display: 'grid', gap: 14 }}>
        {secciones.length === 0 && <div className="vacio">Nada coincide con «{consulta}».</div>}
        {secciones.map((s) => (
          <section key={s.id} id={`ay-${s.id}`} className="tarjeta ay-seccion">
            <h2>{s.titulo}</h2>
            <ol className="ay-pasos">{s.pasos.map((p) => <li key={p}>{p}</li>)}</ol>
            {s.aviso && <div className="ay-aviso">{s.aviso}</div>}
          </section>
        ))}
      </div>
    </div>
  );
}

export default function Ayuda() {
  const { contexto, usuario } = useSesion();
  const propio = rolDeAyuda(contexto?.rol, usuario?.es_dueno_grupo);
  const [rolId, setRolId] = useState(propio);
  const [q, setQ] = useState('');
  return (
    <div className="pagina">
      <EncabezadoPagina titulo="Ayuda" descripcion="Manual por rol y recorridos guiados"
        acciones={<button className="btn primario" onClick={() => pedirRecorrido(rolId)}>Ver el recorrido</button>} />
      <div className="ay-roles" role="group" aria-label="Rol del manual">
        {ROLES_AYUDA.map((r) => <button key={r.id} className={`btn chico${r.id === rolId ? ' primario' : ''}`} aria-pressed={r.id === rolId} onClick={() => setRolId(r.id)}>{r.nombre}{r.id === propio ? ' (el tuyo)' : ''}</button>)}
      </div>
      <small>{ROLES_AYUDA.find((r) => r.id === rolId)?.resumen}</small>
      <Buscador valor={q} onCambio={setQ} placeholder="Buscar en el manual…" etiqueta="Buscar en el manual" />
      <ManualRol rolId={rolId} consulta={q} />
    </div>
  );
}
