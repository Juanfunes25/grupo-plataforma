import { useEffect, useMemo, useState } from 'react';
import { DENOMINACIONES_EFECTIVO, lempiras } from '@grupo/shared';
import { Modal } from '../ui/kit.jsx';

const redondear = (n) => Math.round(n * 100) / 100;

/** Cobro con pagos mixtos. Calcula falta y cambio en vivo; el servidor valida de nuevo. */
export default function CobroModal({ total, formas, cliente, onCobrar, onCerrar, ocupado, error, requiereRtn = false, avisoRtn = false, umbralRtn = 10000 }) {
  const efectivo = formas.find((f) => f.tipo === 'efectivo');
  const [pagos, setPagos] = useState([]);                 // [{forma_pago_id, monto, referencia}]
  const [actual, setActual] = useState(efectivo?.id ?? formas[0]?.id);
  const [monto, setMonto] = useState('');

  const recibido = redondear(pagos.reduce((s, p) => s + p.monto, 0));
  const falta = redondear(Math.max(0, total - recibido));
  const cambio = redondear(Math.max(0, recibido - total));
  const tipoDe = (id) => formas.find((f) => f.id === id)?.tipo;
  const otros = redondear(pagos.filter((p) => tipoDe(p.forma_pago_id) !== 'efectivo').reduce((s, p) => s + p.monto, 0));
  const valido = recibido >= total && otros <= total && pagos.length > 0 && !requiereRtn;
  const montoNum = parseFloat(monto);

  const agregar = (m, forma = actual, ref = null) => {
    if (!(m > 0)) return;
    setPagos((p) => [...p, { forma_pago_id: forma, monto: redondear(m), referencia: ref }]);
    setMonto('');
  };
  const sugerido = useMemo(() => (falta > 0 ? falta : 0), [falta]);
  // Enter confirma (igual que en Italo); Esc cierra desde el Modal. No se confirma si el foco está en un campo de texto de referencia.
  useEffect(() => {
    const f = (e) => { if (e.key === 'Enter' && valido && !ocupado && e.target.tagName !== 'BUTTON') { e.preventDefault(); onCobrar(pagos); } };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [valido, ocupado, pagos, onCobrar]);
  // Billetes rápidos: los tres más chicos que cubren lo que falta (como el POS de Italo) + "Exacto".
  const rapidos = DENOMINACIONES_EFECTIVO.filter((d) => d >= (sugerido || total)).slice(0, 3);

  return (
    <Modal titulo="Cobrar" onCerrar={onCerrar} tam="ancho"
      pie={<>
        <button className="btn fantasma" onClick={onCerrar}>Volver</button>
        <button className="btn primario grande" disabled={!valido || ocupado} onClick={() => onCobrar(pagos)}>{ocupado ? 'Cobrando…' : `Confirmar cobro ${lempiras(total)} (Enter)`}</button>
      </>}>
      {requiereRtn && <div className="aviso-caja mal" role="alert">Esta venta supera L {umbralRtn.toLocaleString('es-HN')}: hace falta el RTN del cliente antes de cobrar. Cierra esta ventana y elige o crea el cliente.</div>}
      {avisoRtn && <div className="aviso-caja" role="note">Recordatorio: esta venta supera L {umbralRtn.toLocaleString('es-HN')} y el cliente no tiene RTN. Pídelo si puedes; puedes cobrar igual (queda constancia para el administrador).</div>}
      <div className="rejilla cols-3">
        <div className="kpi acento"><div className="etq">Total a cobrar</div><div className="val">{lempiras(total)}</div><div className="sub">{cliente?.nombre ?? 'Consumidor final'}{cliente?.rtn ? ` · RTN ${cliente.rtn}` : ''}</div></div>
        <div className="kpi"><div className="etq">Recibido</div><div className="val">{lempiras(recibido)}</div></div>
        <div className="kpi" style={{ borderColor: cambio > 0 ? 'var(--ok)' : falta > 0 ? 'var(--aviso)' : undefined }}>
          <div className="etq">{cambio > 0 ? 'Cambio a entregar' : 'Falta'}</div><div className="val" style={{ color: cambio > 0 ? 'var(--ok)' : falta > 0 ? 'var(--aviso)' : undefined }}>{lempiras(cambio > 0 ? cambio : falta)}</div>
        </div>
      </div>

      <div className="fila">
        {formas.map((f) => (
          <button key={f.id} className="btn grande" aria-pressed={actual === f.id} onClick={() => { setActual(f.id); setMonto(''); }}
            style={actual === f.id ? { background: 'var(--acento)', borderColor: 'transparent', color: '#fff' } : undefined}>{f.nombre}</button>
        ))}
      </div>

      <div className="rejilla" style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
        <input inputMode="decimal" placeholder={`Monto en ${formas.find((f) => f.id === actual)?.nombre ?? ''} (vacío = lo que falta)`} value={monto} onChange={(e) => setMonto(e.target.value.replace(/[^\d.]/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && (montoNum > 0 || sugerido > 0)) { e.preventDefault(); e.stopPropagation(); agregar(montoNum > 0 ? montoNum : sugerido); } }} style={{ fontSize: '1.3rem', minHeight: 54 }} />
        <button className="btn primario grande" disabled={!(montoNum > 0) && !(sugerido > 0)} onClick={() => agregar(montoNum > 0 ? montoNum : sugerido)}>Agregar pago</button>
      </div>
      {tipoDe(actual) === 'efectivo' && (
        <div className="fila">
          <button className="btn" onClick={() => agregar(sugerido || total)}>Exacto {lempiras(sugerido || total)}</button>
          {rapidos.map((b) => <button key={b} className="btn" onClick={() => agregar(b)}>L {b}</button>)}
          {DENOMINACIONES_EFECTIVO.filter((b) => !rapidos.includes(b) && b < (sugerido || total)).length > 0 && <small>o escribe el monto recibido</small>}
        </div>
      )}
      {tipoDe(actual) !== 'efectivo' && pagos.length === 0 && <small>Para tarjeta o transferencia pulsa “Agregar pago” (cobra lo que falta) o escribe un monto parcial.</small>}

      {pagos.length > 0 && (
        <div className="tarjeta pad0">
          <table><tbody>
            {pagos.map((p, i) => (
              <tr key={i}>
                <td>{formas.find((f) => f.id === p.forma_pago_id)?.nombre}</td>
                <td>{tipoDe(p.forma_pago_id) !== 'efectivo' && <input placeholder="Autorización / referencia" value={p.referencia ?? ''} onChange={(e) => setPagos((x) => x.map((y, j) => (j === i ? { ...y, referencia: e.target.value } : y)))} style={{ minHeight: 34 }} />}</td>
                <td className="der num"><b>{lempiras(p.monto)}</b></td>
                <td className="der"><button className="btn chico fantasma" onClick={() => setPagos((x) => x.filter((_, j) => j !== i))} aria-label="Quitar">✕</button></td>
              </tr>
            ))}
          </tbody></table>
        </div>
      )}
      {otros > total && <div className="aviso-caja mal">Tarjeta/transferencia no puede ser mayor al total.</div>}
      {error && <div className="aviso-caja mal" role="alert">{error}</div>}
    </Modal>
  );
}
