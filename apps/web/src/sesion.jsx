import { quitarPlanta } from './lib/planta.js';
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
    // La sesión también se cierra en el servidor (si falla la red, igual se cierra aquí).
    const t = almacen.leer()?.token;
    if (t) fetch('/api/auth/salir', { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {});
    quitarPlanta();
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
      // Arranque rápido: con la empresa ya conocida se pide todo en UNA llamada (antes eran dos seguidas, y en una red lenta cada una cuesta ~0,3 s).
      // Si ya no tiene acceso a esa empresa, se cae al camino de siempre.
      let completo = null, real = null;
      if (codigo && codigo !== 'grupo') {
        try {
          const r = await get('/auth/yo', { empresa: codigo });
          if (r.contexto && r.empresas.some((e) => e.codigo === codigo)) { completo = r; real = codigo; }
        } catch (e) { if (e.status === 401 || e.status === 0) throw e; }
      }
      if (!completo) {
        const base = await get('/auth/yo', { empresa: null });
        real = codigo && codigo !== 'grupo' && base.empresas.some((e) => e.codigo === codigo) ? codigo : base.empresas[0]?.codigo;
        fijarEmpresa(real);
        completo = real ? await get('/auth/yo', { empresa: real }) : base;
      }
      fijarEmpresa(real);
      try { localStorage.setItem(`grupo.yo.${real}`, JSON.stringify(completo)); } catch { /* sin caché */ }   // para abrir la caja SIN conexión
      setYo(completo);
      const k = `grupo.sucursal.${real}`;
      let sid = null;
      try { sid = localStorage.getItem(k); } catch { /* */ }
      const lista = completo.contexto?.sucursales ?? [];
      setSucursalId(lista.find((s) => s.id === sid)?.id ?? lista[0]?.id ?? null);
    } catch (e) {
      /* 401 ya dispara cierre de sesión. Sin red (status 0): se abre con la última sesión conocida de esta empresa, para poder seguir vendiendo. */
      if (e?.status === 0) {
        const cod = codigo && codigo !== 'grupo' ? codigo : almacen.leer()?.empresa;
        let c = null; try { c = JSON.parse(localStorage.getItem(`grupo.yo.${cod}`) || 'null'); } catch { /* */ }
        if (c?.contexto) {
          fijarEmpresa(cod); setYo(c);
          let sid = null; try { sid = localStorage.getItem(`grupo.sucursal.${cod}`); } catch { /* */ }
          const lista = c.contexto.sucursales ?? [];
          setSucursalId(lista.find((x) => x.id === sid)?.id ?? lista[0]?.id ?? null);
        }
      }
    } finally { setCargando(false); }
  }, []);

  useEffect(() => { if (guardada) cargar(empresa); else { setCargando(false); } }, [guardada, empresa, cargar]);

  const entrar = useCallback(async (ruta, cuerpo) => {
    const r = await post(ruta, cuerpo, { sinSesion: true, empresa: null });
    if (r.requiere_2fa || r.requiere_configurar_2fa) return r;   // falta el segundo paso: la pantalla de acceso lo pide y llama a completar()
    const s = { token: r.token, empresa: r.empresa, via: ruta.endsWith('pin') ? 'pin' : 'password' };
    almacen.guardar(s); setGuardada(s); setEmpresa(r.empresa);
    return r;
  }, []);
  /** Cierra el login de dos pasos con la respuesta que trae el token. */
  const completar = useCallback((r) => {
    const s = { token: r.token, empresa: r.empresa, via: 'password' };
    almacen.guardar(s); setGuardada(s); setEmpresa(r.empresa);
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
      elegirSucursal, entrar, completar, salir, cambiarEmpresa, recargar: () => cargar(empresa),
    };
  }, [guardada, cargando, yo, empresa, sucursalId, entrar, completar, salir, cambiarEmpresa, elegirSucursal, cargar]);

  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
