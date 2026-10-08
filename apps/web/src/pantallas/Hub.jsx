import { Link, Navigate } from 'react-router-dom';
import { inicioGelato } from '@grupo/shared';
import { useSesion } from '../sesion.jsx';
import Icono from '../ui/Icono.jsx';

export default function Hub() {
  const { contexto, modulos, usuario, permisos } = useSesion();
  if (!contexto) return null;
  const base = `/${contexto.empresa.codigo}`;
  // Italo (gelato): cada rol entra a lo suyo: tablero, despacho, producción o el pesaje de su tienda.
  const gelato = inicioGelato(modulos, permisos);
  if (gelato) return <Navigate to={`${base}/${gelato}`} replace />;
  // Como en Italo: se entra directo a Facturación (o al primer módulo disponible).
  const inicio = modulos.find((m) => m.id === 'pos') ?? modulos.find((m) => m.nav === 'Operación') ?? modulos.find((m) => m.nav === 'Negocio');
  if (inicio) return <Navigate to={`${base}/${inicio.ruta}`} replace />;
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
