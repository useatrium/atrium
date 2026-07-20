import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ACCENTS,
  FONT_SCALES,
  type Accent,
  type FontScale,
  type MotionPref,
  type NotificationMessagePref,
  type ThemeMode,
} from '@atrium/surface-client';
import {
  api,
  type ConnectionStatus,
  type CreateStaticHeaderCredentialBody,
  type CredentialStoreItem,
  type CredentialStoreStatus,
  type ProviderCredentialStatus,
} from '../api';
import { notificationState, toggleNotifications, type NotifyState } from '../notify';
import { navigate, parseInAppRoute, useLocation } from '../router';
import { useTheme } from '../theme';
import { Tooltip } from './a11y';
import { BellIcon, BellOffIcon, EyeIcon, EyeOffIcon } from './icons';

const SOURCE_URL = 'https://github.com/useatrium/atrium';
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

const SETTINGS_SECTIONS = [
  { slug: 'appearance', label: 'Appearance' },
  { slug: 'notifications', label: 'Notifications' },
  { slug: 'connections', label: 'Connections' },
  { slug: 'agents', label: 'Agents' },
  { slug: 'about', label: 'About' },
] as const;

type SettingsSectionSlug = (typeof SETTINGS_SECTIONS)[number]['slug'];

const DEFAULT_SETTINGS_SECTION: SettingsSectionSlug = SETTINGS_SECTIONS[0].slug;

function isSettingsSectionSlug(value: string | null | undefined): value is SettingsSectionSlug {
  return SETTINGS_SECTIONS.some((section) => section.slug === value);
}

function resolveSettingsSection(value: string | null | undefined): SettingsSectionSlug {
  return isSettingsSectionSlug(value) ? value : DEFAULT_SETTINGS_SECTION;
}

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
      <div className="min-h-0 flex-1">
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
  );
}

function SettingsControls({
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
  const location = useLocation();
  const route = parseInAppRoute(location.pathname);
  const { prefs, setPrefs } = useTheme();
  const requestedSection = route?.surface === 'settings' ? route.settingsSection : null;
  const activeSection = resolveSettingsSection(requestedSection);
  const shouldScrollToSection = route?.surface === 'settings';
  const sectionRefs = useRef<Partial<Record<SettingsSectionSlug, HTMLElement>>>({});
  const segmentButton = (active: boolean) =>
    `h-8 flex-1 rounded px-2 text-xs font-medium max-md:h-11 max-md:px-3 max-md:text-sm ${
      active ? 'bg-accent text-on-accent' : 'text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body'
    }`;
  const toggleButton = (active: boolean) =>
    `flex h-8 w-16 items-center rounded-full border px-1 max-md:h-11 max-md:w-20 ${
      active
        ? 'justify-end border-accent bg-accent text-on-accent'
        : 'justify-start border-edge-strong bg-surface text-fg-muted'
    }`;
  // Shared recipe for the connection status pills (Device / GitHub / Claude /
  // Codex): one bordered, transparent-fill button with a status dot. Kept a raw
  // recipe rather than the Button primitive because its transparent fill and
  // mobile full-width/larger-text treatment don't map to a Button variant.
  const connectionButtonClass =
    'flex h-8 items-center gap-2 rounded-md border border-edge px-2 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg-body max-md:min-h-11 max-md:w-full max-md:px-3 max-md:text-sm';
  const setNotificationMessages = (messages: NotificationMessagePref) =>
    setPrefs({ notifications: { ...prefs.notifications, messages } });
  const setNotificationSessions = (sessions: boolean) =>
    setPrefs({ notifications: { ...prefs.notifications, sessions } });
  const setNotificationCalls = (calls: boolean) => setPrefs({ notifications: { ...prefs.notifications, calls } });
  const notificationsDisabled = notify === 'denied' || notify === 'unsupported';
  const setSectionRef = (section: SettingsSectionSlug) => (element: HTMLElement | null) => {
    if (element) sectionRefs.current[section] = element;
    else delete sectionRefs.current[section];
  };
  const openSection = (section: SettingsSectionSlug) => {
    navigate(`/settings/${section}`);
  };

  useEffect(() => {
    if (!shouldScrollToSection) return;
    sectionRefs.current[activeSection]?.scrollIntoView?.({ block: 'start' });
  }, [activeSection, shouldScrollToSection]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col md:flex-row">
        <nav
          aria-label="Settings sections"
          className="sticky top-0 z-sticky shrink-0 border-b border-edge bg-surface px-3 py-2 md:w-44 md:self-start md:border-b-0 md:border-r md:px-2 md:py-4"
        >
          <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible [&::-webkit-scrollbar]:hidden">
            {SETTINGS_SECTIONS.map((section) => {
              const active = activeSection === section.slug;
              return (
                <button
                  key={section.slug}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  onClick={() => openSection(section.slug)}
                  className={`shrink-0 rounded px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-edge-focus md:w-full md:text-left ${
                    active
                      ? 'bg-surface-raised text-fg shadow-sm'
                      : 'text-fg-muted hover:bg-surface-overlay hover:text-fg-secondary'
                  }`}
                >
                  {section.label}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="min-w-0 flex-1">
          <div className="max-w-2xl px-4 py-4">
            <div className="space-y-4">
              <section
                ref={setSectionRef('appearance')}
                aria-label="Appearance"
                className="scroll-mt-16 space-y-3 md:scroll-mt-4"
              >
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
                          className={`flex size-8 items-center justify-center rounded-md border border-edge max-md:size-11 ${
                            prefs.accent === accent
                              ? 'ring-2 ring-accent-text ring-offset-1 ring-offset-surface-raised'
                              : ''
                          }`}
                        >
                          <span className={`size-4 rounded-full max-md:size-5 ${SWATCH_CLASSES[accent]}`} />
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
                    className={toggleButton(prefs.highContrast)}
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
              </section>

              <SettingsSectionDivider />

              <section
                ref={setSectionRef('notifications')}
                aria-label="Notifications"
                className="scroll-mt-16 space-y-3 md:scroll-mt-4"
              >
                <SettingRow label="Device">
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
                      className={`${connectionButtonClass} aria-disabled:opacity-40`}
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
                    onChange={(event) => setNotificationMessages(event.target.value as NotificationMessagePref)}
                    className="h-8 w-full rounded-md border border-edge bg-surface px-2 text-xs text-fg-secondary max-md:h-11 max-md:px-3 max-md:text-sm"
                  >
                    {MESSAGE_NOTIFICATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </SettingRow>

                <SettingRow label="Agents">
                  <button
                    type="button"
                    aria-label="Agent notifications"
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
              </section>

              <SettingsSectionDivider />

              <section
                ref={setSectionRef('connections')}
                aria-label="Connections"
                className="scroll-mt-16 space-y-3 md:scroll-mt-4"
              >
                <SettingRow label="GitHub">
                  <Tooltip
                    content={connectionsAvailable ? 'Manage GitHub connection' : 'GitHub connections unavailable'}
                  >
                    <button type="button" onClick={onConnectGitHub} className={connectionButtonClass}>
                      <span
                        className={`size-2 rounded-full ${
                          githubConnection?.connected
                            ? 'bg-success'
                            : connectionsAvailable
                              ? 'bg-warning'
                              : 'bg-fg-muted/60'
                        }`}
                      />
                      <span className="min-w-0 truncate">
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
              </section>

              <SettingsSectionDivider />

              <section
                ref={setSectionRef('agents')}
                aria-label="Agents"
                className="scroll-mt-16 space-y-3 md:scroll-mt-4"
              >
                <SettingRow label="Claude Code">
                  <button type="button" onClick={onConnectClaude} className={connectionButtonClass}>
                    <span className={`size-2 rounded-full ${claudeStatus?.connected ? 'bg-success' : 'bg-warning'}`} />
                    <span>{claudeStatus?.connected ? 'Connected' : 'Connect'}</span>
                  </button>
                </SettingRow>

                <SettingRow label="Codex">
                  <button type="button" onClick={onConnectCodex} className={connectionButtonClass}>
                    <span className={`size-2 rounded-full ${codexStatus?.connected ? 'bg-success' : 'bg-warning'}`} />
                    <span>{codexStatus?.connected ? 'Connected' : 'Connect'}</span>
                  </button>
                </SettingRow>

                <SettingRow label="Credential Store">
                  <button type="button" onClick={() => navigate('/credentials')} className={connectionButtonClass}>
                    <EyeIcon size={14} />
                    <span>Open advanced panel</span>
                  </button>
                </SettingRow>
              </section>

              <SettingsSectionDivider />

              <section ref={setSectionRef('about')} aria-label="About" className="scroll-mt-16 md:scroll-mt-4">
                <div className="text-2xs leading-5 text-fg-muted">
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
              </section>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function CredentialStoreSurface() {
  const [credentialStore, setCredentialStore] = useState<CredentialStoreStatus | null>(null);
  const [credentialStoreError, setCredentialStoreError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCredentialStoreError(null);
    void api
      .credentialStore()
      .then(({ credentialStore }) => {
        if (!cancelled) setCredentialStore(credentialStore);
      })
      .catch((err) => {
        if (cancelled) return;
        setCredentialStore(null);
        setCredentialStoreError(err instanceof Error ? err.message : 'Could not load credential store');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="border-b border-edge px-4 py-3">
        <h2 className="text-sm font-bold text-fg">Credential Store</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-5xl px-4 py-4">
          <CredentialStorePanel store={credentialStore} error={credentialStoreError} />
        </div>
      </div>
    </div>
  );
}

function SettingsSectionDivider() {
  return <div className="border-t border-edge" />;
}

function CredentialStorePanel({ store, error }: { store: CredentialStoreStatus | null; error: string | null }) {
  const [draft, setDraft] = useState<CreateStaticHeaderCredentialBody>({
    name: '',
    host: '',
    header: 'Authorization',
    secret: '',
    formatter: 'bearer',
  });
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [panelStore, setPanelStore] = useState(store);
  const [formError, setFormError] = useState<string | null>(null);
  useEffect(() => setPanelStore(store), [store]);
  const visibleStore = panelStore ?? store;
  const canSave = Boolean(draft.name.trim() && draft.host.trim() && draft.header.trim() && draft.secret.trim());
  const updateDraft = <K extends keyof CreateStaticHeaderCredentialBody>(
    key: K,
    value: CreateStaticHeaderCredentialBody[K],
  ) => setDraft((prev) => ({ ...prev, [key]: value }));
  const createCredential = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const { credentialStore } = await api.createStaticHeaderCredential(draft);
      setPanelStore(credentialStore);
      setDraft({ name: '', host: '', header: 'Authorization', secret: '', formatter: 'bearer' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not create credential');
    } finally {
      setSaving(false);
    }
  };
  if (error) {
    return <div className="rounded-md border border-danger-border/40 px-3 py-2 text-xs text-danger-text">{error}</div>;
  }
  if (!visibleStore) {
    return (
      <div className="rounded-md border border-edge px-3 py-2 text-xs text-fg-muted">Loading credential store...</div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-edge bg-surface px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-fg-secondary">Add static header credential</div>
            <div className="mt-0.5 text-xs text-fg-muted">
              Store a secret in iron-control, inject it into one HTTP header, and grant it to you.
            </div>
          </div>
          <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-2xs text-fg-muted">Advanced</span>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <CredentialInput
            label="Name"
            value={draft.name}
            placeholder="Linear API token"
            onChange={(value) => updateDraft('name', value)}
          />
          <CredentialInput
            label="Host"
            value={draft.host}
            placeholder="api.linear.app"
            onChange={(value) => updateDraft('host', value)}
          />
          <CredentialInput
            label="Header"
            value={draft.header}
            placeholder="Authorization"
            onChange={(value) => updateDraft('header', value)}
          />
          <label className="min-w-0 text-2xs font-semibold uppercase tracking-wider text-fg-muted">
            Format
            <select
              value={draft.formatter ?? ''}
              onChange={(event) => updateDraft('formatter', event.target.value === 'bearer' ? 'bearer' : undefined)}
              className="mt-1 h-9 w-full rounded-md border border-edge bg-surface px-2 text-xs font-normal normal-case tracking-normal text-fg-secondary"
            >
              <option value="bearer">Bearer token</option>
              <option value="">Raw value</option>
            </select>
          </label>
          <label className="min-w-0 text-2xs font-semibold uppercase tracking-wider text-fg-muted sm:col-span-2">
            Secret value
            <div className="mt-1 flex h-9 min-w-0 rounded-md border border-edge bg-surface">
              <input
                type={showSecret ? 'text' : 'password'}
                value={draft.secret}
                placeholder="Stored in iron-control; never displayed again"
                onChange={(event) => updateDraft('secret', event.target.value)}
                className="min-w-0 flex-1 bg-transparent px-2 text-xs font-normal normal-case tracking-normal text-fg-secondary outline-none"
              />
              <Tooltip content={showSecret ? 'Hide secret' : 'Show secret'}>
                <button
                  type="button"
                  aria-label={showSecret ? 'Hide secret' : 'Show secret'}
                  aria-pressed={showSecret}
                  onClick={() => setShowSecret((value) => !value)}
                  className="grid w-9 shrink-0 place-items-center border-l border-edge text-fg-muted hover:bg-surface-overlay hover:text-fg-body"
                >
                  {showSecret ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                </button>
              </Tooltip>
            </div>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!canSave || saving || !visibleStore.configured}
            onClick={createCredential}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-on-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Adding...' : 'Add credential'}
          </button>
          {!visibleStore.configured ? <span className="text-xs text-fg-muted">iron-control is unavailable</span> : null}
          {formError ? <span className="text-xs text-danger-text">{formError}</span> : null}
        </div>
      </div>
      <div className="grid gap-2 text-xs text-fg-muted sm:grid-cols-3">
        <CredentialStoreStat label="iron-control" value={visibleStore.configured ? 'Configured' : 'Unavailable'} />
        <CredentialStoreStat label="Namespace" value={visibleStore.namespace ?? 'none'} />
        <CredentialStoreStat label="Workspace" value={visibleStore.workspaceId ?? 'none'} />
      </div>
      <div className="space-y-2">
        {visibleStore.items.length === 0 ? (
          <div className="rounded-md border border-edge px-3 py-2 text-xs text-fg-muted">No credentials found.</div>
        ) : (
          visibleStore.items.map((item) => <CredentialStoreRow key={item.id} item={item} />)
        )}
      </div>
    </div>
  );
}

function CredentialInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="min-w-0 text-2xs font-semibold uppercase tracking-wider text-fg-muted">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1 h-9 w-full rounded-md border border-edge bg-surface px-2 text-xs font-normal normal-case tracking-normal text-fg-secondary"
      />
    </label>
  );
}

function CredentialStoreStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border border-edge bg-surface px-3 py-2">
      <div className="text-2xs font-semibold uppercase tracking-wider text-fg-muted">{label}</div>
      <div className="mt-1 truncate font-mono text-xs text-fg-secondary" title={value}>
        {value}
      </div>
    </div>
  );
}

function CredentialStoreRow({ item }: { item: CredentialStoreItem }) {
  const refs = credentialStoreRefs(item);
  return (
    <div className="rounded-md border border-edge bg-surface px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className={`size-2 rounded-full ${item.connected ? 'bg-success' : 'bg-warning'}`} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg-secondary" title={item.label}>
          {item.label}
        </span>
        {item.active ? (
          <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-2xs text-fg-muted">active</span>
        ) : null}
        <span className="rounded bg-surface-overlay px-1.5 py-0.5 text-2xs text-fg-muted">
          {credentialBackingLabel(item.backingStore)}
        </span>
      </div>
      <div className="mt-2 grid gap-1 text-2xs text-fg-muted sm:grid-cols-2">
        <CredentialStoreMeta label="Status" value={item.status} />
        <CredentialStoreMeta label="Kind" value={credentialKindLabel(item)} />
        <CredentialStoreMeta label="Scope" value={item.scope ?? 'none'} />
        <CredentialStoreMeta label="Updated" value={formatCredentialTime(item.updatedAt)} />
      </div>
      {refs.length > 0 ? (
        <details className="mt-2 border-t border-edge pt-2">
          <summary className="cursor-pointer text-2xs font-semibold uppercase tracking-wider text-fg-muted">
            Technical details
          </summary>
          <div className="mt-2 space-y-1">
            {refs.map(([label, value]) => (
              <CredentialStoreMeta key={label} label={label} value={value} mono />
            ))}
          </div>
        </details>
      ) : null}
      {item.lastError ? <div className="mt-2 text-xs text-danger-text">{item.lastError}</div> : null}
    </div>
  );
}

function CredentialStoreMeta({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <span className="font-semibold uppercase tracking-wider text-fg-muted">{label}</span>
      <span className={`min-w-0 truncate text-fg-secondary ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </span>
    </div>
  );
}

function credentialKindLabel(item: CredentialStoreItem): string {
  if (item.kind === 'static_header') return item.tokenKind ?? 'Static header';
  if (item.kind === 'agent_provider') return item.backingStore === 'iron_control' ? 'Agent OAuth proxy' : 'Agent token';
  if (item.tokenKind === 'app_installation') return 'GitHub App installation';
  if (item.tokenKind === 'app_user') return 'GitHub user OAuth';
  if (item.tokenKind === 'pat') return 'GitHub PAT';
  return item.tokenKind ?? 'Connection';
}

function credentialStoreRefs(item: CredentialStoreItem): Array<[string, string]> {
  return [
    ['Actor ID', item.ironControl.principalForeignId],
    ['Rotating credential ID', item.ironControl.brokerCredentialId],
    ['Injected secret ID', item.ironControl.staticSecretId],
    ['Foreign ID', item.ironControl.staticSecretForeignId],
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function credentialBackingLabel(backingStore: CredentialStoreItem['backingStore']): string {
  switch (backingStore) {
    case 'atrium_local':
      return 'Atrium local';
    case 'iron_control':
      return 'iron-control';
    case 'public_read':
      return 'Public read';
    default:
      return 'Unavailable';
  }
}

function formatCredentialTime(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[5.75rem_minmax(0,1fr)] items-center gap-2 max-md:grid-cols-1 max-md:items-stretch max-md:gap-1.5">
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
