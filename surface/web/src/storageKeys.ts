export const NOTIFICATIONS_STORAGE_KEY = 'atrium:notifications';
export const PREFS_STORAGE_KEY = 'atrium:prefs';
export const QUEUE_NUDGE_STORAGE_KEY = 'atrium:queue-nudge';
export const TRANSCRIPT_VIEW_STORAGE_KEY = 'atrium:transcript-view';

export const UNFURL_COLLAPSED_STORAGE_KEY = 'atrium:unfurl-collapsed';
export const SIDEBAR_WIDTH_STORAGE_KEY = 'atrium:sidebar-width';
export const SIDEBAR_COLLAPSED_STORAGE_KEY = 'atrium:sidebar-collapsed';
export const SESSION_PANE_WIDTH_STORAGE_KEY = 'atrium:session-pane-width';
export const THREAD_PANE_WIDTH_STORAGE_KEY = 'atrium:thread-pane-width';
export const WORK_DOCK_SIDE_WIDTH_STORAGE_KEY = 'atrium:work-dock-side-width';
export const WORK_DOCK_TOP_HEIGHT_STORAGE_KEY = 'atrium:work-dock-top-height';
export const AGENT_DOCK_OPEN_STORAGE_KEY = 'atrium:agent-dock-open';
export const AGENT_DOCK_WIDTH_STORAGE_KEY = 'atrium:agent-dock-width';
export const AGENT_DOCK_MINE_FILTER_STORAGE_KEY = 'atrium:agent-dock-mine-filter';

export const LEGACY_UNFURL_COLLAPSED_STORAGE_KEY = 'atrium.unfurl.collapsed';
export const LEGACY_SIDEBAR_WIDTH_STORAGE_KEY = 'atrium.sidebarWidth';
export const LEGACY_SESSION_PANE_WIDTH_STORAGE_KEY = 'atrium.sessionPaneWidth';
export const LEGACY_THREAD_PANE_WIDTH_STORAGE_KEY = 'atrium.threadPaneWidth';
export const LEGACY_WORK_DOCK_SIDE_WIDTH_STORAGE_KEY = 'atrium.workDockSideWidth';
export const LEGACY_WORK_DOCK_TOP_HEIGHT_STORAGE_KEY = 'atrium.workDockTopHeight';

export function readWithLegacy(key: string, legacyKey: string): string | null {
  const value = window.localStorage.getItem(key);
  if (value !== null) return value;
  const legacyValue = window.localStorage.getItem(legacyKey);
  if (legacyValue === null) return null;
  window.localStorage.setItem(key, legacyValue);
  window.localStorage.removeItem(legacyKey);
  return legacyValue;
}
