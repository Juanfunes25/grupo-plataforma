// Búsqueda global para la paleta (Ctrl/⌘+K y botón de la lupa): consulta /api/busqueda con espera y descarta respuestas viejas.
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, qs } from '../api.js';
import { useSesion } from '../sesion.jsx';

const ICONOS = { facturas: 'reportes', clientes: 'clientes', productos: 'catalogo', empleados: 'usuarios', documentos: 'escudo' };

/** Devuelve opciones con la forma de la paleta: [{ id, grupo, nombre, detalle, icono, accion }] más el estado de carga. */
export function useBusquedaGlobal(texto) {
  const nav = useNavigate();
  const { contexto } = useSesion();
  const [est, setEst] = useState({ opciones: [], cargando: false, error: false });
  const n = useRef(0);
  const q = texto.trim();
  const codigo = contexto?.empresa?.codigo;
  useEffect(() => {
    const mi = ++n.current;
    if (q.length < 2 || !codigo) { setEst({ opciones: [], cargando: false, error: false }); return undefined; }
    setEst((e) => ({ ...e, cargando: true }));
    const t = setTimeout(async () => {
      try {
        const r = await get(`/busqueda${qs({ q })}`);
        if (mi !== n.current) return;
        const opciones = r.grupos.flatMap((g) => g.items.map((it) => ({
          id: `b-${g.id}-${it.id}`, grupo: g.titulo, nombre: it.titulo, detalle: [it.etiqueta, it.detalle].filter(Boolean).join(' · '), icono: ICONOS[g.id] ?? 'lupa',
          accion: () => nav(`/${codigo}/${it.ruta}${qs({ q: it.buscar ?? it.titulo })}`),
        })));
        setEst({ opciones, cargando: false, error: false });
      } catch { if (mi === n.current) setEst({ opciones: [], cargando: false, error: true }); }
    }, 220);
    return () => clearTimeout(t);
  }, [q, codigo]); // eslint-disable-line react-hooks/exhaustive-deps
  return est;
}
