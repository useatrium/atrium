import { useState, type ReactNode } from 'react';
import {
  ACCENTS,
  FONT_SCALES,
  type Accent,
  type FontScale,
  type MotionPref,
  type NotificationMessagePref,
  type ThemeMode,
} from '@atrium/surface-client';
import type { ConnectionStatus, ProviderCredentialStatus } from '../api';
import { notificationState, toggleNotifications, type NotifyState } from '../notify';
import { useTheme } from '../theme';
import { Tooltip } from './a11y';
import { BellIcon, BellOffIcon } from './icons';

const SOURCE_URL = 'https://github.com/gbasin/atrium';
const LICENSE_URL = `${SOURCE_URL}/blob/master/LICENSE`;

const BELL_TITLES: Record<NotifyState, string> = {
  on: 'Device notifications on — click to turn off',
  off: 'Device notifications off — click to enable',
  denied: 'Notifications blocked in browser settings',
  unsupported: 'Notifications not supported here',
};

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const MOTION_OPTIONS: { value: MotionPref; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'reduced', label: 'Reduced' },
  { value: 'full', label: 'Full' },
];

const MESSAGE_NOTIFICATION_OPTIONS: { value: NotificationMessagePref; label: string }[] = [
  { value: 'all', label: 'All messages' },
  { value: 'dm_mention', label: 'DMs & mentions' },
  { value: 'off', label: 'Off' },
];

const ACCENT_LABELS: Record<Accent, string> = {
  indigo: 'Indigo',
  teal: 'Teal',
  amber: 'Amber',
  rose: 'Rose',
};

const FONT_LABELS: Record<FontScale, string> = {
  0.875: 'S',
  1: 'M',
  1.125: 'L',
  1.25: 'XL',
};

const SWATCH_CLASSES: Record<Accent, string> = {
  indigo: 'accent-swatch-indigo',
  teal: 'accent-swatch-teal',
  amber: 'accent-swatch-amber',
  rose: 'accent-swatch-rose',
};

export function SettingsSurface({
  githubConnection,
  connectionsAvailable,
  claudeStatus,
  codexStatus,
  onConnectGitHub,
  onConnectClaude,
  onConnectCodex,
}: {
  githubConnection?: ConnectionStatus;
  connectionsAvailable: boolean;
  claudeStatus?: ProviderCredentialStatus;
  codexStatus?: ProviderCredentialStatus;
  onConnectGitHub?: () => void;
  onConnectClaude?: () => void;
  onConnectCodex?: () => void;
}) {
  const [notify, setNotify] = useState<NotifyState>(() => notificationState());

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold text-fg">Settings</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-2xl px-4 py-4">
          <SettingsControls
            notify={notify}
            setNotify={setNotify}
            githubConnection={githubConnection}
            connectionsAvailable={connectionsAvailable}
            claudeStatus={claudeStatus}
            codexStatus={codexStatus}
            onConnectGitHub={onConnectGitHub}
            onConnectClaude={onConnectClaude}
            onConnectCodex={onConnectCodex}
          />
        </div>
      </div>
    </div>
  );
}

export function SettingsControls({
  notify,
  setNotify,
  githubConnection,
  connectionsAvailable,
  claudeStatus,
  codexStatus,
  onConnectGitHub,
  onConnectClaude,
  onConnectCodex,
}: {
  notify: NotifyState;
  setNotify: (state: NotifyState) => void;
  githubConnection?: ConnectionStatus;
  connectionsAvailable: boolean;
  claudeStatus?: ProviderCredentialStatus;
  codexStatus?: ProviderCredentialStatus;
  onConnectGitHub?: () => void;
  onConnectClaude?: () => void;
  onConnectCodex?: () => void;
}) {
  const { prefs, setPrefs } = useTheme();
  const segmentButton = (active: boolean) =>
    `h-8 flex-1 rounded px-2 text-xs font-medium ${
      active
        ? 'bg-accent text-on-accent'
        : 'text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body'
    }`;
  const toggleButton = (active: boolean) =>
    `flex h-8 w-16 items-center rounded-full border px-1 ${
      active
        ? 'justify-end border-accent bg-accent text-on-accent'
        : 'justify-start border-edge-strong bg-surface text-fg-muted'
    }`;
  const setNotificationMessages = (messages: NotificationMessagePref) =>
    setPrefs({ notifications: { ...prefs.notifications, messages } });
  const setNotificationSessions = (sessions: boolean) =>
    setPrefs({ notifications: { ...prefs.notifications, sessions } });
  const setNotificationCalls = (calls: boolean) =>
    setPrefs({ notifications: { ...prefs.notifications, calls } });
  const notificationsDisabled = notify === 'denied' || notify === 'unsupported';

  return (
    <div className="space-y-3">
      <SettingRow label="Theme">
        <div className="flex rounded-md border border-edge bg-surface p-0.5">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={prefs.theme === option.value}
              onClick={() => setPrefs({ theme: option.value })}
              className={segmentButton(prefs.theme === option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Accent">
        <div className="flex items-center gap-2">
          {ACCENTS.map((accent) => (
            <Tooltip key={accent} content={`${ACCENT_LABELS[accent]} accent`}>
              <button
                type="button"
                aria-label={`${ACCENT_LABELS[accent]} accent`}
                aria-pressed={prefs.accent === accent}
                onClick={() => setPrefs({ accent })}
                className={`flex size-8 items-center justify-center rounded-md border border-edge ${
                  prefs.accent === accent ? 'ring-2 ring-accent-text ring-offset-1 ring-offset-surface-raised' : ''
                }`}
              >
                <span className={`size-4 rounded-full ${SWATCH_CLASSES[accent]}`} />
              </button>
            </Tooltip>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Text size">
        <div className="grid grid-cols-4 rounded-md border border-edge bg-surface p-0.5">
          {FONT_SCALES.map((fontScale) => (
            <button
              key={fontScale}
              type="button"
              aria-label={`${FONT_LABELS[fontScale]} text size`}
              aria-pressed={prefs.fontScale === fontScale}
              onClick={() => setPrefs({ fontScale })}
              className={segmentButton(prefs.fontScale === fontScale)}
            >
              {FONT_LABELS[fontScale]}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="High contrast">
        <button
          type="button"
          aria-label="High contrast"
          aria-pressed={prefs.highContrast}
          onClick={() => setPrefs({ highContrast: !prefs.highContrast })}
          className={`flex h-8 w-16 items-center rounded-full border px-1 ${
            prefs.highContrast
              ? 'justify-end border-accent bg-accent text-on-accent'
              : 'justify-start border-edge-strong bg-surface text-fg-muted'
          }`}
        >
          <span className="size-5 rounded-full bg-current" />
        </button>
      </SettingRow>

      <SettingRow label="Motion">
        <div className="flex rounded-md border border-edge bg-surface p-0.5">
          {MOTION_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={prefs.motion === option.value}
              onClick={() => setPrefs({ motion: option.value })}
              className={segmentButton(prefs.motion === option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow label="Notifications">
        <Tooltip content={BELL_TITLES[notify]}>
          <button
            type="button"
            onClick={(e) => {
              if (notificationsDisabled) {
                e.preventDefault();
                return;
              }
              void toggleNotifications().then(setNotify);
            }}
            aria-disabled={notificationsDisabled || undefined}
            aria-label={BELL_TITLES[notify]}
            aria-pressed={notify === 'on'}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body aria-disabled:opacity-40"
          >
            {notify === 'on' ? <BellIcon /> : <BellOffIcon />}
            <span>{notify === 'on' ? 'On' : notify === 'off' ? 'Off' : 'Blocked'}</span>
          </button>
        </Tooltip>
      </SettingRow>

      <SettingRow label="Messages">
        <select
          aria-label="Message notifications"
          value={prefs.notifications.messages}
          onChange={(event) =>
            setNotificationMessages(event.target.value as NotificationMessagePref)
          }
          className="h-8 w-full rounded-md border border-edge bg-surface px-2 text-xs text-fg-secondary"
        >
          {MESSAGE_NOTIFICATION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow label="Agent sessions">
        <button
          type="button"
          aria-label="Agent sessions notifications"
          aria-pressed={prefs.notifications.sessions}
          onClick={() => setNotificationSessions(!prefs.notifications.sessions)}
          className={toggleButton(prefs.notifications.sessions)}
        >
          <span className="size-5 rounded-full bg-current" />
        </button>
      </SettingRow>

      <SettingRow label="Calls">
        <button
          type="button"
          aria-label="Call notifications"
          aria-pressed={prefs.notifications.calls}
          onClick={() => setNotificationCalls(!prefs.notifications.calls)}
          className={toggleButton(prefs.notifications.calls)}
        >
          <span className="size-5 rounded-full bg-current" />
        </button>
      </SettingRow>

      <SettingRow label="GitHub">
        <Tooltip content={connectionsAvailable ? 'Manage GitHub connection' : 'GitHub connections unavailable'}>
          <button
            type="button"
            onClick={onConnectGitHub}
            className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
          >
            <span
              className={`size-2 rounded-full ${
                githubConnection?.connected ? 'bg-success' : connectionsAvailable ? 'bg-warning' : 'bg-fg-muted/60'
              }`}
            />
            <span>
              {githubConnection?.connected
                ? `${githubConnection.accountLabel ?? 'Connected'} · ${githubConnectionLabel(githubConnection.tokenKind)}`
                : connectionsAvailable
                  ? githubConnection?.status === 'needs_auth'
                    ? 'Needs auth'
                    : 'Public read'
                  : 'Unavailable'}
            </span>
          </button>
        </Tooltip>
      </SettingRow>

      <SettingRow label="Claude Code">
        <button
          type="button"
          onClick={onConnectClaude}
          className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
        >
          <span
            className={`size-2 rounded-full ${
              claudeStatus?.connected ? 'bg-success' : 'bg-warning'
            }`}
          />
          <span>{claudeStatus?.connected ? 'Connected' : 'Connect'}</span>
        </button>
      </SettingRow>

      <SettingRow label="Codex">
        <button
          type="button"
          onClick={onConnectCodex}
          className="flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body"
        >
          <span
            className={`size-2 rounded-full ${
              codexStatus?.connected ? 'bg-success' : 'bg-warning'
            }`}
          />
          <span>{codexStatus?.connected ? 'Connected' : 'Connect'}</span>
        </button>
      </SettingRow>

      <div className="border-t border-edge pt-3 text-2xs leading-5 text-fg-muted">
        Atrium is AGPL-3.0-or-later.{' '}
        <a
          href={SOURCE_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          Source
        </a>
        {' · '}
        <a
          href={LICENSE_URL}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-accent-text hover:underline"
        >
          License
        </a>
      </div>
    </div>
  );
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function githubConnectionLabel(tokenKind: ConnectionStatus['tokenKind']): string {
  switch (tokenKind) {
    case 'app_installation':
      return 'App installation';
    case 'app_user':
      return 'GitHub user';
    case 'pat':
      return 'PAT';
    case 'public_read':
      return 'Public';
    default:
      return 'GitHub';
  }
}
