import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  size?: number;
};

export function Icon({ size = 16, className, children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      {children}
    </svg>
  );
}

export function PinIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Icon>
  );
}

export function PinOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 17v5" />
      <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
      <path d="m2 2 20 20" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </Icon>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </Icon>
  );
}

export function ArchiveRestoreIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="20" height="5" x="2" y="3" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h2" />
      <path d="M20 8v11a2 2 0 0 1-2 2h-2" />
      <path d="m9 15 3-3 3 3" />
      <path d="M12 12v9" />
    </Icon>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="14" height="11" x="5" y="11" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Icon>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function EyeOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 2 20 20" />
      <path d="M6.7 6.7C3.8 8.5 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-.9" />
      <path d="M9.9 4.2C10.6 4.1 11.3 4 12 4c6.5 0 10 6 10 6s-.9 1.6-2.5 3.1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
    </Icon>
  );
}

export function BellOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 2 20 20" />
      <path d="M8.6 4.7A6 6 0 0 1 18 8c0 1.7.2 3 .6 4" />
      <path d="M6.3 6.3C6.1 6.8 6 7.4 6 8c0 7-3 7-3 9h14" />
      <path d="M10.3 21a2 2 0 0 0 3.4 0" />
    </Icon>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1A2 2 0 1 1 7.1 4l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.7 1Z" />
    </Icon>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 1 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
    </Icon>
  );
}

export function MessageSquareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
    </Icon>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </Icon>
  );
}

export function MicOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 2 20 20" />
      <path d="M9 9v3a3 3 0 0 0 5.1 2.1" />
      <path d="M15 9.3V5a3 3 0 0 0-5.1-2.1" />
      <path d="M19 10v2a7 7 0 0 1-.7 3" />
      <path d="M5 10v2a7 7 0 0 0 9.7 6.5" />
      <path d="M12 19v3" />
    </Icon>
  );
}

export function PhoneIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.3 1.8.7 2.6a2 2 0 0 1-.4 2.1L8.1 9.7a16 16 0 0 0 6.2 6.2l1.3-1.3a2 2 0 0 1 2.1-.4c.8.3 1.7.6 2.6.7a2 2 0 0 1 1.7 2Z" />
    </Icon>
  );
}

export function PhoneOffIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m2 2 20 20" />
      <path d="M5.8 5.8A19.5 19.5 0 0 0 4.2 12a19.5 19.5 0 0 0 6 6 19.8 19.8 0 0 0 8.6 3.1 2 2 0 0 0 2.2-2v-3a2 2 0 0 0-1.7-2c-.9-.1-1.8-.4-2.6-.7" />
      <path d="M9.4 8.4a2 2 0 0 0 .4-2.1c-.3-.8-.6-1.7-.7-2.6A2 2 0 0 0 7.1 2h-3a2 2 0 0 0-2 2.2 19.8 19.8 0 0 0 .7 3.1" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m8 5 11 7-11 7V5Z" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M10 4v16" />
      <path d="M14 4v16" />
    </Icon>
  );
}

export function SquareIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect width="14" height="14" x="5" y="5" rx="2" />
    </Icon>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m22 2-7 20-4-9-9-4Z" />
      <path d="M22 2 11 13" />
    </Icon>
  );
}

export function RefreshCwIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 12a9 9 0 0 1-15.6 6.1L3 16" />
      <path d="M3 21v-5h5" />
      <path d="M3 12a9 9 0 0 1 15.6-6.1L21 8" />
      <path d="M16 8h5V3" />
    </Icon>
  );
}

export function SmilePlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <path d="M9 9h.01" />
      <path d="M15 9h.01" />
      <path d="M19 5v4" />
      <path d="M17 7h4" />
    </Icon>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </Icon>
  );
}

export function XIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </Icon>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function CornerUpLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 14-4-4 4-4" />
      <path d="M5 10h11a4 4 0 0 1 0 8h-1" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

/** Expand a pane to full-width focus. */
export function ExpandIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </Icon>
  );
}

/** Collapse a focused pane back to split. */
export function ShrinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="m14 10 7-7" />
      <path d="m3 21 7-7" />
    </Icon>
  );
}

/** Pin — dock a drawer as a side pane beside the transcript. */
export function PanelRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
    </Icon>
  );
}

/** Unpin — collapse the docked side pane back to an overlay. */
export function PanelRightCloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M15 3v18" />
      <path d="m8 9 3 3-3 3" />
    </Icon>
  );
}

/** Collapse the persistent left navigation to its compact rail. */
export function PanelLeftCloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m16 9-3 3 3 3" />
    </Icon>
  );
}

/** Restore the full left navigation from its compact rail. */
export function PanelLeftOpenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
      <path d="m14 9 3 3-3 3" />
    </Icon>
  );
}

/** Detach — open in a new browser tab. */
export function ExternalLinkIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14 21 3" />
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    </Icon>
  );
}

/* === web lane additions === */

/** Fixed product persona for agent-authored timeline rows. */
export function BotIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4" />
      <path d="M8 12h.01" />
      <path d="M16 12h.01" />
      <path d="M9 16h6" />
    </Icon>
  );
}
