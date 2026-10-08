import { useEffect, useState } from 'react';
import { get, qs } from '../api.js';

/** Imprime renglones de ticket en la térmica con el mismo mecanismo de la factura (.ticket-print + window.print). */
export function useTicket() {
  const [lineas, setLineas] = useState(null);
  useEffect(() => {
    if (!lineas) return undefined;
    const t = setTimeout(() => { window.print(); setLineas(null); }, 150);
    return () => clearTimeout(t);
  }, [lineas]);
  return [setLineas, lineas ? <pre className="ticket-print">{lineas.join('\n')}</pre> : null];
}

export const pedirTicketCierre = async (id, columnas = 42) => (await get(`/pos/cierres/${id}/ticket${qs({ columnas })}`)).lineas;
