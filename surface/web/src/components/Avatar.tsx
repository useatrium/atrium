import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../theme';
import { AgentMark } from './AgentMark';

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
    // Humans get the full square; the agent's circle renders slightly smaller
    // inside the same footprint so gutters stay aligned while the mark still
    // reads as "not a person".
    return (
      <div
        className="flex shrink-0 select-none items-center justify-center"
        style={{ width: size, height: size }}
        title="Agent"
      >
        <AgentMark size={Math.max(16, Math.round(size * 0.75))} />
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
