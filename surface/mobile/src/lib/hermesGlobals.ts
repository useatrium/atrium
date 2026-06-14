// Hermes (React Native's JS engine) does not define the DOM `Event` constructor.
// `livekit-client` references the GLOBAL `Event` — both `new Event(...)` and
// `eventOrError instanceof Event` in its connection abort handler — and
// `@livekit/react-native`'s `registerGlobals()` polyfills WebRTC + web streams
// but NOT `Event`. Without this, the first connection abort throws
// `ReferenceError: Property 'Event' doesn't exist`, which fails the whole call
// (the in-flight `room.connect()` rejects, then teardown logs the dangling
// "cannot send signal request before connected, type: leave").
//
// Reuse the spec-compatible `Event` the WebRTC package already ships (it is the
// vendored `event-target-shim` implementation) rather than adding a new dep.
// Import this module *before* anything that touches `livekit-client`.
import { Event as WebRTCEvent } from '@livekit/react-native-webrtc';

const g = globalThis as Record<string, unknown>;

if (typeof g.Event === 'undefined') {
  g.Event = WebRTCEvent;
}
