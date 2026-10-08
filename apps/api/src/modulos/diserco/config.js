// Datos fijos de DISERCO para cotizaciones (los fiscales viven en core.empresas).
export const DISERCO = {
  prefijoProyecto: 'INDE',
  web: 'www.diserco.hn',
  direccion: 'Prolongación Av. Junior, 18 y 19 calle, 4 ave. N.E., S.P.S. Honduras',
  telefono: '(504) 2552-2503',
  nombreCheques: 'DISTRIBUCIÓN Y SERVICIOS DE LA CONSTRUCCIÓN',
  bancos: [
    { banco: 'Bco. Atlántida', cuenta: '2100088224' },
    { banco: 'Bco. Credomatic', cuenta: '200123653' },
    { banco: 'Bco. Ficohsa', cuenta: '0008135018' },
  ],
  naranja: '#e8762b',
  tasaIsv: 0.15,
};

export const codigoCotizacion = (tipo, numero, anio) =>
  `${tipo === 'proyecto' ? DISERCO.prefijoProyecto : ''}${String(numero).padStart(4, '0')}-${String(anio).slice(-2)}`;
