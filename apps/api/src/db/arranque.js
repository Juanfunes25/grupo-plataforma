// Comprobaciones del arranque del servidor, juntas en UNA consulta.
// En Render cada consulta a Supabase es un viaje de red; antes el arranque hacía 6 seguidas solo para descubrir que
// las semillas ya estaban cargadas (que es lo normal en cada arranque salvo el primero).

/** ¿Qué cargas iniciales faltan? { rinv, italo, ecostone } en true = hay que sembrar. */
export async function semillasPendientes(db) {
  const { rows } = await db.query(`
    select
      exists (select 1 from core.empresas e join core.empresa_modulos m on m.empresa_id = e.id and m.modulo = 'reposicion' and m.activo where e.codigo = 'italo')
        and not exists (select 1 from rinv.insumos_fab f join core.empresas e on e.id = f.empresa_id where e.codigo = 'italo') as rinv,
      exists (select 1 from core.empresas where codigo = 'italo')
        and not exists (select 1 from pos.productos p join core.empresas e on e.id = p.empresa_id where e.codigo = 'italo') as italo,
      exists (select 1 from core.empresas where codigo = 'ecostone')
        and not exists (select 1 from pos.productos p join core.empresas e on e.id = p.empresa_id where e.codigo = 'ecostone') as ecostone`);
  return rows[0];
}
