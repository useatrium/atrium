import { Option, Schema } from 'effect';

const NullableStringSchema = Schema.Union(Schema.String, Schema.Null);
const NonNegativeIntegerSchema = Schema.Number.pipe(Schema.int(), Schema.nonNegative());
const NullableNonNegativeIntegerSchema = Schema.Union(NonNegativeIntegerSchema, Schema.Null);

export const NormalizedEntryTargetTypeSchema = Schema.Literal('event', 'record', 'artifact');
export type NormalizedEntryTargetType = Schema.Schema.Type<typeof NormalizedEntryTargetTypeSchema>;

export const NormalizedEntryLocationSchema = Schema.mutable(
  Schema.Struct({
    workspaceId: Schema.String,
    channelId: NullableStringSchema,
    channelName: NullableStringSchema,
    threadRootEventId: NullableNonNegativeIntegerSchema,
    sessionId: NullableStringSchema,
    sessionTitle: NullableStringSchema,
  }),
);

export const NormalizedEntrySchema = Schema.mutable(
  Schema.Struct({
    handle: Schema.String,
    kind: Schema.String,
    actor: NullableStringSchema,
    actorLabel: NullableStringSchema,
    text: Schema.String,
    meta: Schema.mutable(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
    targetType: NormalizedEntryTargetTypeSchema,
    sourceRefs: Schema.mutable(Schema.Array(Schema.String)),
    tombstoned: Schema.Boolean,
    location: NormalizedEntryLocationSchema,
  }),
);
export type NormalizedEntry = Schema.Schema.Type<typeof NormalizedEntrySchema>;

export const EntryReferenceLatestSchema = Schema.mutable(
  Schema.Struct({
    eventId: NonNegativeIntegerSchema,
    handle: Schema.String,
    channelId: Schema.String,
    threadRootEventId: NullableNonNegativeIntegerSchema,
    actorLabel: NullableStringSchema,
    excerpt: Schema.String,
    ts: Schema.String,
  }),
);
export type EntryReferenceLatest = Schema.Schema.Type<typeof EntryReferenceLatestSchema>;

export const EntryReferenceSummarySchema = Schema.mutable(
  Schema.Struct({
    count: NonNegativeIntegerSchema,
    latest: Schema.mutable(Schema.Array(EntryReferenceLatestSchema)),
  }),
);
export type EntryReferenceSummary = Schema.Schema.Type<typeof EntryReferenceSummarySchema>;

export const EntryReferencesResponseSchema = Schema.mutable(
  Schema.Struct({
    references: Schema.mutable(Schema.Record({ key: Schema.String, value: EntryReferenceSummarySchema })),
  }),
);
export type EntryReferencesResponse = Schema.Schema.Type<typeof EntryReferencesResponseSchema>;
export type EntryReferenceMap = EntryReferencesResponse['references'];

// Loose on purpose: the server preserves route-specific bad_handle and
// too_many_handles responses after this boundary decode.
export const EntryReferencesQueryBodySchema = Schema.Struct({
  handles: Schema.optional(Schema.Unknown),
});

function decodeOptional<A>(schema: Schema.Schema<A>, input: unknown): A | undefined {
  const decoded = Schema.decodeUnknownOption(schema)(input);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

export function decodeNormalizedEntry(input: unknown): NormalizedEntry | null {
  return decodeOptional(NormalizedEntrySchema, input) ?? null;
}

export function decodeEntryReferenceSummary(input: unknown): EntryReferenceSummary | null {
  return decodeOptional(EntryReferenceSummarySchema, input) ?? null;
}

export function parseEntryReferenceMap(input: unknown): EntryReferenceMap {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const references = (input as { references?: unknown }).references;
  if (!references || typeof references !== 'object' || Array.isArray(references)) return {};

  const parsed: EntryReferenceMap = {};
  for (const [handle, summary] of Object.entries(references)) {
    const decoded = decodeEntryReferenceSummary(summary);
    if (decoded) parsed[handle] = decoded;
  }
  return parsed;
}
