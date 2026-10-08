-- Nota interna por orden (para cocina/caja) — nunca aparece en el ticket ni
-- en el PDF de la factura, es sólo para uso interno.
alter table ventas add column if not exists nota_interna text;
