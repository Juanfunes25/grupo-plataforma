import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { almacen, fijarEmpresa, get, post } from './api.js';

const Ctx = createContext(null);
export const useSesion = () => useContext(Ctx);

/**
 * Sesión = token + empresa activa + contexto (rol, permisos, módulos, sucursales).
 * El token vale para todas las empresas del usuario (salvo el de PIN, que es de una sola).
 */
// EcoStone llama «Venta Directa» al mostrador (nombre por empresa; el catálogo de módulos compartido no cambia).
const NOMBRE_POS = { ecostone: 'Venta Directa' };
const renombrar = (ms, emp) => (NOMBRE_POS[emp] ? ms.map((m) => (m.id === 'pos' ? { ...m, nombre: NOMBRE_POS[emp] } : m)) : ms);

export function ProveedorSesion({ children }) {
  const [guardada, setGuardada] = useState(() => almacen.leer());
  const [yo, setYo] = useState(null);                 // /auth/yo
  const [empresa, setEmpresa] = useState(() => almacen.leer()?.empresa ?? null);
  const [cargando, setCargando] = useState(Boolean(almacen.leer()));
  const [sucursalId, setSucursalId] = useState(null);

  const salir = useCallback(() => {
    almacen.guardar(null); fijarEmpresa(null);
    setGuardada(null); setYo(null); setEmpresa(null); setSucursalId(null);
  }, []);

  useEffect(() => {
    const f = () => salir();
    window.addEventListener('grupo:sesion-vencida', f);
    return () => window.removeEventListener('grupo:sesion-vencida', f);
  }, [salir]);

  // Carga (o recarga) el contexto cuando cambia la empresa activa.
  const cargar = useCallback(async (codigo) => {
    if (!almacen.leer()) { setCargando(false); return; }
    setCargando(true);
    try {
      // La entrada "grupo" no es una empresa: se usa la primera que el usuario pueda ver.
      const base = await get('/auth/yo', { empresa: null });
      const real = codigo && codigo !== 'grupo' && base.empresas.some((e) => e.codigo === codigo) ? codigo : base.empresas[0]?.codigo;
      fijarEmpresa(real);
      const completo = real ? await get('/auth/yo', { empresa: real }) : base;
      setYo(completo);
      const k = `grupo.sucursal.${real}`;
      let sid = null;
      try { sid = localStorage.getItem(k); } catch { /* */ }
      const lista = completo.contexto?.sucursales ?? [];
      setSucursalId(lista.find((s) => s.id === sid)?.id ?? lista[0]?.id ?? null);
    } catch {
      /* 401 ya dispara cierre de sesión */
    } finally { setCargando(false); }
  }, []);

  useEffect(() => { if (guardada) cargar(empresa); else { setCargando(false); } }, [guardada, empresa, cargar]);

  const entrar = useCallback(async (ruta, cuerpo) => {
    const r = await post(ruta, cuerpo, { sinSesion: true, empresa: null });
    const s = { token: r.token, empresa: r.empresa, via: ruta.endsWith('pin') ? 'pin' : 'password' };
    almacen.guardar(s); setGuardada(s); setEmpresa(r.empresa);
    return r;
  }, []);

  const cambiarEmpresa = useCallback((codigo) => { const s = almacen.leer(); if (s) almacen.guardar({ ...s, empresa: codigo }); setEmpresa(codigo); }, []);

  const elegirSucursal = useCallback((id) => {
    setSucursalId(id);
    try { localStorage.setItem(`grupo.sucursal.${yo?.contexto?.empresa?.codigo}`, id); } catch { /* */ }
  }, [yo]);

  const valor = useMemo(() => {
    const permisos = new Set(yo?.contexto?.permisos ?? []);
    const sucursales = yo?.contexto?.sucursales ?? [];
    return {
      autenticado: Boolean(guardada), cargando, yo, usuario: yo?.usuario, via: guardada?.via,
      empresa, contexto: yo?.contexto, empresas: yo?.empresas ?? [], permisos,
      puede: (p) => permisos.has(p), modulos: renombrar(yo?.contexto?.modulos ?? [], yo?.contexto?.empresa?.codigo),
      sucursales, sucursalId, sucursal: sucursales.find((s) => s.id === sucursalId) ?? null,
      elegirSucursal, entrar, salir, cambiarEmpresa, recargar: () => cargar(empresa),
    };
  }, [guardada, cargando, yo, empresa, sucursalId, entrar, salir, cambiarEmpresa, elegirSucursal, cargar]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
