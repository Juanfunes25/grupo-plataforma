// Validación de correo+contraseña contra Supabase Auth (cuando está configurado).
// El navegador NUNCA habla con Supabase: el API es la única puerta.
export async function loginSupabase(config, email, password) {
  const r = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: config.supabaseAnonKey, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  return { authUserId: j.user?.id ?? null };
}
