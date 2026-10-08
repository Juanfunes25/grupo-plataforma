import { useCallback, useEffect, useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Tabs, useAviso } from '../ui/kit.jsx';
import { rget, contarPendientes, sincronizarCola } from '../rinv/api.js';
import '../rinv/rinv.css';
import Ficha from '../rinv/Ficha.jsx';
import Escaner from '../rinv/Escaner.jsx';
import { Fabrica, Reordenar } from '../rinv/Insumos.jsx';
import { CargarPedido, SacarDeBodega } from '../rinv/Cargar.jsx';
import Sucursales from '../rinv/Sucursales.jsx';
import { Calidad, Movimientos, PorCategoria, Valor } from '../rinv/Reportes.jsx';
import Rfid from '../rinv/Rfid.jsx';

const CLAVE_TAB = 'rinv.tab';

/**
 * Inventario y RFID de Italo: reemplaza al inventario genérico. Insumos de fábrica (materia prima Mec3, locales y Ristoris),
 * insumos y empaques por sucursal, lotes con vencimiento, valor, kardex, y el control de tags RFID de los freezers.
 * Tocar un insumo abre su ficha como pantalla propia (no un acordeón): la lista siempre queda intacta.
 */
export default function InventarioGelato() {
  const { puede, sucursales } = useSesion();
  const avisar = useAviso();
  const opciones = [
    ['insumos', '🧂 Insumos'], ['reordenar', '⚠️ Reordenar'], ['cargar', '📥 Cargar'], ['sacar', '📤 Sacar'], ['escanear', '📷 Escanear'], ['sucursales', '🏬 Sucursales'],
    ['movimientos', '🕘 Movimientos'], ['categorias', '📊 Categorías'], ...(puede('rep:costeo') ? [['valor', '💰 Valor']] : []), ['calidad', '🧪 Calidad'], ['rfid', '🧊 RFID'],
  ];
  const [tab, setTab] = useState(() => { try { const g = localStorage.getItem(CLAVE_TAB); return opciones.some(([k]) => k === g) ? g : 'insumos'; } catch { return 'insumos'; } });
  const [detalle, setDetalle] = useState(null);
  const [escaneando, setEscaneando] = useState(false);
  const [noReconocido, setNoReconocido] = useState('');
  const [pend, setPend] = useState(contarPendientes());
  const [clave, setClave] = useState(0);

  const sincronizar = useCallback(async () => { setPend(await sincronizarCola()); setClave((k) => k + 1); }, []);
  useEffect(() => {
    const act = () => setPend(contarPendientes());
    sincronizar();
    window.addEventListener('online', sincronizar); window.addEventListener('rinv:cola', act);
    return () => { window.removeEventListener('online', sincronizar); window.removeEventListener('rinv:cola', act); };
  }, [sincronizar]);

  const cambiar = (t) => { setTab(t); try { localStorage.setItem(CLAVE_TAB, t); } catch { /* */ } };
  const abrir = (ambito, sucursalId, insumo, lista) => setDetalle({ ambito, sucursalId, insumo, lista: lista || null, indice: lista ? lista.findIndex((i) => i.id === insumo.id) : -1 });
  const navegar = (d) => setDetalle((x) => { const n = x.indice + d; return x?.lista && n >= 0 && n < x.lista.length ? { ...x, insumo: x.lista[n], indice: n } : x; });

  async function alDetectar(codigo) {
    setEscaneando(false); setNoReconocido('');
    try {
      const e = await rget(`/codigo/${encodeURIComponent(codigo)}`);
      if (e.ambito === 'fabrica') {
        const f = (await rget('/fabrica')).find((i) => i.id === e.id);
        if (f) { cambiar('insumos'); abrir('fabrica', null, f, null); }
      } else {
        const suc = sucursales[0]?.id;
        const l = suc ? await rget(`/sucursal/${suc}`) : [];
        const f = l.find((i) => i.id === e.id);
        if (f) abrir('sucursal', suc, f, null); else avisar(`«${e.nombre}» es un insumo de sucursal; ábrelo desde Sucursales`);
      }
    } catch { setNoReconocido(codigo); }
  }

  if (detalle) {
    return (
      <Ficha key={detalle.insumo.id} ambito={detalle.ambito} sucursalId={detalle.sucursalId} insumo={detalle.insumo} onVolver={() => { setDetalle(null); setClave((k) => k + 1); }}
        onEscanearSiguiente={() => { setDetalle(null); setEscaneando(true); }}
        onAnterior={detalle.lista && detalle.indice > 0 ? () => navegar(-1) : null} onSiguiente={detalle.lista && detalle.indice < detalle.lista.length - 1 ? () => navegar(1) : null}
        posicion={detalle.lista ? { actual: detalle.indice + 1, total: detalle.lista.length } : null} />
    );
  }
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Inventario y RFID</h1></div>
      {pend > 0 && <div className="aviso-caja">📴 {pend} cambio{pend === 1 ? '' : 's'} guardado{pend === 1 ? '' : 's'} sin señal — se envían solos cuando vuelva el internet. <button className="btn chico" onClick={sincronizar}>Reintentar ahora</button></div>}
      {noReconocido && <div className="aviso-caja fila espacio"><span>Código «{noReconocido}» no reconocido.</span><button className="btn chico" onClick={() => setNoReconocido('')}>Descartar</button></div>}
      <Tabs valor={tab} onCambio={cambiar} tabs={opciones} />
      <div key={clave}>
        {tab === 'insumos' && <Fabrica onAbrir={(i, l) => abrir('fabrica', null, i, l)} onEscanear={() => setEscaneando(true)} />}
        {tab === 'reordenar' && <Reordenar onAbrir={(i, l) => abrir('fabrica', null, i, l)} />}
        {tab === 'cargar' && <CargarPedido onCargado={() => setClave((k) => k + 1)} />}
        {tab === 'sacar' && <SacarDeBodega />}
        {tab === 'escanear' && (
          <div className="tarjeta centro rejilla"><div style={{ fontSize: '2.6rem' }}>📷</div><b>Escanear código de barras</b>
            <p className="tenue">Apunta al código del producto y se abre su ficha directo, sin buscarlo en la lista.</p><button className="btn primario grande" onClick={() => setEscaneando(true)}>Abrir la cámara</button></div>
        )}
        {tab === 'sucursales' && <Sucursales onAbrir={abrir} />}
        {tab === 'movimientos' && <Movimientos sucursales={sucursales} />}
        {tab === 'categorias' && <PorCategoria />}
        {tab === 'valor' && <Valor />}
        {tab === 'calidad' && <Calidad />}
        {tab === 'rfid' && <Rfid />}
      </div>
      {escaneando && <Escaner onDetectado={alDetectar} onCerrar={() => setEscaneando(false)} />}
    </div>
  );
}
