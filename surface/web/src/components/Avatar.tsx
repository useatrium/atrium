import { useEffect, useState } from 'react';
import { initials, userColorTokens } from '@atrium/surface-client';
import { useTheme } from '../theme';
import { AgentMark } from './AgentMark';

export function Avatar({
  name,
  seed,
  src,
  size = 32,
  variant = 'human',
}: {
  name: string;
  seed: string;
  src?: string | null;
  size?: number;
  variant?: 'human' | 'agent';
}) {
  const { resolvedScheme } = useTheme();
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const colors = userColorTokens(seed, resolvedScheme);
  const effectiveSrc = variant === 'human' && src && failedSrc !== src ? src : null;
  useEffect(() => {
    setFailedSrc(null);
  }, [src]);
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
      {effectiveSrc ? (
        <img
          src={effectiveSrc}
          alt=""
          className="size-full rounded-md object-cover"
          draggable={false}
          onError={() => setFailedSrc(effectiveSrc)}
        />
      ) : (
        initials(name)
      )}
    </div>
  );
}
