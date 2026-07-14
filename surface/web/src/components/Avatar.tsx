import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../theme';
import { BotIcon } from './icons';

export function Avatar({
  name,
  seed,
  size = 32,
  variant = 'human',
}: {
  name: string;
  seed: string;
  size?: number;
  variant?: 'human' | 'agent';
}) {
  const { resolvedScheme } = useTheme();
  const colors = userColorTokens(seed, resolvedScheme);
  if (variant === 'agent') {
    return (
      <div
        role="img"
        aria-label="Agent"
        className="flex shrink-0 select-none items-center justify-center rounded-md bg-accent-hover text-surface-base"
        style={{ width: size, height: size }}
        title="Agent"
      >
        <BotIcon size={Math.max(16, Math.floor(size * 0.62))} />
      </div>
    );
  }
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
