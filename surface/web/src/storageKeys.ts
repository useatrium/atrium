export const NOTIFICATIONS_STORAGE_KEY = 'atrium:notifications';
export const PREFS_STORAGE_KEY = 'atrium:prefs';
export const QUEUE_NUDGE_STORAGE_KEY = 'atrium:queue-nudge';
export const TRANSCRIPT_VIEW_STORAGE_KEY = 'atrium:transcript-view';

export const UNFURL_COLLAPSED_STORAGE_KEY = 'atrium:unfurl-collapsed';
export const SIDEBAR_AGENT_WORK_COLLAPSED_STORAGE_KEY = 'atrium:sidebar-agent-work-collapsed';
export const SIDEBAR_AGENT_WORK_RECENT_COLLAPSED_STORAGE_KEY = 'atrium:sidebar-agent-work-recent-collapsed';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'atrium:sidebar-width';
export const SESSION_PANE_WIDTH_STORAGE_KEY = 'atrium:session-pane-width';
export const THREAD_PANE_WIDTH_STORAGE_KEY = 'atrium:thread-pane-width';
export const WORK_DOCK_SIDE_WIDTH_STORAGE_KEY = 'atrium:work-dock-side-width';
export const WORK_DOCK_TOP_HEIGHT_STORAGE_KEY = 'atrium:work-dock-top-height';

export const LEGACY_UNFURL_COLLAPSED_STORAGE_KEY = 'atrium.unfurl.collapsed';
export const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = 'atrium.sidebarWidth';
export const LEGACY_SESSION_PANE_WIDTH_STORAGE_KEY = 'atrium.sessionPaneWidth';
export const LEGACY_THREAD_PANE_WIDTH_STORAGE_KEY = 'atrium.threadPaneWidth';
export const LEGACY_WORK_DOCK_SIDE_WIDTH_STORAGE_KEY = 'atrium.workDockSideWidth';
export const LEGACY_WORK_DOCK_TOP_HEIGHT_STORAGE_KEY = 'atrium.workDockTopHeight';

const LEGACY_SIDEBAR_AGENT_WORK_COLLAPSED_STORAGE_KEY = 'atrium.sidebarAgentWorkCollapsed';

export function sidebarAgentWorkCollapsedKey(userId: string): string {
  return `${SIDEBAR_AGENT_WORK_COLLAPSED_STORAGE_KEY}:${userId}`;
}

export function legacySidebarAgentWorkCollapsedKey(userId: string): string {
  return `${LEGACY_SIDEBAR_AGENT_WORK_COLLAPSED_STORAGE_KEY}:${userId}`;
}

/** New in the resting-state sidebar — no legacy key exists to migrate from. */
export function sidebarAgentWorkRecentCollapsedKey(userId: string): string {
  return `${SIDEBAR_AGENT_WORK_RECENT_COLLAPSED_STORAGE_KEY}:${userId}`;
}

export function readWithLegacy(key: string, legacyKey: string): string | null {
  const value = window.localStorage.getItem(key);
  if (value !== null) return value;
  const legacyValue = window.localStorage.getItem(legacyKey);
  if (legacyValue === null) return null;
  window.localStorage.setItem(key, legacyValue);
  window.localStorage.removeItem(legacyKey);
  return legacyValue;
}
