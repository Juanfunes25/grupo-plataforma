// Aviso discreto «Te enviaron N sabores» para el cajero de día, dentro del POS. Flota en una esquina: no mueve ni tapa el cobro.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useSesion } from '../sesion.jsx';
import { hoyIso, sumarDias } from './lib.js';
import './rep.css';

/** Cuántos sabores envió fábrica (hoy o ayer) a las sucursales del usuario y nadie ha confirmado. */
export async function contarPorConfirmar() {
  const hoy = hoyIso();
  const [a, b] = await Promise.all([get(`/rep/despachos/${hoy}`), get(`/rep/despachos/${sumarDias(hoy, -1)}`)]);
  const vistos = new Set();
  for (const d of [...Object.values(a).flat(), ...Object.values(b).flat()]) if (d.estado === 'enviado') vistos.add(d.id);
  return vistos.size;
}

export default function AvisoRecepcion() {
  const { modulos, contexto, puede } = useSesion();
  const [n, setN] = useState(0);
  const [oculto, setOculto] = useState(false);
  const aplica = puede('rep:pesar') && modulos.some((m) => m.id === 'rep_pesaje');
  useEffect(() => {
    if (!aplica) return undefined;
    let vivo = true;
    const cargar = () => contarPorConfirmar().then((c) => vivo && setN(c)).catch(() => {});
    cargar();
    const t = setInterval(cargar, 5 * 60000);
    return () => { vivo = false; clearInterval(t); };
  }, [aplica]);
  if (!aplica || oculto || n === 0) return null;
  return (
    <div className="rep-aviso-pos" role="status">
      <Link to={`/${contexto.empresa.codigo}/pesaje`} title={`Te enviaron ${n} sabor${n === 1 ? '' : 'es'}: confirma que llegaron`}>{n} por recibir</Link>
      <button className="btn chico fantasma" onClick={() => setOculto(true)} aria-label="Ocultar aviso">✕</button>
    </div>
  );
}
