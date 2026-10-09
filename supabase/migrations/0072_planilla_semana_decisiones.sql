-- Decisiones del dueño: semana de 7 días, pago el viernes; horas extras a tarifa normal.
update plan.parametros set valor = 7, nota = 'Semana de 7 días (decidido por el dueño).' where clave = 'semana_dias_pago';
update plan.parametros set valor = 5, nota = 'Pago el viernes (decidido por el dueño).' where clave = 'semana_dia_pago';
update plan.parametros set valor = 0 where clave in ('he_diurna_pct','he_nocturna_pct','he_feriada_pct');
