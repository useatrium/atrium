// Design tokens mirroring the web client's zinc dark theme so the two
// surfaces read as one product.

export const colors = {
  bg: '#09090b', // zinc-950
  bgElevated: '#18181b', // zinc-900
  bgInput: '#1f1f23',
  bgPressed: '#27272a', // zinc-800
  border: '#27272a', // zinc-800
  borderSoft: '#1c1c20',
  text: '#f4f4f5', // zinc-100
  textSecondary: '#a1a1aa', // zinc-400
  textMuted: '#71717a', // zinc-500
  textFaint: '#52525b', // zinc-600
  accent: '#818cf8', // indigo-400 — mentions, links, active states
  accentBg: 'rgba(129, 140, 248, 0.16)',
  mention: '#ef4444', // red-500 — @ badges
  danger: '#f87171', // red-400
  warning: '#fbbf24', // amber-400
  warningBg: 'rgba(120, 53, 15, 0.3)',
  online: '#34d399', // emerald-400
} as const;

export const font = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 20,
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 14,
} as const;
