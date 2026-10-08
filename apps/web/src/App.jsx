import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import { useSesion } from './sesion.jsx';
import Entrada from './pantallas/Entrada.jsx';
import Acceso from './pantallas/Acceso.jsx';
import Layout from './pantallas/Layout.jsx';
import Hub from './pantallas/Hub.jsx';
import { Cargando } from './ui/kit.jsx';

const Pos = lazy(() => import('./pos/Pos.jsx'));
const Cocina = lazy(() => import('./pantallas/Cocina.jsx'));
const Ventas = lazy(() => import('./pantallas/Ventas.jsx'));
const Catalogo = lazy(() => import('./pantallas/Catalogo.jsx'));
const Inventario = lazy(() => import('./pantallas/Inventario.jsx'));
const Personal = lazy(() => import('./pantallas/Personal.jsx'));
const Finanzas = lazy(() => import('./pantallas/Finanzas.jsx'));
const Terceros = lazy(() => import('./pantallas/Terceros.jsx'));
const Admin = lazy(() => import('./pantallas/Admin.jsx'));
const Grupo = lazy(() => import('./pantallas/Grupo.jsx'));
const Gerente = lazy(() => import('./pantallas/GerenteEmpresa.jsx'));
const Facturas = lazy(() => import('./pantallas/Facturas.jsx'));
const Cierres = lazy(() => import('./pantallas/Cierres.jsx'));
const CajaChica = lazy(() => import('./pantallas/CajaChica.jsx'));
const Reportes = lazy(() => import('./pantallas/Reportes.jsx'));
const Dashboard = lazy(() => import('./pantallas/Dashboard.jsx'));
const Antifraude = lazy(() => import('./pantallas/Antifraude.jsx'));
const Bitacora = lazy(() => import('./pantallas/Bitacora.jsx'));
const Cai = lazy(() => import('./pantallas/Cai.jsx'));
const Usuarios = lazy(() => import('./pantallas/Usuarios.jsx'));
const Sucursales = lazy(() => import('./pantallas/Sucursales.jsx'));
const Cotizaciones = lazy(() => import('./pantallas/Cotizaciones.jsx'));
const Impresora = lazy(() => import('./pantallas/Impresora.jsx'));

const PANTALLAS = { pos: Pos, cocina: Cocina, ventas: Ventas, catalogo: Catalogo, inventario: Inventario, personal: Personal, finanzas: Finanzas, terceros: Terceros, admin: Admin, gerente: Gerente,
  facturas: Facturas, cierres: Cierres, 'caja-chica': CajaChica, reportes: Reportes, dashboard: Dashboard, antifraude: Antifraude, bitacora: Bitacora,
  cai: Cai, usuarios: Usuarios, sucursales: Sucursales, cotizaciones: Cotizaciones, impresora: Impresora };

function Protegida({ children }) {
  const s = useSesion();
  if (s.cargando && !s.yo) return <Cargando texto="Entrando…" />;
  if (!s.autenticado) return <Navigate to="/" replace />;
  return children;
}

function Modulo() {
  const { ruta } = useParams();
  const { modulos, contexto } = useSesion();
  const Pantalla = PANTALLAS[ruta];
  if (!contexto) return <Cargando />;
  if (!Pantalla || !modulos.some((m) => m.ruta === ruta)) {
    return <div className="pagina"><div className="aviso-caja mal">No tienes acceso a este módulo en {contexto.empresa.nombre}.</div></div>;
  }
  return <Suspense fallback={<Cargando />}><Pantalla /></Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Entrada />} />
      <Route path="/acceso/:codigo" element={<Acceso />} />
      <Route path="/grupo" element={<Protegida><Layout esGrupo><Suspense fallback={<Cargando />}><Grupo /></Suspense></Layout></Protegida>} />
      <Route path="/:empresa" element={<Protegida><Layout><Hub /></Layout></Protegida>} />
      <Route path="/:empresa/:ruta" element={<Protegida><Layout><Modulo /></Layout></Protegida>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
