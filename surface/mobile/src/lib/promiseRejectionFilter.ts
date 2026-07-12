// Dev-only: silence a benign unhandled-rejection that livekit-client leaks.
//
// livekit-client bridges its signalling WebSocket through a WHATWG stream and,
// on the socket's `error` event, calls `controller.error(event)` — erroring the
// stream with the raw DOM `error`-type `Event`. On React Native the WebSocket
// fires a spurious `error` event (typically alongside a normal close during
// teardown/reconnect), so that stream rejects with a bare `Event` that nothing
// downstream awaits. It does not affect call connect / audio / teardown.
//
// React Native only tracks promise rejections in __DEV__ (it calls
// `HermesInternal.enablePromiseRejectionTracker`); production has no tracker, so
// this leak is completely silent there. The only symptom is a red LogBox during
// development. We re-install the tracker to drop event-shaped rejections — which
// are never legitimate application errors (those reject with `Error`) — while
// still surfacing every genuine unhandled rejection via `console.error`.

declare const __DEV__: boolean;

type RejectionTracker = (options: {
  allRejections?: boolean;
  onUnhandled?: (id: number, rejection: unknown) => void;
  onHandled?: (id: number) => void;
}) => void;

// A leaked DOM/WebRTC error event: not an `Error`, but shaped like a DOM Event.
function isEventShapedRejection(reason: unknown): boolean {
  if (reason instanceof Error) return false;
  if (reason == null || typeof reason !== 'object') return false;
  const EventCtor = (globalThis as { Event?: new (...args: never[]) => unknown }).Event;
  if (EventCtor && reason instanceof EventCtor) return true;
  const r = reason as { type?: unknown };
  return (
    typeof r.type === 'string' &&
    ('isTrusted' in reason || 'bubbles' in reason || 'currentTarget' in reason || 'composed' in reason)
  );
}

if (typeof __DEV__ !== 'undefined' && __DEV__) {
  const hermes = (globalThis as { HermesInternal?: { enablePromiseRejectionTracker?: RejectionTracker } })
    .HermesInternal;
  hermes?.enablePromiseRejectionTracker?.({
    allRejections: true,
    onHandled: () => {},
    onUnhandled: (id, rejection) => {
      if (isEventShapedRejection(rejection)) return; // benign livekit/WebRTC signalling event
      // Preserve dev visibility for real unhandled rejections.
      console.error(`Unhandled promise rejection (id: ${id}):`, rejection);
    },
  });
}
