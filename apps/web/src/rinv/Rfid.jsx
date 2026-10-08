import { useEffect, useRef, useState } from 'react';
import { useAviso } from '../ui/kit.jsx';
import { rget, rpatch, rpost } from './api.js';
import { Chip, cuando } from './comun.jsx';
import { MODOS, useLector } from './rfid/useLector.js';
import { consejoParaError, grabarYConfirmar } from './rfid/grabacion.js';
import { analizarContinuo, analizarUnTag, cambiosPendientes } from './rfid/diagnostico.js';
import { extraerListaDeEpcs } from './rfid/importar.js';
import { esZip, xlsxATexto } from './rfid/leerXlsx.js';
import { separarDudosas } from './rfid/largos.js';

const queEs = (t) => t.etiqueta || (t.sabor_nombre ? `${t.sabor_nombre}${t.fecha ? ` · tanda del ${t.fecha}` : ''}` : t.insumo_nombre ? `${t.insumo_nombre}${t.fecha_ingreso ? ` · lote ${t.fecha_ingreso}` : ''}` : `tag …${t.epc.slice(-6)}`);
const EVENTOS = { registrado: 'Registrado', grabado: 'Grabado', grabacion_fallida: 'Grabación fallida', asignado: 'Asignado', liberado: 'Liberado', movido: 'Movido', ubicado: 'Ubicado', no_detectado: 'No detectado', baja: 'Dado de baja' };
const TONO = { asignado: 'ok', disponible: 'aviso', nuevo: '', baja: 'mal' };

const textoDeEstado = (estado, detalle, lecturas, modo) => ({
  desconectado: 'Sin lector conectado', conectando: detalle || 'Buscando lector…', listo: `Lector listo · ${modo}`,
  escaneando: `Escaneando… ${lecturas.cantidad} ${lecturas.cantidad === 1 ? 'etiqueta detectada' : 'etiquetas detectadas'}`, escribiendo: 'Escribiendo tag… no lo muevas', error: detalle || 'El lector tuvo un problema',
}[estado] ?? estado);

// ── Asistente y guía del lector SR160 ────────────────────────────────────────
function capturar(lector, { esperaMs = 15000, silencioMs = 900, maximoMs = 12000 } = {}) {
  let cancelar = () => {};
  const promesa = new Promise((resolver) => {
    const crudos = []; let silencio = null; let maximo = null; let quitar = () => {};
    const fin = () => { clearTimeout(limite); clearTimeout(silencio); clearTimeout(maximo); quitar(); resolver(crudos); };
    const limite = setTimeout(fin, esperaMs);
    cancelar = () => { crudos.length = 0; fin(); };
    quitar = lector.on('crudo', (c) => { crudos.push(c); clearTimeout(limite); if (!maximo) maximo = setTimeout(fin, maximoMs); clearTimeout(silencio); silencio = setTimeout(fin, silencioMs); });
  });
  return { promesa, cancelar: () => cancelar() };
}
function ResultadoPrueba({ r }) {
  return (
    <div className={`aviso-caja ${r.estado === 'ok' ? 'ok' : r.estado === 'sin_datos' ? 'mal' : ''}`}>
      <b>{r.estado === 'ok' ? '✓' : r.estado === 'sin_datos' ? '✗' : '!'} {r.titulo}</b>
      <div>{r.detalle}</div>
      {r.ajustes.length > 0 && <ul>{r.ajustes.map((a) => <li key={a.opcion}><b>{a.opcion}</b> → <b>{a.valor}</b><div className="rv-nota">{a.porque}</div></li>)}</ul>}
    </div>
  );
}
function AsistenteLector({ lector }) {
  const [activa, setActiva] = useState(null); const [uno, setUno] = useState(null); const [varios, setVarios] = useState(null); const cap = useRef(null);
  useEffect(() => () => cap.current?.cancelar(), []);
  async function probar(cual) {
    const l = lector.lector.current; if (!l) return;
    setActiva(cual);
    cap.current = capturar(l, cual === 'uno' ? { silencioMs: 900, maximoMs: 3000 } : { silencioMs: 2000, maximoMs: 12000 });
    const crudos = await cap.current.promesa; cap.current = null;
    if (cual === 'uno') setUno(analizarUnTag(crudos)); else setVarios(analizarContinuo(crudos));
    setActiva(null);
  }
  const cambios = cambiosPendientes(uno, varios);
  const bien = uno?.estado === 'ok' && (varios?.estado === 'ok' || varios?.estado === 'parcial');
  const Paso = ({ n, texto, cual, res }) => (
    <div className="rejilla" style={{ gap: 6 }}>
      <b>{n}. {texto}</b>
      {activa === cual ? <div className="fila"><span className="tenue">Esperando… aprieta el gatillo.</span><button className="btn chico" onClick={() => cap.current?.cancelar()}>Cancelar</button></div>
        : <button className="btn chico" disabled={activa !== null} onClick={() => probar(cual)}>{res ? `Repetir la prueba ${n}` : `Empezar la prueba ${n}`}</button>}
      {res && <ResultadoPrueba r={res} />}
    </div>
  );
  return (
    <div className="tarjeta rejilla">
      <h3>Asistente del lector</h3>
      <p className="tenue">¿Tu lector está bien configurado? Haz estas dos pruebas y te digo qué cambiar. Antes, revisa que el <b>botón amarillo de atrás</b> esté en <b>RFID</b>.</p>
      <Paso n={1} texto="Leer un tag (acerca UN tag y aprieta el gatillo una vez)" cual="uno" res={uno} />
      <Paso n={2} texto="Leer varios sin soltar (3 o más tags juntos, gatillo apretado unos 4 segundos)" cual="varios" res={varios} />
      {bien && <div className="aviso-caja ok"><b>✓ Tu lector está listo.</b> Ve a «Inventario freezer», elige la sección y toca «Empezar a escanear».</div>}
      {cambios.length > 0 && <div className="aviso-caja"><b>Cambia esto en el lector ({cambios.length}):</b><ul>{cambios.map((a) => <li key={a.opcion}><b>{a.opcion}</b> → <b>{a.valor}</b></li>)}</ul>
        <p>En una PC con Windows, conecta el lector por USB, abre <b>UHFAPP.exe</b>, pestaña <b>User Settings</b>, doble clic en cada opción, cambia el valor y toca <b>Set</b>. Luego vuelve a emparejarlo con la tablet y repite las pruebas.</p></div>}
    </div>
  );
}
const CONFIG = [['mode', '3', 'Teclado Bluetooth continuo (2 = un código por apretón; 1 = teclado USB).'], ['inventory', '1', 'Inventario RFID continuo: lee sin parar mientras sostienes el gatillo.'], ['key_mode', '1', 'Gatillo continuo.'],
  ['new_line', '2', 'Un Enter después de cada código: así se separa un tag del siguiente.'], ['data_bank', '0', 'Manda solo el EPC (sin el TID).'], ['epc_format', '1', 'Hexadecimal en mayúsculas.'], ['pointer, length', '0, 0', 'Sin recortes.'],
  ['prefix, suffix', 'vacíos', 'Sin texto extra.'], ['user_addr, user_len', '0, 0', 'No se usa.'], ['keymap', '0 (US)', 'Distribución del teclado.'], ['idle', '30', 'Minutos sin uso antes de desconectar el Bluetooth.'], ['power', '23', 'Potencia (5 a 30). No se toca: define el alcance de ~30 cm.'], ['buzzer', '1', 'Pitido al leer.']];
function GuiaConfiguracion() {
  return (
    <details className="tarjeta"><summary>Cómo está configurado tu lector (avanzado)</summary>
      <p className="rv-nota">Valores que quedaron en el lector (verificados con el programa de Chainway el 7 de octubre). El SR160 (firmware V3.0.6) tiene solo estas 16 opciones: <b>no tiene filtro de repetidos</b>, así que la app quita los repetidos por su cuenta.</p>
      <div className="tabla-wrap"><table><thead><tr><th>Opción</th><th>Valor</th></tr></thead><tbody>{CONFIG.map(([o, v, n]) => <tr key={o}><td>{o}<div className="rv-nota">{n}</div></td><td>{v}</td></tr>)}</tbody></table></div>
      <p className="rv-nota"><b>Para cambiar algo</b> hay que usar el programa de Chainway (UHFAPP.exe) en una PC con Windows y el cable USB. Desde el navegador no se puede cambiar ni grabar el chip.</p>
    </details>
  );
}
function Diagnostico({ crudos }) {
  return (
    <details className="tarjeta"><summary>Ver lo que llega del lector (técnico)</summary>
      {crudos.length === 0 ? <div className="aviso-caja">Todavía no llegó nada. Si ya apretaste el gatillo, el lector <b>no está mandando teclas</b>: revisa el <b>botón amarillo de atrás</b> (RFID, luz encendida) o el modo teclado (HID) del emparejamiento.</div>
        : crudos.map((c) => <div key={c.hora} className="fila espacio"><span className="rv-epc">{c.texto}{c.veces > 1 ? ` ×${c.veces}` : ''}</span><Chip tono={c.aceptado ? 'ok' : 'mal'}>{c.aceptado ? '✓ válido' : `✗ ${c.motivo}`}</Chip></div>)}
    </details>
  );
}
function BarraLector({ lector }) {
  const { modo, estado, detalle, error, lecturas } = lector;
  const conectado = ['listo', 'escaneando', 'escribiendo'].includes(estado);
  return (
    <div className="rejilla">
      <div className="tarjeta fila">
        <span className={`rv-punto ${estado}`} />
        <div style={{ flex: 1, minWidth: 0 }}><b>{textoDeEstado(estado, detalle, lecturas, MODOS[modo]?.nombre || '')}</b>
          {lecturas.crudas > 0 && estado === 'escaneando' && <div className="rv-nota">{lecturas.crudas.toLocaleString('es-HN')} lecturas agrupadas en {lecturas.cantidad}</div>}</div>
        {conectado && <button className="btn chico" onClick={lector.desconectar}>Desconectar</button>}
      </div>
      {!conectado && estado !== 'conectando' && (
        <div className="rv-pills">{Object.values(MODOS).map((m) => <button key={m.id} className="btn" disabled={!m.disponible()} onClick={() => lector.conectar(m.id)}>{m.id === 'teclado' ? '⌨️' : '🧪'} {m.nombre}</button>)}</div>
      )}
      {modo === 'teclado' && conectado && <><details className="tarjeta"><summary>Asistente del lector: probar que lee bien</summary><AsistenteLector lector={lector} /></details><Diagnostico crudos={lector.crudos} /><GuiaConfiguracion /></>}
      {error && <div className="aviso-caja mal" onClick={lector.limpiarError}><b>{error.message}</b>{consejoParaError(error) && <div className="rv-nota">{consejoParaError(error)}</div>}</div>}
    </div>
  );
}

// ── Inventario de freezer: registrar / revisar ───────────────────────────────
function LecturaEnVivo({ lista }) {
  const [info, setInfo] = useState(() => new Map()); const [ahora, setAhora] = useState(Date.now());
  const pedidos = useRef(new Set()); const montado = useRef(true);
  useEffect(() => { montado.current = true; return () => { montado.current = false; }; }, []);
  useEffect(() => { const id = setInterval(() => setAhora(Date.now()), 500); return () => clearInterval(id); }, []);
  useEffect(() => {
    const nuevos = lista.map((f) => f.epc).filter((e) => !pedidos.current.has(e));
    if (!nuevos.length) return;
    nuevos.forEach((e) => pedidos.current.add(e));
    (async () => {
      for (let i = 0; i < nuevos.length; i += 300) {
        const trozo = nuevos.slice(i, i + 300);
        try {
          const { tags } = await rpost('/rfid/consulta', { epcs: trozo });
          if (!montado.current) return;
          const conocidos = new Map(tags.map((t) => [t.epc, t]));
          setInfo((p) => { const m = new Map(p); for (const e of trozo) m.set(e, conocidos.get(e) || null); return m; });
        } catch { trozo.forEach((e) => pedidos.current.delete(e)); }
      }
    })();
  }, [lista]);
  if (!lista.length) return null;
  const grupos = new Map(); let sinRegistrar = 0; let buscando = 0;
  for (const f of lista) {
    const t = info.get(f.epc);
    if (t === undefined) { buscando += 1; continue; }
    if (t === null) { sinRegistrar += 1; continue; }
    const k = t.sabor_nombre ? `🍨 ${t.sabor_nombre}` : t.insumo_nombre ? `📦 ${t.insumo_nombre}` : t.etiqueta ? `🏷️ ${t.etiqueta}` : '🏷️ Tag sin producto';
    grupos.set(k, (grupos.get(k) || 0) + 1);
  }
  const seg = Math.max(0, Math.round((ahora - Math.max(...lista.map((f) => f.primera))) / 1000));
  return (
    <div className="rejilla" style={{ gap: 4 }}>
      <b>Lo que llevas leído:</b>
      {[...grupos.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => <div key={n} className="fila espacio"><span>{n}</span><b>{c}</b></div>)}
      {sinRegistrar > 0 && <div className="fila espacio"><span>Sin registrar todavía</span><b>{sinRegistrar}</b></div>}
      {buscando > 0 && <div className="rv-nota">Identificando {buscando}…</div>}
      <div className="centro rv-nota">{seg >= 6 ? <b style={{ color: 'var(--ok)' }}>✓ Hace {seg} s que no aparece ningún tag nuevo: parece que ya leíste todos.</b> : `Último tag nuevo hace ${seg} s`}</div>
    </div>
  );
}
function ImportarLista({ deshabilitado, accion, alUsar }) {
  const [texto, setTexto] = useState(''); const [err, setErr] = useState('');
  const { epcs, ignorados, columna } = extraerListaDeEpcs(texto);
  async function archivo(e) {
    const a = e.target.files?.[0]; e.target.value = ''; if (!a) return;
    setErr('');
    try { const b = new Uint8Array(await a.arrayBuffer()); setTexto(esZip(b) ? await xlsxATexto(b) : new TextDecoder().decode(b)); } catch (x) { setErr(x.message); }
  }
  return (
    <details className="tarjeta"><summary>¿Escaneaste con la app de Chainway? Importa la lista</summary>
      <p className="rv-nota">La app de Chainway lee sin parar y junta todos los tags. Pega su lista de códigos o sube el archivo que exporta (Excel, CSV o TXT).</p>
      <textarea rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'E28011606000020500000001\nE28011606000020500000002'} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '.75rem' }} />
      <div className="fila"><label className="btn chico">Subir archivo<input type="file" hidden accept=".xls,.xlsx,.csv,.txt,text/csv,text/plain" onChange={archivo} /></label>{texto && <button className="btn chico fantasma" onClick={() => setTexto('')}>Borrar</button>}</div>
      {err && <div className="aviso-caja mal">{err}</div>}
      {texto && <p className="rv-nota">{epcs.length ? <><b>{epcs.length} código{epcs.length === 1 ? '' : 's'} encontrado{epcs.length === 1 ? '' : 's'}</b>{columna ? ` (columna «${columna}»)` : ''}{ignorados ? ` · ${ignorados} datos ignorados` : ''}.</> : 'No encontré ningún código EPC en ese texto (16 a 64 caracteres hexadecimales).'}</p>}
      <button className="btn primario bloque" disabled={deshabilitado || !epcs.length} onClick={() => { alUsar(epcs); setTexto(''); }}>{accion === 'registrar' ? `Registrar ${epcs.length || ''} en esta sección` : `Comparar ${epcs.length || ''} con esta sección`}</button>
    </details>
  );
}
function FormSeccion({ valor, cambiar, guardar }) {
  return (
    <form className="rejilla" onSubmit={guardar}>
      <input value={valor.freezer} onChange={(e) => cambiar({ ...valor, freezer: e.target.value })} placeholder="Freezer (ej: Freezer fábrica 1)" />
      <input value={valor.seccion} onChange={(e) => cambiar({ ...valor, seccion: e.target.value })} placeholder="Sección (ej: Estante 1)" />
      <details><summary>Avanzado: qué tan al fondo queda</summary><input type="number" min={0} max={99} value={valor.orden_salida} onChange={(e) => cambiar({ ...valor, orden_salida: Number(e.target.value) })} /><p className="rv-nota">0 = junto a la puerta. Solo sirve para el aviso de «producto viejo al fondo».</p></details>
      <button className="btn primario" type="submit" disabled={!valor.freezer.trim() || !valor.seccion.trim()}>Guardar sección</button>
    </form>
  );
}
function Resultado({ r, alMover }) {
  const s = r.resumen;
  const bien = !s.faltantes && !s.equivocados && !s.desconocidos && !r.fifo.length;
  const Sec = ({ t, items, children }) => items.length > 0 && <div className="tarjeta rejilla"><h3>{t} ({items.length})</h3>{children}</div>;
  return (
    <div className="rejilla">
      <div className="rejilla cols-4">
        <div className="rv-dato"><b>{s.leidos}</b>etiquetas leídas</div>
        <div className="rv-dato bien"><b>{s.correctos}</b>de {s.esperados} esperadas, en su lugar</div>
        <div className={`rv-dato ${s.faltantes ? 'alerta' : 'bien'}`}><b>{s.faltantes}</b>no aparecieron</div>
        <div className={`rv-dato ${s.equivocados ? 'alerta' : 'bien'}`}><b>{s.equivocados}</b>de otro freezer</div>
      </div>
      {bien && <div className="aviso-caja ok">Todo coincide: lo que hay en «{r.ubicacion.nombre}» es lo que el sistema esperaba y el orden de salida está bien.</div>}
      <Sec t="Orden de salida (FIFO)" items={r.fifo}>{r.fifo.map((a, i) => <p key={i}>{a.tipo === 'vejez' ? '⏳' : '↕️'} {a.mensaje}</p>)}</Sec>
      <Sec t="No aparecieron" items={r.faltantes}>{r.faltantes.map((f) => <p key={f.tag.id}><b>{queEs(f.tag)}</b><br /><span className="rv-nota">{f.confirmado ? `No apareció en ${f.faltas_seguidas} barridos seguidos: probablemente no está.` : 'Primera vez que no aparece. Una lectura sola puede fallar por escarcha o ángulo: repite el barrido antes de darla por perdida.'}</span></p>)}</Sec>
      <Sec t="Registradas en otro lugar" items={r.equivocados}>{r.equivocados.map((e) => <div key={e.tag.id} className="fila espacio"><span><b>{queEs(e.tag)}</b><br /><span className="rv-nota">Figura en «{e.registrada_en}»</span></span><button className="btn chico" onClick={() => alMover(e.tag.id)}>Está aquí</button></div>)}</Sec>
      <Sec t="Ubicadas por primera vez aquí" items={r.sinUbicacion}>{r.sinUbicacion.map((x) => <div key={x.tag.id} className="rv-nota">{queEs(x.tag)}</div>)}</Sec>
      <Sec t="Con formato nuestro pero que no conozco" items={r.desconocidos}>{r.desconocidos.map((x) => <div key={x.epc} className="rv-epc">{x.epc}</div>)}<p className="rv-nota">Pueden ser tags grabados en otro equipo o borrados del sistema.</p></Sec>
      {r.libres.length + r.dadosDeBaja.length > 0 && <p className="rv-nota">También vi {r.libres.length} tag(s) libres y {r.dadosDeBaja.length} dado(s) de baja.{r.dadosDeBaja.length ? ' Un tag de baja que sigue leyéndose conviene retirarlo.' : ''}</p>}
      {r.ajenos > 0 && <p className="rv-nota">Ignoré {r.ajenos} lectura(s) de etiquetas que no son nuestras.</p>}
      {r.correctos.length > 0 && <details><summary>En su lugar ({r.correctos.length})</summary>{r.correctos.map((c) => <div key={c.tag.id} className="rv-nota">✓ {queEs(c.tag)}</div>)}</details>}
      <p className="rv-nota">Con 30 cm de alcance, el lector confirma la sección, no la posición exacta dentro de ella.</p>
    </div>
  );
}
function Freezer({ lector }) {
  const avisar = useAviso();
  const [ubs, setUbs] = useState([]); const [ub, setUb] = useState(''); const [res, setRes] = useState(null); const [reg, setReg] = useState(null);
  const [enviando, setEnviando] = useState(false); const [error, setError] = useState(''); const [nueva, setNueva] = useState(null); const [accion, setAccion] = useState('registrar'); const [dudosas, setDudosas] = useState([]);
  async function cargar() { try { const u = await rget('/rfid/ubicaciones'); setUbs(u); setUb((a) => a || u[0]?.id || ''); } catch (e) { setError(e.message); } }
  useEffect(() => { cargar(); }, []);
  const { estado, lecturas, modo } = lector; const conectado = ['listo', 'escaneando'].includes(estado); const escaneando = estado === 'escaneando';
  async function procesar(l) {
    setEnviando(true); setError('');
    try { if (accion === 'registrar') setReg(await rpost(`/rfid/ubicaciones/${ub}/registrar`, { lecturas: l })); else setRes(await rpost('/rfid/auditorias', { ubicacion_id: ub, lecturas: l })); }
    catch (e) { setError(e.message); } finally { setEnviando(false); }
  }
  async function terminar() { await lector.detenerEscaneo(); const { buenas, dudosas: d } = separarDudosas(lector.paraEnviar()); setDudosas(d); await procesar(buenas); }
  async function usarLista(epcs) { setRes(null); setReg(null); await procesar(epcs.map((epc) => ({ epc, rssi: null, lecturas: 1 }))); }
  async function mover(id) {
    try { await rpost(`/rfid/tags/${id}/mover`, { ubicacion_id: ub }); avisar('Traslado confirmado'); setRes((r) => ({ ...r, equivocados: r.equivocados.filter((e) => e.tag.id !== id), resumen: { ...r.resumen, equivocados: r.resumen.equivocados - 1 } })); } catch (e) { avisar(e.message, 'mal'); }
  }
  async function demo() {
    const { tags } = await rget('/rfid/tags?estado=asignado');
    const aca = tags.filter((t) => t.ubicacion_id === ub).map((t) => t.epc);
    lector.lector.current?.ponerTags([...aca.slice(0, Math.max(0, aca.length - 1)), 'E2801160600002059999AAAA']);
    avisar(aca.length ? 'Demo: una de las bandejas esperadas no está frente al lector' : 'Demo: sección sin tags registrados todavía');
  }
  async function crear(e) {
    e.preventDefault();
    try { const u = await rpost('/rfid/ubicaciones', nueva); setNueva((n) => ({ freezer: n.freezer, seccion: '', orden_salida: n.orden_salida })); await cargar(); setUb(u.id); setError(''); } catch (x) { setError(x.message); }
  }
  const freezers = [...new Set(ubs.map((u) => u.freezer))];
  return (
    <div className="rejilla">
      {!ubs.length ? (
        <div className="tarjeta rejilla"><b>Primero crea una sección de freezer</b><p className="rv-nota">Una sección es el lugar donde pasas el lector: por ejemplo el freezer «Fábrica 1», sección «Estante 1». Si el freezer es chico, con una sección alcanza.</p>
          <FormSeccion valor={nueva || { freezer: '', seccion: '', orden_salida: 0 }} cambiar={setNueva} guardar={crear} /></div>
      ) : (
        <div className="tarjeta rejilla">
          <label>¿Qué sección vas a revisar?<select value={ub} disabled={escaneando} onChange={(e) => { setUb(e.target.value); setRes(null); setReg(null); }}>
            {freezers.map((f) => <optgroup key={f} label={f}>{ubs.filter((u) => u.freezer === f).map((u) => <option key={u.id} value={u.id}>{u.nombre.replace(`${f} · `, '')}{u.orden_salida === 0 ? ' (junto a la puerta)' : ''}</option>)}</optgroup>)}</select></label>
          {!escaneando && (
            <>
              <div className="rv-pills"><button className={`btn ${accion === 'registrar' ? 'primario' : ''}`} onClick={() => setAccion('registrar')}>Registrar tags en esta sección</button><button className={`btn ${accion === 'revisar' ? 'primario' : ''}`} onClick={() => setAccion('revisar')}>Revisar qué falta</button></div>
              <p className="rv-nota">{accion === 'registrar' ? 'Pasa el lector por los tags de esta sección: quedan anotados aquí, sin necesidad de producción.' : 'Compara lo que lee el lector con los tags que el sistema tiene anotados en esta sección.'}</p>
              <button className="btn primario grande" disabled={!conectado || !ub} onClick={() => { setRes(null); setReg(null); setDudosas([]); lector.empezarEscaneo(); }}>{conectado ? 'Empezar a escanear' : 'Conecta el lector para empezar'}</button>
              <ImportarLista deshabilitado={!ub || enviando} accion={accion} alUsar={usarLista} />
              {modo === 'demo' && conectado && <button className="btn chico" onClick={demo}>Demo: poner bandejas frente al lector</button>}
            </>
          )}
        </div>
      )}
      {escaneando && (
        <div className="tarjeta rejilla"><div className="rv-contador">{lecturas.cantidad}</div><div className="centro">{lecturas.cantidad === 1 ? 'etiqueta detectada' : 'etiquetas detectadas'}</div>
          <p className="rv-nota centro">{modo === 'teclado' ? 'Mantén apretado el gatillo apuntando a los tags: lee todos de corrido. Cuando deje de aparecer alguno nuevo, toca el botón.' : 'Pasa el lector a unos 30 cm de cada bandeja, despacio. Al terminar, toca el botón.'}</p>
          <LecturaEnVivo lista={lecturas.lista} />
          {lecturas.saturado && <div className="aviso-caja">Se llegó al máximo de etiquetas distintas: puede haber lecturas de equipos ajenos. Revisa la potencia del lector.</div>}
          <button className="btn primario grande" onClick={terminar}>{accion === 'registrar' ? 'Terminar y registrar' : 'Terminar y comparar'}</button></div>
      )}
      {dudosas.length > 0 && !escaneando && <div className="aviso-caja"><b>Aparté {dudosas.length} lectura{dudosas.length === 1 ? '' : 's'} que parece{dudosas.length === 1 ? '' : 'n'} incompleta{dudosas.length === 1 ? '' : 's'}.</b> Miden distinto que los demás códigos (por Bluetooth se puede perder una tecla); no las registré para no crear tags falsos. Vuelve a leer esos tags.{dudosas.map((d) => <div key={d.epc} className="rv-epc">{d.epc}</div>)}</div>}
      {enviando && <p className="rv-nota">{accion === 'registrar' ? 'Registrando…' : 'Comparando con lo que esperaba el sistema…'}</p>}
      {reg && !escaneando && <div className="aviso-caja ok"><b>{reg.leidos} {reg.leidos === 1 ? 'tag' : 'tags'} en «{reg.ubicacion.nombre}»</b><div>{reg.nuevos} nuevos · {reg.ya_estaban} ya estaban · {reg.movidos} venían de otra sección{reg.dados_de_baja ? ` · ${reg.dados_de_baja} de baja (no se reactivan solos)` : ''}{reg.ajenos ? ` · ${reg.ajenos} lecturas ajenas ignoradas` : ''}.</div></div>}
      {error && <div className="aviso-caja mal">{error}</div>}
      {res && !escaneando && <Resultado r={res} alMover={mover} />}
      {ubs.length > 0 && <details open={nueva !== null}><summary onClick={(e) => { e.preventDefault(); setNueva((n) => (n === null ? { freezer: freezers[0] || '', seccion: '', orden_salida: 0 } : null)); }}>Agregar otra sección o freezer</summary>{nueva && <div className="tarjeta"><FormSeccion valor={nueva} cambiar={setNueva} guardar={crear} /></div>}</details>}
    </div>
  );
}

// ── Grabar / vincular ────────────────────────────────────────────────────────
const TIPOS = [{ id: 'helado', icono: '🍨', nombre: 'Sabor de helado' }, { id: 'insumo', icono: '📦', nombre: 'Insumo' }, { id: 'bandeja', icono: '🧺', nombre: 'Bandeja (tag fijo)' }];
const PASOS = [['buscando', 'Buscando el tag'], ['reservando', 'Reservando el código'], ['escribiendo', 'Escribiendo en el chip'], ['verificando', 'Verificando que quedó bien'], ['confirmando', 'Guardando']];
const aleatorio = () => `E28011606000020500${Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')}`;
/**
 * Con el lector en modo teclado NO se puede escribir en el chip (solo manda lo que lee), pero tampoco hace falta: cada tag
 * ya trae un código único de fábrica. En ese caso «Vincular» lo anota como de ese sabor o insumo, sin tocar el chip.
 */
function Grabar({ lector }) {
  const avisar = useAviso();
  const [tipo, setTipo] = useState('helado'); const [cat, setCat] = useState({ sabores: [], insumos: [] }); const [destino, setDestino] = useState(''); const [epc, setEpc] = useState(null);
  const [fase, setFase] = useState(null); const [intento, setIntento] = useState(0); const [error, setError] = useState(null); const [hecho, setHecho] = useState(null); const [leyendo, setLeyendo] = useState(false);
  useEffect(() => { rget('/rfid/catalogo').then(setCat).catch(() => {}); }, []);
  const conectado = ['listo', 'escaneando'].includes(lector.estado); const puedeEscribir = conectado && lector.lector.current?.puedeEscribir; const ocupado = fase !== null; const soloVincular = conectado && !puedeEscribir;
  const tipos = soloVincular ? TIPOS.filter((t) => t.id !== 'bandeja') : TIPOS;
  useEffect(() => { if (soloVincular && tipo === 'bandeja') setTipo('helado'); }, [soloVincular, tipo]);
  async function leer() {
    setError(null); setHecho(null); setEpc(null); setLeyendo(true);
    try { const e = await lector.lector.current.leerEpcsEnCampo(); if (!e.length) setError({ message: 'No se detectó ningún tag.', codigo: 'TAG_NO_ENCONTRADO' }); else if (e.length > 1) setError({ message: `Hay ${e.length} tags frente al lector.`, codigo: 'VARIOS_TAGS' }); else setEpc(e[0]); }
    catch (e) { setError(e); } finally { setLeyendo(false); }
  }
  async function vincular() {
    setError(null); setHecho(null);
    if (epc.length !== 24 && !window.confirm(`Este código mide ${epc.length} caracteres y lo normal son 24: puede haber llegado incompleto por el Bluetooth. ¿Vincularlo de todos modos?`)) return;
    setFase('vinculando');
    try {
      const { id } = await rpost('/rfid/tags/registrar', { epc });
      const cuerpo = tipo === 'helado' ? { sabor_id: destino } : { insumo_id: destino };
      let tag;
      try { tag = await rpost(`/rfid/tags/${id}/asignar`, cuerpo); }
      catch (e) {
        if (!/ya está asignado/.test(e.message)) throw e;
        if (!window.confirm('Este tag ya está vinculado a otro producto. ¿Liberarlo y vincularlo a este?')) return;
        await rpost(`/rfid/tags/${id}/liberar`); tag = await rpost(`/rfid/tags/${id}/asignar`, cuerpo);
      }
      setHecho(tag); setEpc(null); setDestino(''); avisar('Tag vinculado');
    } catch (e) { setError(e); } finally { setFase(null); }
  }
  async function grabar() {
    setError(null); setHecho(null);
    const datos = { epc_actual: epc, tipo, ...(tipo === 'helado' ? { sabor_id: destino } : tipo === 'insumo' ? { insumo_id: destino } : {}) };
    try {
      const tag = await grabarYConfirmar({ lector: lector.lector.current, api: { preparar: (d) => rpost('/rfid/escritura/preparar', d), confirmar: (d) => rpost('/rfid/escritura/confirmar', d), cancelar: (d) => rpost('/rfid/escritura/cancelar', d) }, datos, alProgreso: (f, n) => { setFase(f); if (n) setIntento(n); } });
      setHecho(tag); setEpc(null); setDestino(''); avisar('Tag grabado con éxito');
    } catch (e) { setError(e); } finally { setFase(null); setIntento(0); }
  }
  const opciones = tipo === 'helado' ? cat.sabores : tipo === 'insumo' ? cat.insumos : [];
  const listo = epc && (tipo === 'bandeja' || destino); const iFase = PASOS.findIndex(([id]) => id === fase);
  return (
    <div className="rejilla">
      <div className="rv-pills">{tipos.map((t) => <button key={t.id} className={`btn ${tipo === t.id ? 'primario' : ''}`} disabled={ocupado} onClick={() => { setTipo(t.id); setDestino(''); }}>{t.icono} {t.nombre}</button>)}</div>
      <div className="tarjeta rejilla">
        {tipo !== 'bandeja' ? <label>{tipo === 'helado' ? '¿Qué sabor es?' : '¿Qué insumo es?'}<select value={destino} disabled={ocupado} onChange={(e) => setDestino(e.target.value)}><option value="">Elige…</option>{opciones.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}</select></label>
          : <p className="rv-nota">Graba un código fijo que identifica a la bandeja. Después le asignas cada sabor desde la pestaña Tags, sin volver a grabar.</p>}
        <div><b>Tag frente al lector</b>{epc ? <div className="rv-epc">{epc}</div> : <div className="rv-nota">Todavía no leíste ninguno.</div>}</div>
        <div className="fila"><button className="btn" disabled={!conectado || ocupado || leyendo} onClick={leer}>{leyendo ? 'Esperando… aprieta el gatillo' : 'Leer el tag'}</button>
          {lector.modo === 'demo' && <button className="btn chico" disabled={ocupado} onClick={() => { lector.lector.current?.ponerTags([aleatorio()]); setEpc(null); avisar('Demo: tag virgen frente al lector'); }}>Demo: poner un tag nuevo</button>}</div>
        <button className="btn primario grande" disabled={!listo || !conectado || ocupado} onClick={soloVincular ? vincular : grabar}>{ocupado ? (soloVincular ? 'Vinculando…' : 'Grabando…') : soloVincular ? `Vincular al ${tipo === 'helado' ? 'sabor' : 'insumo'}` : 'Grabar'}</button>
        {soloVincular && <p className="rv-nota">Con el lector en modo teclado no se escribe en el chip, y no hace falta: cada tag ya trae su propio código. Al vincular, el sistema anota que ese tag es de este {tipo === 'helado' ? 'sabor' : 'insumo'}.</p>}
      </div>
      {ocupado && !soloVincular && <div className="tarjeta"><b>No muevas el tag</b><ul>{PASOS.map(([id, t], i) => <li key={id} style={{ opacity: i > iFase ? 0.5 : 1 }}>{i < iFase ? '✓' : i === iFase ? '…' : '·'} {t}{id === 'escribiendo' && intento > 1 ? ` (intento ${intento})` : ''}</li>)}</ul></div>}
      {error && <div className="aviso-caja mal"><b>{error.message}</b>{consejoParaError(error) && <div>{consejoParaError(error)}</div>}<div className="rv-nota">No se cambió nada en el sistema.</div></div>}
      {hecho && <div className="aviso-caja ok"><b>{soloVincular ? 'Tag vinculado ✓' : 'Tag grabado con éxito ✓'}</b><div className="rv-epc">{hecho.epc}</div><div>{hecho.estado === 'asignado' ? `Quedó vinculado a «${hecho.sabor_nombre || hecho.insumo_nombre}». Pégalo en la bandeja.` : 'Quedó libre. Pégalo en la bandeja y asígnale un sabor desde Tags.'}</div></div>}
    </div>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────────
function Historial({ id }) {
  const [f, setF] = useState(null);
  useEffect(() => { rget(`/rfid/tags/${id}/historial`).then(setF).catch(() => setF([])); }, [id]);
  if (!f) return <div className="rv-nota">Cargando…</div>;
  return f.map((x, i) => <div key={i} className="fila espacio"><span>{EVENTOS[x.evento] || x.evento}{x.detalle ? ` · ${x.detalle}` : ''}{x.ubicacion ? ` · ${x.ubicacion}` : ''}</span><span className="rv-nota">{cuando(x.creado_en)}</span></div>);
}
function TarjetaTag({ t, cat, lector, alCambiar }) {
  const avisar = useAviso(); const [asig, setAsig] = useState(''); const [leyendo, setLeyendo] = useState(false);
  const producto = t.sabor_nombre ? `${t.sabor_nombre}${t.fecha ? ` · tanda del ${t.fecha}` : ''}` : t.insumo_nombre ? `${t.insumo_nombre}${t.fecha_ingreso ? ` · lote ${t.fecha_ingreso}` : ''}` : null;
  async function accion(fn, ok) { try { await fn(); avisar(ok); alCambiar(); } catch (e) { avisar(e.message, 'mal'); } }
  async function actualizarCodigo() {
    const l = lector?.lector?.current;
    if (!l || !['listo', 'escaneando'].includes(lector.estado)) return avisar('Primero conecta el lector', 'mal');
    setLeyendo(true);
    try {
      const e = await l.leerEpcsEnCampo();
      if (!e.length) return avisar('No llegó ninguna lectura', 'mal');
      if (e.length > 1) return avisar(`Llegaron ${e.length} tags distintos: lee uno solo`, 'mal');
      if (e[0] === t.epc) return avisar('Ese tag todavía tiene el mismo código');
      if (e[0].length !== 24 && !window.confirm(`El código nuevo mide ${e[0].length} caracteres y lo normal son 24: puede haber llegado incompleto. ¿Usarlo de todos modos?`)) return;
      if (!window.confirm(`Código nuevo: ${e[0]}\n\n¿Reemplazar el código anterior (${t.epc}) de este tag? Conserva su sabor, su ubicación y su historial.`)) return;
      await rpatch(`/rfid/tags/${t.id}/epc`, { epc: e[0] }); avisar('Código actualizado'); alCambiar();
    } catch (e) { avisar(e.message, 'mal'); } finally { setLeyendo(false); }
  }
  const opciones = [...cat.sabores.map((x) => ({ v: `s${x.id}`, t: `🍨 ${x.nombre}` })), ...cat.insumos.map((x) => ({ v: `i${x.id}`, t: `📦 ${x.nombre}` }))];
  return (
    <div className="tarjeta rejilla">
      <div className="fila"><Chip tono={TONO[t.estado]}>{t.estado}</Chip>{t.ciclos > 0 && <Chip>{t.ciclos} {t.ciclos === 1 ? 'uso previo' : 'usos previos'}</Chip>}</div>
      <h3>{t.etiqueta || producto || (t.ubicacion_nombre ? 'Tag sin nombre' : t.estado === 'disponible' ? 'Libre para vincular' : 'Tag sin ubicar')}</h3>
      <div className="rv-epc">{t.epc}</div>
      {t.etiqueta && producto && <div className="rv-nota">{producto}</div>}
      <div className="fila"><button className="btn chico" disabled={leyendo} onClick={actualizarCodigo}>{leyendo ? 'Esperando… aprieta el gatillo' : 'Actualizar código'}</button>
        <button className="btn chico" onClick={() => { const n = window.prompt('Nombre para este tag (ej. Bandeja 3)', t.etiqueta || ''); if (n !== null) accion(() => rpatch(`/rfid/tags/${t.id}/etiqueta`, { etiqueta: n }), 'Nombre guardado'); }}>{t.etiqueta ? 'Cambiar nombre' : 'Ponerle nombre'}</button></div>
      {t.ubicacion_nombre && <div className="rv-nota">En «{t.ubicacion_nombre}» desde {cuando(t.ubicacion_desde)}</div>}
      {t.ultima_lectura_en && <div className="rv-nota">Última lectura: {cuando(t.ultima_lectura_en)}{t.faltas_seguidas > 0 ? ` · no apareció en ${t.faltas_seguidas} barrido(s)` : ''}</div>}
      {['disponible', 'nuevo'].includes(t.estado) && (
        <div className="rejilla"><select value={asig} onChange={(e) => setAsig(e.target.value)}><option value="">Vincular a un sabor o insumo…</option>{opciones.map((o) => <option key={o.v} value={o.v}>{o.t}</option>)}</select>
          <div className="fila"><button className="btn primario chico" disabled={!asig} onClick={() => accion(() => rpost(`/rfid/tags/${t.id}/asignar`, asig[0] === 's' ? { sabor_id: asig.slice(1) } : { insumo_id: asig.slice(1) }), 'Tag vinculado')}>Vincular</button>
            <button className="btn peligro chico" onClick={() => window.confirm('¿Dar de baja este tag?') && accion(() => rpost(`/rfid/tags/${t.id}/baja`, { motivo: 'baja manual' }), 'Tag dado de baja')}>Dar de baja</button></div></div>
      )}
      {t.estado === 'asignado' && <button className="btn chico" onClick={() => window.confirm('¿La bandeja ya se vació y se lavó? El tag quedará libre con el mismo código.') && accion(() => rpost(`/rfid/tags/${t.id}/liberar`), 'Tag liberado: listo para otro producto')}>Bandeja vacía: liberar</button>}
      <details><summary>Historial</summary><Historial id={t.id} /></details>
    </div>
  );
}
function Tags({ lector }) {
  const [filtro, setFiltro] = useState('freezers'); const [datos, setDatos] = useState(null); const [cat, setCat] = useState({ sabores: [], insumos: [] }); const [error, setError] = useState('');
  async function cargar() { try { const [t, c] = await Promise.all([rget('/rfid/tags'), rget('/rfid/catalogo')]); setDatos(t); setCat(c); setError(''); } catch (e) { setError(e.message); } }
  useEffect(() => { cargar(); }, []);
  if (error) return <div className="aviso-caja mal">{error}</div>;
  if (!datos) return <div className="vacio">Cargando…</div>;
  const enFreezers = datos.tags.filter((t) => t.estado !== 'baja' && t.ubicacion_id);
  const lista = filtro === 'freezers' ? enFreezers : datos.tags.filter((t) => t.estado === filtro);
  const ESTADOS = [['freezers', 'En freezers'], ['asignado', 'Asignados'], ['disponible', 'Disponibles'], ['nuevo', 'Nuevos'], ['baja', 'De baja']];
  return (
    <div className="rejilla">
      <div className="tabs">{ESTADOS.map(([id, n]) => <button key={id} className={filtro === id ? 'activa' : ''} onClick={() => setFiltro(id)}>{n} ({id === 'freezers' ? enFreezers.length : datos.resumen[id] || 0})</button>)}</div>
      {datos.truncado && <div className="aviso-caja">Hay más tags de los que se pueden mostrar aquí ({datos.total}). Los conteos de arriba son los reales.</div>}
      {!lista.length && <div className="aviso-caja">{filtro === 'freezers' ? 'Todavía no registraste tags en ningún freezer. Ve a «Inventario freezer», elige una sección y pasa el lector.' : 'No hay tags en este estado.'}</div>}
      {lista.map((t) => <TarjetaTag key={t.id} t={t} cat={cat} lector={lector} alCambiar={cargar} />)}
    </div>
  );
}

/** Control RFID: los tags de las bandejas y cajas, y qué hay en cada freezer. */
export default function Rfid() {
  const lector = useLector();
  const [sub, setSub] = useState('auditar');
  return (
    <div className="rejilla">
      <BarraLector lector={lector} />
      <div className="tabs">{[['auditar', '🧊 Inventario freezer'], ['grabar', '✍️ Grabar sabor'], ['tags', '🏷️ Tags']].map(([id, n]) => <button key={id} className={sub === id ? 'activa' : ''} onClick={() => setSub(id)}>{n}</button>)}</div>
      {sub === 'auditar' && <Freezer lector={lector} />}
      {sub === 'grabar' && <Grabar lector={lector} />}
      {sub === 'tags' && <Tags lector={lector} />}
    </div>
  );
}
