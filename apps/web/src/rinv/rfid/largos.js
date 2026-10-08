/**
 * El teclado Bluetooth no confirma cada tecla (no hay «recibido»): si el lector manda un código de
 * 24 caracteres y se pierden 2 por el camino, llegan 22, que es un número par y parecería un EPC
 * válido. Registrar eso crearía un tag fantasma.
 *
 * Defensa: los EPC de un mismo lote casi siempre miden lo mismo. Si la mayoría mide N y alguno mide
 * distinto, ese es el sospechoso: se aparta y se avisa, en lugar de registrarlo.
 * Con menos de 3 códigos distintos no hay base para opinar y no se aparta nada.
 */
export const MINIMO_PARA_JUZGAR = 3;

/** @param {{epc: string}[]} lecturas @returns {{ buenas: any[], dudosas: any[], largoHabitual: number|null }} */
export function separarDudosas(lecturas) {
  if (lecturas.length < MINIMO_PARA_JUZGAR) return { buenas: lecturas, dudosas: [], largoHabitual: null };
  const cuentas = new Map();
  for (const l of lecturas) cuentas.set(l.epc.length, (cuentas.get(l.epc.length) || 0) + 1);
  // El largo más común; si empatan, el estándar de 24; si no, el más largo (lo corto es lo que se pierde).
  const largoHabitual = [...cuentas.entries()].sort((a, b) => b[1] - a[1] || (b[0] === 24) - (a[0] === 24) || b[0] - a[0])[0][0];
  const empate = [...cuentas.values()].filter((n) => n === cuentas.get(largoHabitual)).length > 1;
  if (empate && cuentas.size > 1 && largoHabitual !== 24) {
    // Mitad y mitad sin ser el estándar: no hay forma honesta de decidir cuál es el roto.
    return { buenas: lecturas, dudosas: [], largoHabitual: null };
  }
  return {
    buenas: lecturas.filter((l) => l.epc.length === largoHabitual),
    dudosas: lecturas.filter((l) => l.epc.length !== largoHabitual),
    largoHabitual,
  };
}
