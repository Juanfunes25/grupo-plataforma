import { useEffect } from 'react';

// En celular (≤640 px) las tablas de datos se muestran como tarjetas apiladas (etiqueta: valor) en vez de obligar
// a desplazarse de lado. Se marca cada <td> con el texto de su encabezado (data-etq) y la tabla con data-tarjetas;
// el CSS (estilos.css) hace el resto. Excluidas: tablas con celdas combinadas (rowspan), mapas de calor (.calor)
// o las que lleven la clase `tabla-fija`.
export default function TablasResponsivas() {
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)');
    let pendiente = 0;
    const marcar = (t) => {
      if (t.classList.contains('calor') || t.classList.contains('tabla-fija') || t.closest('.ticket-print, .tabla-fija')) return;
      if (t.querySelector('[rowspan]')) { t.removeAttribute('data-tarjetas'); return; }
      const cab = t.tHead?.rows[t.tHead.rows.length - 1];
      if (!cab || cab.cells.length < 2) return;
      const etq = [...cab.cells].flatMap((c) => Array(c.colSpan || 1).fill((c.textContent || '').trim()));
      for (const fila of t.querySelectorAll('tbody tr, tfoot tr')) {
        let i = 0;
        for (const c of fila.cells) {
          const txt = etq[i] ?? '';
          if (c.dataset.etq !== txt) c.dataset.etq = txt;
          i += c.colSpan || 1;
        }
      }
      if (!t.hasAttribute('data-tarjetas')) t.setAttribute('data-tarjetas', '');
    };
    const pasar = () => { pendiente = 0; if (mq.matches) document.querySelectorAll('.tabla-wrap table, .tarjeta table').forEach(marcar); };
    const programar = () => { if (!pendiente) pendiente = requestAnimationFrame(pasar); };
    const obs = new MutationObserver(programar);
    obs.observe(document.getElementById('raiz') ?? document.body, { childList: true, subtree: true });
    mq.addEventListener?.('change', programar);
    programar();
    return () => { obs.disconnect(); mq.removeEventListener?.('change', programar); cancelAnimationFrame(pendiente); };
  }, []);
  return null;
}
