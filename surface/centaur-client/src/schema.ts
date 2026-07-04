import { Option, Schema } from "effect";
import type { JsonObject, JsonValue } from "./types.js";

export const JsonPrimitiveSchema = Schema.Union(
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Null,
);

export const JsonValueSchema: Schema.Schema<JsonValue> = Schema.suspend(
  (): Schema.Schema<JsonValue> =>
    Schema.Union(
      JsonPrimitiveSchema,
      Schema.Array(JsonValueSchema) as unknown as Schema.Schema<JsonValue>,
      Schema.Record({ key: Schema.String, value: JsonValueSchema }) as Schema.Schema<JsonValue>,
    ),
);

export const JsonObjectSchema = Schema.Record({
  key: Schema.String,
  value: JsonValueSchema,
}) as Schema.Schema<JsonObject>;

export const ErrorCodeBodySchema = Schema.Struct({
  code: Schema.optional(Schema.String),
  error: Schema.optional(
    Schema.Union(
      Schema.String,
      Schema.Struct({
        code: Schema.optional(Schema.String),
      }),
    ),
  ),
});

const EventIdFieldSchema = Schema.Union(Schema.Number, Schema.String);

export function decodeOptional<A>(schema: Schema.Schema<A>, input: unknown): A | undefined {
  const decoded = Schema.decodeUnknownOption(schema)(input);
  return Option.isSome(decoded) ? decoded.value : undefined;
}

export function parseJsonValueOrString(raw: string): JsonValue {
  try {
    return decodeOptional(JsonValueSchema, JSON.parse(raw) as unknown) ?? raw;
  } catch {
    return raw;
  }
}

export function parseJsonValue(raw: string): JsonValue | undefined {
  if (!raw) return undefined;
  try {
    return decodeOptional(JsonValueSchema, JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function jsonObjectFrom(input: unknown): JsonObject | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return decodeOptional(JsonObjectSchema, input);
}

export function isJsonObject(input: unknown): input is JsonObject {
  return jsonObjectFrom(input) !== undefined;
}

export function eventIdFrom(input: unknown): number | undefined {
  const value = decodeOptional(EventIdFieldSchema, input);
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

export function stringField(data: JsonObject, key: string): string {
  return decodeOptional(Schema.String, data[key]) ?? "";
}

export function errorCodeFromBody(body: unknown): string | undefined {
  const decoded = decodeOptional(ErrorCodeBodySchema, body);
  if (!decoded) return undefined;
  if (decoded.code) return decoded.code;
  if (typeof decoded.error === "string") return decoded.error;
  return decoded.error?.code;
}
