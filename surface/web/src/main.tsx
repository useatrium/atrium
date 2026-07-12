import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installClientTelemetry } from './clientTelemetry';
import { ThemeProvider } from './theme';
import './index.css';

installClientTelemetry();

type NotificationClickMessage = {
  type: 'notification-click';
  channelId?: string;
  eventId?: string | number;
  sessionId?: string;
  threadRootId?: string | number;
};

function notificationClickMessage(data: unknown): NotificationClickMessage | null {
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;
  if (raw.type !== 'notification-click') return null;
  return {
    type: 'notification-click',
    ...(typeof raw.channelId === 'string' ? { channelId: raw.channelId } : {}),
    ...(typeof raw.eventId === 'string' || typeof raw.eventId === 'number' ? { eventId: raw.eventId } : {}),
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.threadRootId === 'string' || typeof raw.threadRootId === 'number'
      ? { threadRootId: raw.threadRootId }
      : {}),
  };
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const message = notificationClickMessage(event.data);
    if (!message) return;
    window.dispatchEvent(new CustomEvent('atrium:notification-click', { detail: message }));
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('service worker registration failed', err);
    });
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
