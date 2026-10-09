import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import './lib/fuentes.css';   // Inter y Barlow Condensed alojadas aquí (sin Google Fonts)
import './lib/errores.js';   // reporta al servidor los errores de pantalla
import { useSesion } from './sesion.jsx';
import Entrada from './pantallas/Entrada.jsx';
import Layout from './pantallas/Layout.jsx';
import Hub from './pantallas/Hub.jsx';
import { Cargando } from './ui/kit.jsx';
import Sincronizador from './pos/Sincronizador.jsx';   // manda las ventas hechas sin conexión cuando vuelve la señal

/** Pantalla que se descarga al abrirla; `.precargar()` adelanta la descarga sin dibujarla. */
function perezosa(cargar) {
  let p = null;
  const una = () => (p ??= cargar().catch((e) => { p = null; throw e; }));   // si falla la red, el siguiente intento vuelve a pedirla
  const C = lazy(una);
  C.precargar = una;
  return C;
}

// La pantalla de acceso solo la ve quien todavía no entró: no viaja en el JavaScript de entrada de quien ya tiene sesión.
const Acceso = perezosa(() => import('./pantallas/Acceso.jsx'));
const Pos = perezosa(() => import('./pos/Pos.jsx'));
const Cocina = perezosa(() => import('./pantallas/Cocina.jsx'));
const Ventas = perezosa(() => import('./pantallas/Ventas.jsx'));
const Catalogo = perezosa(() => import('./pantallas/Catalogo.jsx'));
const Inventario = perezosa(() => import('./pantallas/Inventario.jsx'));
const Personal = perezosa(() => import('./pantallas/Personal.jsx'));
const Finanzas = perezosa(() => import('./pantallas/Finanzas.jsx'));
const Compras = perezosa(() => import('./compras/Compras.jsx'));
const Terceros = perezosa(() => import('./pantallas/Terceros.jsx'));
const Admin = perezosa(() => import('./pantallas/Admin.jsx'));
const Grupo = perezosa(() => import('./pantallas/Grupo.jsx'));
const Gerente = perezosa(() => import('./pantallas/GerenteEmpresa.jsx'));
const Facturas = perezosa(() => import('./pantallas/Facturas.jsx'));
const Cierres = perezosa(() => import('./pantallas/Cierres.jsx'));
const CajaChica = perezosa(() => import('./pantallas/CajaChica.jsx'));
const Reportes = perezosa(() => import('./pantallas/Reportes.jsx'));
const Dashboard = perezosa(() => import('./pantallas/Dashboard.jsx'));
const Antifraude = perezosa(() => import('./pantallas/Antifraude.jsx'));
const Bitacora = perezosa(() => import('./pantallas/Bitacora.jsx'));
const Cai = perezosa(() => import('./pantallas/Cai.jsx'));
const Usuarios = perezosa(() => import('./pantallas/Usuarios.jsx'));
const Sucursales = perezosa(() => import('./pantallas/Sucursales.jsx'));
const Cotizaciones = perezosa(() => import('./pantallas/CotizacionesRuta.jsx'));
const Piedra = perezosa(() => import('./pantallas/Piedra.jsx'));
const RegistrarProduccion = perezosa(() => import('./pantallas/RegistrarProduccion.jsx'));
const Fabricacion = perezosa(() => import('./pantallas/Fabricacion.jsx'));
const Recetas = perezosa(() => import('./pantallas/Recetas.jsx'));
const Insumos = perezosa(() => import('./pantallas/Insumos.jsx'));
const InventarioPiedra = perezosa(() => import('./pantallas/InventarioPiedra.jsx'));
const Trazabilidad = perezosa(() => import('./pantallas/Trazabilidad.jsx'));
const ReporteProduccion = perezosa(() => import('./pantallas/ReporteProduccion.jsx'));
const Salidas = perezosa(() => import('./pantallas/Salidas.jsx'));
const ProductosDis = perezosa(() => import('./pantallas/ProductosDis.jsx'));
const InventarioDis = perezosa(() => import('./pantallas/InventarioDis.jsx'));
const TableroGelato = perezosa(() => import('./pantallas/TableroGelato.jsx'));
const PesajeGelato = perezosa(() => import('./pantallas/PesajeGelato.jsx'));
const DespachoGelato = perezosa(() => import('./pantallas/DespachoGelato.jsx'));
const ProduccionGelato = perezosa(() => import('./pantallas/ProduccionGelato.jsx'));
const ConsumoGelato = perezosa(() => import('./pantallas/ConsumoGelato.jsx'));
const CosteoGelato = perezosa(() => import('./pantallas/CosteoGelato.jsx'));
const InventarioGelato = perezosa(() => import('./pantallas/InventarioGelato.jsx'));
const Incidencias = perezosa(() => import('./pantallas/Incidencias.jsx'));
const Mantenimiento = perezosa(() => import('./pantallas/Mantenimiento.jsx'));
const Cobranza = perezosa(() => import('./crm/Cobranza.jsx'));
const Documentos = perezosa(() => import('./pantallas/Documentos.jsx'));
const EstadoSistema = perezosa(() => import('./sistema/Estado.jsx'));
const MiSeguridad = perezosa(() => import('./seguridad/MiSeguridad.jsx'));
const Impresora = perezosa(() => import('./pantallas/Impresora.jsx'));
const Ayuda = perezosa(() => import('./ayuda/Ayuda.jsx'));
const MiApp = perezosa(() => import('./pantallas/MiApp.jsx'));

const Planilla = perezosa(() => import('./planilla/Planilla.jsx'));
const InventarioUnificado = perezosa(() => import('./inventario/InventarioUnificado.jsx'));

const PANTALLAS = { estado: EstadoSistema, planilla: Planilla, 'inventario-unificado': InventarioUnificado, cobranza: Cobranza, pos: Pos, cocina: Cocina, ventas: Ventas, catalogo: Catalogo, inventario: Inventario, personal: Personal, finanzas: Finanzas, compras: Compras, terceros: Terceros, admin: Admin, gerente: Gerente,
  facturas: Facturas, cierres: Cierres, 'caja-chica': CajaChica, reportes: Reportes, dashboard: Dashboard, antifraude: Antifraude, bitacora: Bitacora,
  cai: Cai, usuarios: Usuarios, sucursales: Sucursales, cotizaciones: Cotizaciones, impresora: Impresora,
  piedra: Piedra, 'registrar-produccion': RegistrarProduccion, produccion: Fabricacion, recetas: Recetas, insumos: Insumos, 'inventario-piedra': InventarioPiedra,
  trazabilidad: Trazabilidad, 'reporte-produccion': ReporteProduccion, salidas: Salidas, productos: ProductosDis, 'inventario-d': InventarioDis,
  gelato: TableroGelato, pesaje: PesajeGelato, despacho: DespachoGelato, 'gelato-produccion': ProduccionGelato, consumo: ConsumoGelato, 'gelato-costeo': CosteoGelato,
  'gelato-inventario': InventarioGelato, incidencias: Incidencias, mantenimiento: Mantenimiento, documentos: Documentos, ayuda: Ayuda };

// Al abrir (o recargar) directamente una pantalla, su código se pide YA, en paralelo con la sesión (/auth/yo), en vez de esperar
// a que la sesión responda para recién empezar a descargarlo: un viaje de red menos en la cadena del primer dibujo.
(() => {
  try {
    const [, emp, ruta] = window.location.pathname.split('/');
    if (emp === 'acceso') Acceso.precargar();
    else if (emp === 'grupo') Grupo.precargar();
    else if (ruta && PANTALLAS[ruta]?.precargar) PANTALLAS[ruta].precargar();
  } catch { /* sin efecto */ }
})();

function Protegida({ children }) {
  const s = useSesion();
  if (s.cargando && !s.yo) return <Cargando texto="Entrando…" />;
  if (!s.autenticado) return <Navigate to="/" replace />;
  return <>{children}<Sincronizador /></>;
}

function Modulo() {
  const { ruta } = useParams();
  const { modulos, contexto } = useSesion();
  const Pantalla = PANTALLAS[ruta];
  if (!contexto) return <Cargando />;
  if (!Pantalla || !modulos.some((m) => m.ruta === ruta)) {
    return <Navigate to={`/${contexto.empresa.codigo}`} replace />;   // lo que no está disponible no se muestra: se vuelve al inicio de la empresa
  }
  return <Suspense fallback={<Cargando />}><Pantalla /></Suspense>;
}

function Seguridad() {
  const s = useSesion();
  const nav = useNavigate();
  return <Suspense fallback={<Cargando />}><MiSeguridad alSalir={() => { s.salir(); nav('/'); }} /></Suspense>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Entrada />} />
      <Route path="/acceso/:codigo" element={<Suspense fallback={<Cargando />}><Acceso /></Suspense>} />
      <Route path="/app" element={<Suspense fallback={<Cargando />}><MiApp /></Suspense>} />
      <Route path="/grupo" element={<Protegida><Layout esGrupo><Suspense fallback={<Cargando />}><Grupo /></Suspense></Layout></Protegida>} />
      <Route path="/:empresa" element={<Protegida><Layout><Hub /></Layout></Protegida>} />
      <Route path="/:empresa/seguridad" element={<Protegida><Layout><Seguridad /></Layout></Protegida>} />
      <Route path="/:empresa/:ruta" element={<Protegida><Layout><Modulo /></Layout></Protegida>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
