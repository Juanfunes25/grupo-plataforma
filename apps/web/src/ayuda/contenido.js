// Contenido de la ayuda: manual por rol, recorridos guiados y ayuda de cada pantalla. Todo en español de Honduras.
// Los pasos se escriben con los nombres que el usuario ve en el menú.

export const ROLES_AYUDA = [
  { id: 'cajero', nombre: 'Cajero o ventas', resumen: 'Cobrar, reimprimir y hacer el cierre de caja.' },
  { id: 'gerente', nombre: 'Gerente de tienda', resumen: 'Cuidar la operación del día, anular, revisar cierres y números.' },
  { id: 'despachador', nombre: 'Despachador o bodega', resumen: 'Armar y enviar lo que pide cada sucursal; recibir y mover inventario.' },
  { id: 'produccion', nombre: 'Producción', resumen: 'Registrar lo que se produce y consumir insumos.' },
  { id: 'dueno', nombre: 'Dueño o administración', resumen: 'Ver el grupo en el celular, alertas, usuarios y control.' },
];

export { rolDeAyuda } from './rol.js';

export const MANUAL = {
  cajero: [
    { id: 'entrar', titulo: 'Entrar a la caja', pasos: [
      'Escribe tu PIN en la pantalla de la empresa. Solo tú debes conocerlo.',
      'Entra a «Facturación». No hay que abrir turno: la caja se abre sola con tu primer cobro.',
      'Todo lo que cobras queda a tu nombre, así el cierre del día cuadra contra tu caja.'] },
    { id: 'cobrar', titulo: 'Tomar un pedido y cobrar', pasos: [
      'Toca los productos para agregarlos. Si tiene opciones (tamaño, extras), elígelas y confirma.',
      'Para cambiar la cantidad usa el teclado numérico; para quitar una línea, tócala y elige «Quitar».',
      'Si el cliente pide factura con su nombre o RTN, toca el cliente y búscalo o créalo. Sin eso sale como Consumidor Final.',
      'Cobra con «EFECTIVO» (F2) o «TARJETA» (F3). Si te dan un billete grande, usa «Efectivo recibido y cambio» (F4): escribe cuánto te dan y el sistema calcula el cambio.',
      'Para dividir el pago o cobrar por transferencia usa «Más formas de pago» (F6).'],
      aviso: 'Mientras no haya un CAI real activado, las facturas salen en BORRADOR y dicen «sin valor fiscal».' },
    { id: 'reimprimir', titulo: 'Reimprimir o buscar una factura', pasos: [
      'Entra a «Facturas» y escribe el número, el nombre del cliente o su RTN. También puedes usar la búsqueda (Ctrl+K o la lupa).',
      'Ábrela y toca «Reimprimir ticket». Cada reimpresión queda registrada.'] },
    { id: 'cierre', titulo: 'Cerrar tu caja', pasos: [
      'Al terminar entra a «Cierre de caja» y elige tu sucursal.',
      'Escribe el «Fondo de caja» y el «Efectivo total en caja» que contaste. No se pide nada más.',
      'El sistema compara con lo vendido y muestra la diferencia. Si no cuadra, revisa el conteo antes de confirmar y escribe una observación.',
      'Confirma el cierre. Los turnos abiertos se cierran con él.'] },
    { id: 'caja-chica', titulo: 'Gastos pequeños de la caja', pasos: [
      'Entra a «Caja chica» y toca «Salida de efectivo» (o «Ingreso» si entra dinero).',
      'Elige la categoría, el monto y escribe un concepto claro (por ejemplo «taxi a banco»). Esto baja el efectivo esperado del cierre.'] },
  ],
  gerente: [
    { id: 'dia', titulo: 'Ver cómo va el día', pasos: [
      'Abre «Dashboard»: arriba ves lo vendido hoy contra ayer a esta misma hora y contra el mismo día de la semana pasada.',
      'Las alertas aparecen primero. Toca una para ir directo a donde se resuelve.',
      'En el celular desliza hacia abajo para actualizar.'] },
    { id: 'anular', titulo: 'Anular una factura', pasos: [
      'Entra a «Facturas», busca la factura y ábrela.',
      'Toca «Anular factura» y escribe el motivo (obligatorio). El número no se reutiliza y queda en la bitácora.'] },
    { id: 'cierres', titulo: 'Revisar los cierres de caja', pasos: [
      'En «Cierre de caja» abre el historial y mira las diferencias de cada cajero.',
      'Una diferencia repetida en la misma persona o sucursal merece una conversación; el módulo «Antifraude» ayuda a ver patrones.'] },
    { id: 'reportes', titulo: 'Reportes y gerente digital', pasos: [
      'En «Reportes» elige el periodo y la sucursal; hay ventas por día y hora, productos, pagos y libro de ventas (se baja en CSV).',
      'El «Gerente digital» resume lo importante en lenguaje sencillo y sugiere qué hacer.'] },
  ],
  despachador: [
    { id: 'despacho', titulo: 'Armar los despachos (gelato)', pasos: [
      'Entra a «Despacho». Verás qué sabores y cuántos kilos debe recibir cada sucursal.',
      'Arma cada envío y márcalo como enviado; la sucursal confirmará la recepción.',
      'Los pedidos de insumos de las tiendas también aparecen ahí.'] },
    { id: 'recepcion', titulo: 'Recibir y confirmar', pasos: [
      'Cuando llegue un envío, abre «Pesaje de la noche» y toca «Confirmar recepción» si todo llegó bien.',
      'Si falta o sobra algo, corrígelo y deja el motivo: así queda claro quién respondió por la diferencia.'] },
    { id: 'inventario', titulo: 'Mover inventario', pasos: [
      'En «Inventario» (o «Inventario y RFID») registra compras, mermas y conteos.',
      'En DISERCO, las salidas a proyecto se hacen en «Salidas a proyecto».'] },
  ],
  produccion: [
    { id: 'registrar', titulo: 'Registrar lo producido', pasos: [
      'Gelato: entra a «Producción de gelato» y registra la tanda con su sabor y cantidad. Imprime la etiqueta del lote.',
      'EcoStone: usa «Registrar producción» desde el celular, elige la orden y escribe las cajas de 1 m² producidas.',
      'Revisa antes de guardar: lo registrado alimenta inventario y costos.'] },
    { id: 'consumo', titulo: 'Consumo de insumos', pasos: [
      'El sistema descuenta insumos según la receta. Si usaste algo distinto, anótalo en la tanda.',
      'Si un insumo está en rojo, avisa a bodega.'] },
    { id: 'pesaje', titulo: 'Pesaje de la noche', pasos: [
      'En «Pesaje de la noche» elige tus sabores y escribe el peso que queda en cada uno.',
      'Con ese dato el sistema calcula cuánto reponer mañana.'] },
  ],
  dueno: [
    { id: 'tablero', titulo: 'Tu tablero en el celular', pasos: [
      'Entra a «Dirección del grupo» → pestaña «Hoy»: las cuatro empresas con lo vendido hoy, comparado con ayer y la semana pasada.',
      'Las alertas salen arriba (CAI por vencer, cierres que faltan, documentos vencidos, alertas de control).',
      'Toca «Abrir» en una empresa para entrar a ella. Desliza hacia abajo para actualizar.'] },
    { id: 'buscar', titulo: 'Buscar lo que sea', pasos: [
      'Presiona Ctrl+K (o ⌘+K) o toca la lupa. Escribe un número de factura, un cliente o RTN, un producto, un empleado o un documento.',
      'La búsqueda respeta la empresa activa y tus permisos.'] },
    { id: 'usuarios', titulo: 'Usuarios y permisos', pasos: [
      'En «Usuarios» crea personas, asigna su perfil (Ventas, Manager, Administrador) y su PIN.',
      'Como administrador general, en Dirección → «Administradores y accesos» das acceso en cualquier empresa.'] },
    { id: 'control', titulo: 'Control y fiscal', pasos: [
      'La «Bitácora» guarda cada acción y no se puede alterar.',
      'En «CAI / Emisión» se activa el CAI real. Mientras tanto todo sale en modo borrador, sin valor fiscal.',
      'En «Documentos» vigila contratos y permisos por vencer.'] },
  ],
};

export const RECORRIDOS = {
  cajero: [
    { t: 'Bienvenido', x: 'Este es un recorrido de un minuto. Puedes repetirlo cuando quieras desde «Ayuda».' },
    { t: 'Tu caja', x: 'En Facturación no hay que abrir turno: la caja se abre sola con el primer cobro.' },
    { t: 'Cobra', x: 'Toca productos, luego «Cobrar», elige la forma de pago y el ticket sale solo.' },
    { t: 'Cierra tu caja', x: 'Al final entra a «Cierre de caja», cuenta el efectivo y confirma.' },
    { t: 'Busca rápido', x: 'La lupa (o Ctrl+K) encuentra facturas, clientes y productos. El botón «?» te explica cada pantalla.' },
  ],
  gerente: [
    { t: 'Bienvenido', x: 'Recorrido corto para gerentes. Se repite desde «Ayuda».' },
    { t: 'El día de un vistazo', x: 'En «Dashboard» ves hoy contra ayer y la semana pasada, y las alertas arriba.' },
    { t: 'Facturas y anulaciones', x: 'En «Facturas» buscas, reimprimes y anulas (siempre con motivo).' },
    { t: 'Cierres', x: 'Revisa las diferencias de caja en «Cierre de caja».' },
    { t: 'Busca rápido', x: 'La lupa (o Ctrl+K) busca en todo. El botón «?» explica cada pantalla.' },
  ],
  despachador: [
    { t: 'Bienvenido', x: 'Recorrido corto para despacho y bodega.' },
    { t: 'Despacho', x: 'Cada día arma lo que debe recibir cada sucursal y márcalo enviado.' },
    { t: 'Recepción', x: 'Las tiendas confirman lo recibido; cualquier diferencia se corrige con motivo.' },
    { t: 'Inventario', x: 'Registra compras, mermas y conteos en Inventario. El botón «?» explica cada pantalla.' },
  ],
  produccion: [
    { t: 'Bienvenido', x: 'Recorrido corto para producción.' },
    { t: 'Registra lo producido', x: 'Cada tanda u orden se registra con su cantidad; de ahí salen inventario y costos.' },
    { t: 'Etiquetas', x: 'Imprime la etiqueta del lote para poder rastrearlo.' },
    { t: 'Ayuda siempre a mano', x: 'El botón «?» explica la pantalla donde estés.' },
  ],
  dueno: [
    { t: 'Bienvenido', x: 'Recorrido para el dueño. Se repite desde «Ayuda».' },
    { t: 'Tu tablero', x: 'En Dirección del grupo → «Hoy» ves las cuatro empresas en el celular, con alertas arriba.' },
    { t: 'Búsqueda global', x: 'Ctrl+K (o la lupa) encuentra facturas, clientes, productos, empleados y documentos.' },
    { t: 'Control', x: 'Bitácora, CAI, usuarios y documentos están en el menú, en «Control».' },
    { t: 'Etapa de pruebas', x: 'Mientras no haya CAI real, las facturas salen en BORRADOR, sin valor fiscal.' },
  ],
};

/** Ayuda de cada pantalla (clave = ruta del módulo). */
export const AYUDA_PANTALLA = {
  pos: { t: 'Facturación', p: ['La caja se abre sola con el primer cobro.', 'Toca productos y cobra con EFECTIVO (F2), TARJETA (F3) o «Más formas de pago».', 'Sin CAI real la factura sale en BORRADOR, sin valor fiscal.'] },
  facturas: { t: 'Facturas', p: ['Busca por número, cliente o RTN.', 'Desde la factura puedes reimprimir o (con permiso) anular indicando el motivo.'] },
  cierres: { t: 'Cierre de caja', p: ['Escribe el Fondo de caja y el Efectivo total en caja.', 'La diferencia se calcula contra lo vendido; escribe una observación si no cuadra.'] },
  'caja-chica': { t: 'Caja chica', p: ['Registra salidas e ingresos pequeños con su categoría y concepto.', 'Afectan el efectivo esperado del cierre.'] },
  dashboard: { t: 'Dashboard', p: ['Arriba: hoy contra ayer (a esta hora) y contra la semana pasada.', 'Desliza hacia abajo en el celular para actualizar.', 'Más abajo está el análisis por periodo.'] },
  reportes: { t: 'Reportes', p: ['Elige el periodo y la sucursal y revisa cada pestaña.', 'El libro de ventas se baja en CSV para el contador.'] },
  documentos: { t: 'Documentos', p: ['Contratos, permisos y registros con fecha de vencimiento.', 'Los que vencen pronto aparecen como alerta en el tablero.'] },
  antifraude: { t: 'Antifraude', p: ['Alertas de caja y de uso; márcalas como revisadas con una nota.'] },
  cai: { t: 'CAI / Emisión', p: ['Aquí se activa el CAI real con su rango y fecha límite.', 'Mientras tanto todo sale en modo borrador.'] },
  usuarios: { t: 'Usuarios', p: ['Crea personas, asigna perfil por empresa y PIN para quienes trabajan en mostrador.'] },
  gelato: { t: 'Tablero de gelato', p: ['La noche de un vistazo: quién pesó, qué despachar y las alertas.'] },
  pesaje: { t: 'Pesaje de la noche', p: ['Escribe el peso que queda de cada sabor.', 'Confirma lo que recibiste de producción.'] },
  despacho: { t: 'Despacho', p: ['Arma lo que cada sucursal debe recibir y márcalo como enviado.'] },
  'gelato-produccion': { t: 'Producción de gelato', p: ['Registra cada tanda con su sabor y cantidad e imprime la etiqueta del lote.'] },
  'registrar-produccion': { t: 'Registrar producción', p: ['Elige la orden y escribe las cajas de 1 m² producidas.'] },
  inventario: { t: 'Inventario', p: ['Registra compras, mermas y conteos; el stock es un libro de movimientos.'] },
  personal: { t: 'Personal', p: ['Directorio, asistencia y vacaciones de la empresa.'] },
  terceros: { t: 'Clientes', p: ['El directorio de clientes y proveedores es común a todo el grupo.'] },
  gerente: { t: 'Gerente digital', p: ['Resume tus números y dice qué hacer primero.'] },
};
