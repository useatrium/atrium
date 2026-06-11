import { initials, userColorTokens } from '@atrium/surface-client';

export function Avatar({
  name,
  seed,
  size = 32,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  const colors = userColorTokens(seed, 'dark');
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-md font-semibold"
      style={{
        width: size,
        height: size,
        backgroundColor: colors.bg,
        color: colors.fg,
        fontSize: Math.max(10, Math.floor(size * 0.4)),
      }}
      title={name}
    >
      {initials(name)}
    </div>
  );
}
