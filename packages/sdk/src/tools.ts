/**
 * Tools — the TS port of `cendor.sdk.tools`. Where Python derives a JSON Schema from type hints, TS
 * declares it with **zod 4** (`tool(fn, { parameters: z.object({...}) })`) and converts to JSON Schema
 * via zod 4's native `z.toJSONSchema`, producing the same per-provider tool shapes. Every tool's
 * execution is wrapped with `instrumentTool` so it emits a `ToolCall` on the bus (governance parity).
 */
import { instrumentTool } from '@cendor/core';
import { z } from 'zod';
import type { $ZodType } from 'zod/v4/core';

export type JsonSchema = Record<string, unknown>;
export type ToolFn = (args: Record<string, unknown>) => unknown;
/** A zod 4 schema. zod 3 schemas are rejected by {@link zodSchemaToJson} (see its note). */
export type ZodSchema = $ZodType;

export interface ToolOptions {
  name?: string;
  description?: string;
  parameters?: ZodSchema;
  /** A pre-built JSON Schema (bypasses zod conversion — used when re-wrapping an existing tool). */
  jsonSchema?: JsonSchema;
  /** Set false to skip `instrumentTool` wrapping (e.g. a wrapper whose inner tool already emits). */
  instrument?: boolean;
}

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

/** True for a zod 4 schema — the `_zod` internals marker. zod 3 schemas carry `_def` but no `_zod`. */
export function isZod4Schema(x: unknown): x is ZodSchema {
  return !!x && typeof x === 'object' && '_zod' in x;
}

/**
 * Convert a zod 4 schema to the JSON Schema the provider formatters embed. Uses zod 4's native
 * `z.toJSONSchema` with `io: 'input'` — tool parameters describe what the *model* must produce, so a
 * `.default()` field stays optional rather than being forced into `required` — and stamps
 * `additionalProperties: false` onto every object (zod omits it under `io: 'input'`) for clean
 * provider payloads. A zod **3** schema is rejected loudly rather than silently yielding an empty
 * schema: pass a zod 4 schema (on zod 3.25+, `import { z } from 'zod/v4'`; or upgrade zod to `^4`) or
 * a pre-built `jsonSchema:`.
 */
export function zodSchemaToJson(schema: ZodSchema): JsonSchema {
  if (!isZod4Schema(schema)) {
    throw new TypeError(
      'cendor: a tool/output schema must be a zod 4 schema — a zod 3 schema was passed. On zod ' +
        "3.25+ change the import to `import { z } from 'zod/v4'`, upgrade zod to ^4, or pass a raw " +
        'JSON Schema via `jsonSchema:`.',
    );
  }
  const js = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override: (ctx) => {
      const s = ctx.jsonSchema as { type?: unknown; additionalProperties?: unknown };
      if (s.type === 'object' && s.additionalProperties === undefined)
        s.additionalProperties = false;
    },
  }) as JsonSchema;
  // biome-ignore lint/performance/noDelete: strip the JSON-schema meta key for clean provider payloads
  delete js.$schema;
  return js;
}

function toJsonSchema(schema: ZodSchema | undefined): JsonSchema {
  if (!schema) return EMPTY_SCHEMA;
  return zodSchemaToJson(schema);
}

/**
 * JSON-Schema keys the Gemini `Schema` proto does not model, stripped by {@link geminiSanitize}.
 *
 * `additional_properties` is google-genai's own snake_case spelling of the same field. `@google/genai`
 * knows only the camelCase name, so a snake_case key is forwarded verbatim to an API that has never
 * heard of it — measured on 2.13.0. `title` and `default` ARE declared by the proto (so they are
 * accepted); they are dropped for parity with `cendor-sdk`'s `_GEMINI_DROP_KEYS`, and both are hints
 * rather than constraints, so nothing is lost.
 *
 * `$defs` / `$ref` are deliberately NOT dropped: removing only one of the pair breaks a nested model
 * outright. `$schema` is not dropped either — see {@link geminiSanitize}.
 */
const GEMINI_DROP_KEYS: ReadonlySet<string> = new Set([
  'additionalProperties',
  'additional_properties',
  'title',
  'default',
]);

/** JSON-Schema keys whose value maps *user-chosen names* → schema. Their keys are data, never
 * schema keywords, so a field genuinely named `title` or `default` must survive sanitizing. */
const NAME_KEYED: ReadonlySet<string> = new Set([
  'properties',
  '$defs',
  'definitions',
  'patternProperties',
  'dependentSchemas',
]);

const isRecord = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === 'object' && !Array.isArray(x);

function sanitizeNode(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeNode);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (GEMINI_DROP_KEYS.has(k)) continue;
    out[k] = NAME_KEYED.has(k) && isRecord(v) ? sanitizeNameKeyedMap(v) : sanitizeNode(v);
  }
  return out;
}

function sanitizeNameKeyedMap(node: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, sub] of Object.entries(node)) out[name] = sanitizeNode(sub);
  return out;
}

function deepCopy(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(deepCopy);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = deepCopy(v);
  return out;
}

/**
 * Strip the JSON-Schema keys Gemini rejects, recursively. **Returns a new structure — the caller's
 * schema object is never mutated.** Used for both a tool's `parameters` ({@link Tool.toGemini}) and an
 * agent's `outputType` schema on `config.responseSchema` (`providers.GeminiProvider.buildKwargs`); one
 * sanitizer, so the two can't drift.
 *
 * `@google/genai` strips camelCase `additionalProperties` itself — but only while recursing
 * `properties` / `items` / `anyOf`. A `prefixItems` (zod tuple) or `$defs` subtree is copied verbatim,
 * so the key reaches the wire and the Gemini Developer API 400s. Measured on 2.13.0.
 *
 * A schema carrying `$schema` is returned unchanged (still a copy): `@google/genai` re-routes such a
 * schema to the permissive `responseJsonSchema` / `parametersJsonSchema` field, where full JSON Schema
 * — `additionalProperties` and `$defs` included — is legal. Sanitizing it would discard real
 * constraints, and dropping `$schema` itself would *downgrade* the request onto the strict
 * `responseSchema` proto, which does not model `$defs`/`$ref`. (This is where TS diverges from
 * `cendor-sdk`: the Python client inlines `$defs` before sending, the TS one does not.)
 */
export function geminiSanitize(schema: unknown): unknown {
  if (isRecord(schema) && '$schema' in schema) return deepCopy(schema);
  return sanitizeNode(schema);
}

/** A callable tool with a JSON-Schema parameter spec and per-provider formatters. */
export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  readonly isAsync: boolean;
  private readonly runner: (args: Record<string, unknown>) => unknown;

  constructor(fn: ToolFn, opts: ToolOptions = {}) {
    this.name = opts.name ?? fn.name ?? 'tool';
    this.description = opts.description ?? '';
    this.parameters = opts.jsonSchema ?? toJsonSchema(opts.parameters);
    this.isAsync = fn.constructor.name === 'AsyncFunction';
    // instrumentTool emits a ToolCall on every execution (unless opted out).
    this.runner =
      opts.instrument === false ? fn : (instrumentTool(this.name) as (f: ToolFn) => ToolFn)(fn);
  }

  /** Execute the tool with a parsed arguments object (awaits an async tool). */
  async invoke(args: Record<string, unknown>): Promise<unknown> {
    return this.runner(args);
  }

  toOpenai(): JsonSchema {
    return {
      type: 'function',
      function: { name: this.name, description: this.description, parameters: this.parameters },
    };
  }
  toOpenaiResponses(): JsonSchema {
    return {
      type: 'function',
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }
  toAnthropic(): JsonSchema {
    return { name: this.name, description: this.description, input_schema: this.parameters };
  }
  /**
   * A single Gemini function declaration (providers wrap these in a `functionDeclarations` list).
   *
   * The parameters go through {@link geminiSanitize}: the generic schema always stamps
   * `additionalProperties`, which the Gemini `Schema` proto does not model, and `@google/genai`'s own
   * stripper misses it inside a `prefixItems` / `$defs` subtree.
   */
  toGemini(): JsonSchema {
    return {
      name: this.name,
      description: this.description,
      parameters: geminiSanitize(this.parameters) as JsonSchema,
    };
  }
  toBedrock(): JsonSchema {
    return {
      toolSpec: {
        name: this.name,
        description: this.description,
        inputSchema: { json: this.parameters },
      },
    };
  }
}

/** Build a `Tool` from a function + a zod parameter schema. */
export function tool(fn: ToolFn, opts: ToolOptions = {}): Tool {
  return new Tool(fn, opts);
}

/** Coerce a `Tool | ToolFn` to a `Tool` (idempotent). */
export function asTool(obj: Tool | ToolFn): Tool {
  return obj instanceof Tool ? obj : new Tool(obj);
}
