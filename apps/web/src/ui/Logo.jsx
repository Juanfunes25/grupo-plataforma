import { useState } from 'react';

// Marcas del grupo. Si existe /logos/<codigo>.(svg|png) se usa ese archivo (logo real);
// si no, la marca vectorial de respaldo. Para cambiar un logo basta soltar el archivo en apps/web/public/logos/.
const Italo = ({ c }) => (
  <svg width="86" height="86" viewBox="0 0 64 64" aria-hidden><circle cx="32" cy="27.5" r="19" fill="none" stroke={c} strokeWidth="8.3" /><rect x="12.8" y="53" width="38.4" height="8.3" rx="1.7" fill={c} /></svg>
);
const Origen = ({ c }) => (
  <svg width="92" height="92" viewBox="0 0 64 64" aria-hidden>
    <circle cx="32" cy="34" r="22" fill="none" stroke={c} strokeWidth="4" />
    <path d="M32 54V30" stroke={c} strokeWidth="4" strokeLinecap="round" />
    <path d="M32 34c0-9 6-14 15-14 0 9-6 14-15 14z" fill={c} />
    <path d="M32 40c0-7-5-11-12-11 0 7 5 11 12 11z" fill={c} opacity=".65" />
  </svg>
);
const EcoStone = ({ c }) => (
  <svg width="86" height="86" viewBox="0 0 64 64" aria-hidden>
    <rect x="6" y="36" width="24" height="16" rx="3" fill={c} /><rect x="34" y="36" width="24" height="16" rx="3" fill={c} opacity=".7" /><rect x="20" y="14" width="24" height="18" rx="3" fill={c} opacity=".85" />
  </svg>
);
const Grupo = ({ c }) => (
  <svg width="56" height="56" viewBox="0 0 64 64" aria-hidden>
    <circle cx="32" cy="14" r="8" fill={c} /><circle cx="14" cy="46" r="8" fill={c} opacity=".8" /><circle cx="50" cy="46" r="8" fill={c} opacity=".6" />
    <path d="M32 22 18 40M32 22l14 18M22 46h20" stroke={c} strokeWidth="3" fill="none" />
  </svg>
);
const RESPALDO = { italo: Italo, origen: Origen, ecostone: EcoStone, grupo: Grupo };
const ARCHIVO = { diserco: '/logos/diserco.png' };

export default function Logo({ codigo, color = 'currentColor' }) {
  const [falla, setFalla] = useState(false);
  const Resp = RESPALDO[codigo];
  const src = ARCHIVO[codigo] ?? `/logos/${codigo}.svg`;
  if (!falla && (ARCHIVO[codigo] || !Resp)) return <img src={src} alt="" onError={() => setFalla(true)} />;
  // Sobre fondo oscuro los verdes/marrones de marca pierden contraste: se aclaran un poco.
  if (Resp) return <span style={{ color: `color-mix(in srgb, ${color} 72%, white)`, display: 'inline-flex' }}><Resp c="currentColor" /></span>;
  return <span className="titulo" style={{ fontSize: '2rem' }}>{codigo}</span>;
}
