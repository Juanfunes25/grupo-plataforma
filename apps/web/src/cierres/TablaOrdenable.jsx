import { useMemo, useState } from 'react';

/** Tabla con encabezados que ordenan al hacer clic. columnas: [{ clave, titulo, numerica?, render?, ordenar? }]; filas pueden traer `claseFila`. */
export default function TablaOrdenable({ filas, columnas, ordenInicial, limite, vacio = 'Sin datos en este rango.' }) {
  const [orden, setOrden] = useState(ordenInicial ?? { clave: columnas[0].clave, desc: true });
  const ordenadas = useMemo(() => {
    const col = columnas.find((c) => c.clave === orden.clave);
    const valor = col?.ordenar ?? ((f) => f[orden.clave]);
    return [...filas].sort((a, b) => {
      const va = valor(a), vb = valor(b);
      const cmp = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va ?? '').localeCompare(String(vb ?? ''), 'es');
      return orden.desc ? -cmp : cmp;
    });
  }, [filas, columnas, orden]);
  const visibles = limite ? ordenadas.slice(0, limite) : ordenadas;
  return (
    <div className="tabla-wrap">
      <table>
        <thead><tr>{columnas.map((c) => (
          <th key={c.clave} className={`th-orden${c.numerica ? ' der' : ''}`} onClick={() => setOrden((o) => ({ clave: c.clave, desc: o.clave === c.clave ? !o.desc : true }))}>
            {c.titulo}{orden.clave === c.clave && <span> {orden.desc ? '▾' : '▴'}</span>}
          </th>))}</tr></thead>
        <tbody>
          {visibles.length === 0 && <tr><td colSpan={columnas.length} className="vacio">{vacio}</td></tr>}
          {visibles.map((f, i) => (
            <tr key={f.clave ?? i} className={f.claseFila}>{columnas.map((c) => <td key={c.clave} className={c.numerica ? 'der num' : ''}>{c.render ? c.render(f) : f[c.clave]}</td>)}</tr>
          ))}
        </tbody>
      </table>
      {limite && ordenadas.length > limite && <small>Mostrando {limite} de {ordenadas.length}. El CSV trae todo.</small>}
    </div>
  );
}
