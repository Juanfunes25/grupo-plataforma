import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get } from '../api.js';

/**
 * Alertas de CAI por vencer o agotarse, para el tablero. Se oculta si no hay nada o si el usuario no puede verlas.
 *   <AlertasCai />                → la empresa activa
 *   <AlertasCai alcance="grupo" />→ todas las empresas (Dirección)
 */
export default function AlertasCai({ alcance }) {
  const { empresa } = useParams();
  const [lista, setLista] = useState([]);
  useEffect(() => {
    let vivo = true;
    get(`/fiscal/alertas${alcance === 'grupo' ? '?alcance=grupo' : ''}`).then((r) => vivo && setLista(r.alertas ?? [])).catch(() => {});
    return () => { vivo = false; };
  }, [alcance]);
  if (!lista.length) return null;
  const critica = lista.some((a) => a.nivel === 'critica');
  return (
    <div className={`aviso-caja ${critica ? 'mal' : ''}`} role={critica ? 'alert' : 'status'}>
      <b>{critica ? 'CAI: acción urgente' : 'CAI por vencer o agotarse'}</b>
      <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>{lista.map((a) => <li key={a.clave}>{a.mensaje}</li>)}</ul>
      {alcance !== 'grupo' && <div style={{ marginTop: 6 }}><Link to={`/${empresa}/cai`}>Abrir CAI / Emisión</Link></div>}
    </div>
  );
}
