import { useMemo, useState } from 'react';
import { Buscador } from '../ui/kit.jsx';

const sinTildes = (t) => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tabla con encabezados que ordenan (clic, Enter o Espacio; en celular, selector «Ordenar por»). Con más de 8 filas ofrece búsqueda.
 *  columnas: [{ clave, titulo, numerica?, render?, ordenar? }]; filas pueden traer `claseFila`. */
export default function TablaOrdenable({ filas, columnas, ordenInicial, limite, vacio = 'Sin datos en este rango.', buscable }) {
  const [orden, setOrden] = useState(ordenInicial ?? { clave: columnas[0].clave, desc: true });
  const [q, setQ] = useState('');
  const conBusqueda = buscable ?? filas.length > 8;
  const filtradas = useMemo(() => {
    const t = sinTildes(q).trim();
    if (!t) return filas;
    return filas.filter((f) => sinTildes(columnas.map((c) => { const v = (c.ordenar ?? ((x) => x[c.clave]))(f); return typeof v === 'object' ? '' : v; }).join(' ')).includes(t));
  }, [filas, columnas, q]);
  const ordenadas = useMemo(() => {
    const col = columnas.find((c) => c.clave === orden.clave);
    const valor = col?.ordenar ?? ((f) => f[orden.clave]);
    return [...filtradas].sort((a, b) => {
      const va = valor(a), vb = valor(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'es');
      return orden.desc ? -cmp : cmp;
    });
  }, [filtradas, columnas, orden]);
  const visibles = limite ? ordenadas.slice(0, limite) : ordenadas;
  const ordenar = (clave) => setOrden((o) => ({ clave, desc: o.clave === clave ? !o.desc : true }));
  return (
    <div className="tabla-wrap">
      {(conBusqueda || columnas.length > 2) && (
        <div className="fila tabla-herramientas">
          {conBusqueda && <Buscador valor={q} onCambio={setQ} placeholder="Buscar en la tabla…" etiqueta="Buscar en la tabla" ancho={260} />}
          <label className="solo-movil" style={{ flex: 1 }}>
            <span className="solo-lector">Ordenar por</span>
            <select value={`${orden.clave}|${orden.desc ? 'd' : 'a'}`} onChange={(e) => { const [clave, d] = e.target.value.split('|'); setOrden({ clave, desc: d === 'd' }); }} aria-label="Ordenar por">
              {columnas.flatMap((c) => [<option key={`${c.clave}d`} value={`${c.clave}|d`}>Ordenar: {c.titulo} ↓</option>, <option key={`${c.clave}a`} value={`${c.clave}|a`}>Ordenar: {c.titulo} ↑</option>])}
            </select>
          </label>
        </div>
      )}
      <table>
        <thead><tr>{columnas.map((c) => (
          <th key={c.clave} scope="col" tabIndex={0} role="columnheader" aria-sort={orden.clave === c.clave ? (orden.desc ? 'descending' : 'ascending') : 'none'}
            className={`th-orden${c.numerica ? ' der' : ''}`} onClick={() => ordenar(c.clave)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ordenar(c.clave); } }}>
            {c.titulo}{orden.clave === c.clave && <span aria-hidden="true"> {orden.desc ? '▾' : '▴'}</span>}
          </th>))}</tr></thead>
        <tbody>
          {visibles.length === 0 && <tr><td colSpan={columnas.length} className="vacio">{q ? `Nada coincide con «${q}».` : vacio}</td></tr>}
          {visibles.map((f, i) => (
            <tr key={f.clave ?? i} className={f.claseFila}>{columnas.map((c) => <td key={c.clave} className={c.numerica ? 'der num' : ''}>{c.render ? c.render(f) : f[c.clave]}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {limite && ordenadas.length > limite && <small>Mostrando {limite} de {ordenadas.length}. El CSV trae todo.</small>}
    </div>
  );
}
