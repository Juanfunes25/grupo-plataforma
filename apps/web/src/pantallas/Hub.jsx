import { Link } from 'react-router-dom';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';

export default function Hub() {
  const { contexto, modulos, usuario } = useSesion();
  if (!contexto) return null;
  const base = `/${contexto.empresa.codigo}`;
  return (
    <div className="pagina">
      <div className="encabezado-pagina">
        <div>
          <h1>{contexto.empresa.nombre}</h1>
          <small>{contexto.empresa.razon_social} · {usuario.nombre}</small>
        </div>
      </div>
      {modulos.length === 0 ? <div className="aviso-caja">Tu usuario todavía no tiene módulos asignados. Pídele a administración que te dé acceso.</div> : (
        <nav className="modulos" aria-label="Módulos">
          {modulos.map((m) => (
            <Link key={m.id} to={`${base}/${m.ruta}`} className="modulo">
              <div className="ico"><Icono n={m.icono} tam={24} /></div>
              <strong>{m.nombre}</strong>
              <small>{m.descripcion}</small>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
