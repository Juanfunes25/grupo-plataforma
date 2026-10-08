import { useCallback, useEffect, useRef, useState } from 'react';
import { DeduplicadorDeLecturas, limitadorDeRepintado } from './deduplicador.js';
import { LectorSimulado } from './lectores/lectorSimulado.js';
import { LectorTeclado } from './lectores/lectorTeclado.js';

export const MODOS = {
  teclado: { id: 'teclado', nombre: 'Modo teclado', crear: () => new LectorTeclado(), disponible: () => true },
  demo: { id: 'demo', nombre: 'Demostración', crear: () => new LectorSimulado(), disponible: () => true },
};

const vacio = { cantidad: 0, lista: [], crudas: 0, descartadas: 0, saturado: false };

/**
 * Maneja el lector para la pantalla: conexión, estado, y las lecturas YA deduplicadas.
 * Las lecturas llegan a cientos por segundo, así que no se guardan en estado de React una
 * por una: se acumulan en el deduplicador y la pantalla se refresca como mucho cuatro veces
 * por segundo.
 */
export function useLector() {
  const lectorRef = useRef(null);
  const dedupRef = useRef(new DeduplicadorDeLecturas());
  const limitadorRef = useRef(null);
  const quitarRef = useRef([]);
  const crudosRef = useRef({ lista: [], pendiente: false });
  const [modo, setModo] = useState(null);
  const [estado, setEstado] = useState('desconectado');
  const [detalle, setDetalle] = useState('');
  const [error, setError] = useState(null);
  const [lecturas, setLecturas] = useState(vacio);
  const [crudos, setCrudos] = useState([]);

  const foto = useCallback(() => {
    const d = dedupRef.current;
    setLecturas({ cantidad: d.cantidad, lista: d.instantanea(), crudas: d.lecturasTotales, descartadas: d.descartadas, saturado: d.saturado });
  }, []);

  const soltar = useCallback(async () => {
    limitadorRef.current?.detener();
    limitadorRef.current = null;
    quitarRef.current.forEach((q) => q());
    quitarRef.current = [];
    try { await lectorRef.current?.desconectar(); } catch { /* ya estaba caído */ }
    lectorRef.current = null;
  }, []);

  const conectar = useCallback(async (idModo) => {
    await soltar();
    setError(null);
    setCrudos([]);
    crudosRef.current = { lista: [], pendiente: false };
    setEstado('conectando');
    setDetalle('Buscando lector…');
    const lector = MODOS[idModo].crear();
    lectorRef.current = lector;
    setModo(idModo);
    quitarRef.current = [
      lector.on('estado', (e, d) => { setEstado(e); setDetalle(d || ''); }),
      lector.on('error', (e) => setError(e)),
      // En modo continuo llegan cientos por segundo: se juntan (el mismo texto seguido suma «veces») y la pantalla se refresca 4 veces por segundo.
      lector.on('crudo', (c) => {
        const r = crudosRef.current;
        if (r.lista[0]?.texto === c.texto) r.lista[0].veces += 1;
        else r.lista = [{ ...c, veces: 1, hora: Date.now() }, ...r.lista].slice(0, 6);
        if (!r.pendiente) {
          r.pendiente = true;
          setTimeout(() => { r.pendiente = false; setCrudos([...r.lista]); }, 250);
        }
      }),
      lector.on('lectura', (l) => {
        const r = dedupRef.current.registrar(l);
        if (r === 'nuevo' || r === 'actualizado') limitadorRef.current?.marcar();
      }),
    ];
    try {
      await lector.conectar();
    } catch (e) {
      setError(e);
      setEstado('error');
      lectorRef.current = null;
    }
  }, [soltar]);

  const empezarEscaneo = useCallback(async () => {
    const lector = lectorRef.current;
    if (!lector) return;
    dedupRef.current.reiniciar();
    foto();
    limitadorRef.current?.detener();
    limitadorRef.current = limitadorDeRepintado(foto, 250);
    try { await lector.iniciarInventario(); } catch (e) { setError(e); }
  }, [foto]);

  const detenerEscaneo = useCallback(async () => {
    try { await lectorRef.current?.detenerInventario(); } catch (e) { setError(e); }
    limitadorRef.current?.detener();
    limitadorRef.current = null;
    foto();
  }, [foto]);

  useEffect(() => () => { soltar(); }, [soltar]);

  return {
    modo, estado, detalle, error, lecturas, crudos,
    lector: lectorRef,
    paraEnviar: () => dedupRef.current.paraEnviar(),
    limpiarError: () => setError(null),
    conectar, desconectar: soltar, empezarEscaneo, detenerEscaneo,
  };
}
