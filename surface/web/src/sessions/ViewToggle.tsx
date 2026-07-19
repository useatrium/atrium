// Channel / Split / Focus — the layout grammar segmented control. Lives in the
// channel header (and is mirrored on the focused pane). "Split" and "Focus" need
// a session to point at, so they disable when no pane has been opened.

import { SegmentedControl } from '../components/ui';

export type SessionView = 'channel' | 'split' | 'focus';

const SEGMENTS: { value: SessionView; label: string; title: string }[] = [
  { value: 'channel', label: 'Channel', title: 'Channel + sessions rail' },
  { value: 'split', label: 'Split', title: 'Channel beside the session' },
  { value: 'focus', label: 'Focus', title: 'Session only, full width' },
];

export function ViewToggle({
  view,
  hasSession,
  onSetView,
}: {
  view: SessionView;
  /** A session is open (or was) — enables Split/Focus. */
  hasSession: boolean;
  onSetView: (view: SessionView) => void;
}) {
  return (
    <SegmentedControl
      aria-label="Layout"
      value={view}
      onChange={onSetView}
      items={SEGMENTS.map((seg) => {
        const disabled = seg.value !== 'channel' && !hasSession;
        return {
          value: seg.value,
          label: seg.label,
          disabled,
          tooltip: disabled ? 'Open a session to use this layout' : seg.title,
        };
      })}
    />
  );
}
