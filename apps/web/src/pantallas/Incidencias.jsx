import { useState } from 'react';
import { useSesion } from '../sesion.jsx';
import { Lista, Reportar } from '../rinv/IncidenciasPanel.jsx';
import '../rinv/rinv.css';

/** Incidencias: reportes con foto de las sucursales. La tienda reporta; fábrica (inventario/producción) revisa y cierra. */
export default function Incidencias() {
  const { puede } = useSesion();
  const gestiona = puede('rep:inventario') || puede('rep:producir');
  const [reportando, setReportando] = useState(!gestiona);
  const [hecho, setHecho] = useState(0);
  return (
    <div className="pagina">
      <div className="encabezado-pagina"><h1>Incidencias</h1></div>
      {reportando ? <Reportar onCancelar={gestiona ? () => setReportando(false) : null} onListo={() => { setHecho((h) => h + 1); if (gestiona) setReportando(false); }} />
        : <Lista key={hecho} onReportar={() => setReportando(true)} />}
      {!gestiona && hecho > 0 && <div className="aviso-caja ok">Listo, quedó reportado. Gracias: fábrica lo va a revisar. Puedes reportar otra cosa.</div>}
    </div>
  );
}
