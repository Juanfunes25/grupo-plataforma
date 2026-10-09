-- Materia prima de la fábrica en tres categorías: MEC3, Ristoris y Otros (decisión del dueño).
-- Solo se llena donde la categoría está vacía: nunca pisa una que alguien ya puso a mano.
update rinv.insumos_fab set categoria = 'MEC3'  where categoria is null and tipo = 'mec3';
update rinv.insumos_fab set categoria = 'Otros' where categoria is null and tipo <> 'mec3';
