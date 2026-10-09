// Política de contraseñas y PIN. Una sola fuente para el alta de usuarios, el restablecimiento y el cambio propio.

const COMUNES = new Set([
  'password', 'password1', 'password123', 'contrasena', 'contrasena1', 'contrasena123', '12345678', '123456789', '1234567890', '0123456789',
  '11111111', '00000000', '87654321', 'qwertyui', 'qwertyuiop', 'qwerty123', 'qwerty12', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx',
  'abcd1234', 'abc12345', 'abcdefgh', 'admin123', 'administrador', 'admin1234', 'letmein1', 'welcome1', 'welcome123', 'iloveyou', 'monkey123',
  'honduras', 'honduras1', 'honduras123', 'sanpedro', 'sanpedrosula', 'sps12345', 'italo123', 'italo1234', 'origen123', 'origen1234', 'ecostone1', 'ecostone123',
  'diserco123', 'diserco1234', 'cambiame', 'cambiame1', 'cambiame123', 'temporal1', 'temporal123', 'clave123', 'clave1234', 'miclave123', 'grupo123', 'grupo1234',
]);

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Devuelve el motivo por el que la contraseña NO sirve, o null si es aceptable. */
export function problemaClave(clave, { email, nombre } = {}) {
  const c = String(clave ?? '');
  if (c.length < 8) return 'La contraseña lleva mínimo 8 caracteres';
  if (c.length > 200) return 'La contraseña es demasiado larga';
  const norm = sinAcentos(c).toLowerCase();
  if (COMUNES.has(norm)) return 'Esa contraseña es muy común; elige otra que no sea fácil de adivinar';
  if (/^(.)\1+$/.test(c)) return 'La contraseña no puede ser un mismo carácter repetido';
  const soloDigitos = /^\d+$/.test(c);
  if (soloDigitos && (esSecuencia(c) || new Set(c).size <= 2)) return 'Una contraseña de solo números en secuencia o repetidos es muy fácil de adivinar';
  if (/^[a-z]+$/i.test(c) && c.length < 10) return 'Combina letras con números o símbolos (o usa 10 letras o más)';
  if (soloDigitos && c.length < 10) return 'Combina números con letras (o usa 10 dígitos o más)';
  const local = String(email ?? '').split('@')[0].toLowerCase();
  if (local.length >= 4 && norm.includes(sinAcentos(local))) return 'La contraseña no debe contener tu correo';
  const nom = sinAcentos(nombre ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (nom.length >= 5 && new RegExp(`^${nom}\\d{0,3}$`).test(norm.replace(/[^a-z0-9]/g, ''))) return 'La contraseña no debe ser tu nombre';
  return null;
}

function esSecuencia(s) {
  let asc = true, desc = true;
  for (let i = 1; i < s.length; i++) {
    const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
    if (d !== 1) asc = false;
    if (d !== -1) desc = false;
  }
  return asc || desc;
}

export const POLITICA_PIN_DEFECTO = { pin_largo_min: 4, pin_largo_max: 6 };

/** Motivo por el que el PIN NO cumple la política vigente, o null. */
export function problemaPin(pin, politica = POLITICA_PIN_DEFECTO) {
  const p = String(pin ?? '');
  if (!/^\d+$/.test(p)) return 'El PIN son solo dígitos';
  const { pin_largo_min: min, pin_largo_max: max } = politica;
  if (p.length < min || p.length > max) return min === max ? `El PIN debe tener ${min} dígitos` : `El PIN debe tener de ${min} a ${max} dígitos`;
  return null;
}

/** Política vigente (una fila) con un caché corto: el alta de usuarios no consulta la base en cada tecla. */
export function crearPolitica(db) {
  let c = { ts: 0, v: { ...POLITICA_PIN_DEFECTO, mfa_obligatoria_direccion: false } };
  return {
    async obtener() {
      if (Date.now() - c.ts > 10_000) {
        const r = (await db.query('select mfa_obligatoria_direccion, pin_largo_min, pin_largo_max from core.seguridad_politica where id')).rows[0];
        if (r) c = { ts: Date.now(), v: r };
      }
      return c.v;
    },
    invalidar() { c.ts = 0; },
  };
}
