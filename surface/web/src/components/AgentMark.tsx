/**
 * The agent's mark — a solid accent circle with an on-accent knockout robot.
 * Deliberately not person-shaped: humans are rounded squares with initials;
 * the agent is a smaller solid circle. This is the ONLY agent identity marker
 * (no AGENT pill, no name required), so it must read at every size from 16px
 * (meta lines) through 32px (headers, pickers).
 */
export function AgentMark({
  size = 20,
  tone = 'accent',
  className,
}: {
  size?: number;
  /** danger = failed session; the mark carries the terminal state's heat. */
  tone?: 'accent' | 'danger';
  className?: string;
}) {
  const circle = tone === 'danger' ? 'var(--danger)' : 'var(--accent)';
  const face = 'var(--on-accent)';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role="img"
      aria-label="Agent"
      className={`shrink-0 select-none ${className ?? ''}`}
    >
      <circle cx="12" cy="12" r="12" fill={circle} />
      <g transform="translate(0 0.5)">
        <circle cx="12" cy="5.4" r="1.1" fill={face} />
        <rect x="11.5" y="6.2" width="1" height="1.6" fill={face} />
        <rect x="6.2" y="7.8" width="11.6" height="9.4" rx="2.8" fill={face} />
        <circle cx="9.7" cy="12" r="1.15" fill={circle} />
        <circle cx="14.3" cy="12" r="1.15" fill={circle} />
        <rect x="9.6" y="14.4" width="4.8" height="1.15" rx="0.575" fill={circle} />
      </g>
    </svg>
  );
}
