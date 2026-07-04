# Effect adoption audit, 2026-07-04

## Current stance

Use Effect Schema at trust boundaries: route bodies/query/params, external service
responses, browser/native API responses, persisted JSON blobs, and wire events.
Do not broadly rewrite ordinary async application flow into `Effect` unless the
call path needs composable retries, cancellation, resource lifetime management,
or typed dependency injection.

## What is already working

- Server route decoding now uses `decodeRouteBody`, `decodeRouteQuery`, and
  `decodeRouteParams` across the busiest routes.
- Session response payloads are decoded before shared/mobile and web session
  clients return typed values.
- Centaur HTTP responses decode to JSON objects at the runtime boundary.
  HTTP failures and invalid response objects raise `CentaurApiError`; endpoint
  DTOs are still mostly typed casts.
- Preferences, entry references, normalized entries, calls, and session DTOs
  have shared schemas close to their TypeScript types.
- `exactOptionalPropertyTypes` is enabled where the surface is already clean:
  `shared`, `centaur-client`, and `e2e`.

## Good next adoption targets

- Shared `createApi` response methods that already have schemas: calls are now
  decoded; entry references and normalized entries are good candidates for the
  same pattern where callers expect exact response shapes.
- Files Hub response DTOs. This is a large surface with many direct web fetches,
  conflicts, version lists, labels, and file mutation responses. Add schemas when
  touching each endpoint rather than converting the whole file at once.
- Agent profile response DTOs. Request bodies already have schemas; response
  schemas would protect import/proposal/version payloads.
- WebSocket frames, `WireEvent` payloads, and message-history responses. These
  are high-value wire boundaries that still accept raw JSON/interface-shaped
  events in the shared client.
- OAuth/device-flow helpers in `web/src/api.ts`. These still use local raw
  `res.json() as T` casts and plain `Error`; they should eventually share the
  same `ApiError` and bad-response behavior as `createApi`.
- Native-only direct fetch helpers in `mobile/src/lib/entryResolve.ts`,
  `entryReferences.ts`, and markup authoring. Entry resolve/reference parsing
  already uses shared helpers; the remaining gap is consistent direct-fetch
  error and decode semantics.

## Error handling shape

- Server expected failures are mostly `DomainError(status, code, message)`.
- Client expected API failures are `ApiError(status, code, message)`.
- Centaur upstream failures are `CentaurApiError`, mapped at the app boundary so
  server-side Centaur auth failures do not masquerade as client auth failures.
- Malformed successful API responses now use `ApiError(502, "bad_response",
  "invalid server response")` in decoded clients.

## Gaps to avoid normalizing away

- Some direct browser fetches intentionally load bytes, previews, or SSE streams;
  these should not get JSON schemas.
- Some route schemas are intentionally loose (`Schema.Unknown`) because the route
  preserves route-specific validation messages after the boundary decode.
- Broad `exactOptionalPropertyTypes` for server/web/mobile should stay a cleanup
  project. Those packages still pass explicit `undefined` through option objects,
  React props, and fetch/media options.

## Effect features worth considering later

- `Schema` transformations for legacy wire compatibility, when tolerant parsing
  is better than rejecting old payloads.
- `Effect` retry, timeout, and schedule composition around external providers
  such as GitHub, OAuth, push, STT, and IronCore, where today's ad hoc `try`
  blocks hide policy.
- `Context`/`Layer` only if dependency wiring becomes difficult to test. Current
  Fastify dependency injection is simple enough to keep.
- `Cause` and typed errors only for workflows with multiple recoverable failure
  classes. For route handlers, `DomainError` is still the simpler public model.

## Effect references checked

- Schema introduction and transformations:
  <https://effect.website/docs/schema/introduction/>,
  <https://effect.website/docs/schema/transformations/>
- Retry, timeout, and schedules:
  <https://effect.website/docs/error-management/retrying/>,
  <https://effect.website/docs/error-management/timing-out/>,
  <https://effect.website/docs/scheduling/introduction/>
- Services and runtime:
  <https://effect.website/docs/requirements-management/services/>,
  <https://effect.website/docs/runtime/>
- Error cause and expected errors:
  <https://effect.website/docs/data-types/cause/>,
  <https://effect.website/docs/error-management/expected-errors/>
