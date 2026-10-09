// Ticket de texto para impresora térmica (48/42 col ≈ 80 mm, 32 col ≈ 58 mm).
// El formato vive en @grupo/shared para que la caja pueda armar el comprobante provisional SIN conexión con el mismo código.
export { envolverTicketHtml, formatearTicket, formatearTicketPrueba, formatearTicketProvisional, formatearCierreTurno, anchoValido } from '@grupo/shared';
