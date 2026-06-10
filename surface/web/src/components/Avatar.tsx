import { initials, userColor } from '../util';

export function Avatar({
  name,
  seed,
  size = 32,
}: {
  name: string;
  seed: string;
  size?: number;
}) {
  return (
    <div
      className="flex shrink-0 select-none items-center justify-center rounded-md font-semibold text-white/90"
      style={{
        width: size,
        height: size,
        backgroundColor: userColor(seed),
        fontSize: Math.max(10, Math.floor(size * 0.4)),
      }}
      title={name}
    >
      {initials(name)}
    </div>
  );
}
