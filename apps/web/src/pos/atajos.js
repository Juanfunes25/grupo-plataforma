// Atajos de teclado del POS. Una sola lista: la usa la ayuda (F1), la tira de abajo y la documentación.
export const ATAJOS = [
  { teclas: 'F2', texto: 'Cobrar en efectivo (total exacto)', corta: 'Efectivo' },
  { teclas: 'F3', texto: 'Cobrar con tarjeta (total exacto)', corta: 'Tarjeta' },
  { teclas: 'F4', texto: 'Efectivo recibido: teclado y cambio grande', corta: 'Recibido' },
  { teclas: 'F6', texto: 'Más formas de pago (dividir, transferencia)', corta: null },
  { teclas: 'F7', texto: 'Órdenes abiertas', corta: 'Abiertas' },
  { teclas: 'F8', texto: 'Dejar la orden en espera', corta: 'En espera' },
  { teclas: 'F9', texto: 'Elegir cliente / RTN', corta: null },
  { teclas: 'Enter', texto: 'En la búsqueda: agregar el producto resaltado (o el código escaneado)', corta: 'Agregar' },
  { teclas: '3*jugo', texto: 'En la búsqueda: agrega 3 unidades del producto', corta: null },
  { teclas: '/', texto: 'Ir a la búsqueda', corta: null },
  { teclas: '+  −', texto: 'Una unidad más / menos en la última línea', corta: null },
  { teclas: '*', texto: 'Cantidad con teclado numérico para la última línea', corta: null },
  { teclas: 'Ctrl+Z', texto: 'Deshacer el último cambio en la orden', corta: 'Deshacer' },
  { teclas: 'Esc', texto: 'Cerrar ventana · borrar la búsqueda · cancelar la orden', corta: 'Cancelar' },
  { teclas: 'F1', texto: 'Esta ayuda', corta: 'Ayuda' },
];
