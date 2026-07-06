/**
 * Tools — the TS port of `cendor.sdk.tools`. Where Python derives a JSON Schema from type hints, TS
 * declares it with **zod** (`tool(fn, { parameters: z.object({...}) })`) and converts to JSON Schema
 * via `zod-to-json-schema`, producing the same per-provider tool shapes. Every tool's execution is
 * wrapped with `instrumentTool` so it emits a `ToolCall` on the bus (governance parity).
 */
import { instrumentTool } from '@cendor/core';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

export type JsonSchema = Record<string, unknown>;
export type ToolFn = (args: Record<string, unknown>) => unknown;

export interface ToolOptions {
  name?: string;
  description?: string;
  parameters?: z.ZodTypeAny;
  /** A pre-built JSON Schema (bypasses zod conversion — used when re-wrapping an existing tool). */
  jsonSchema?: JsonSchema;
  /** Set false to skip `instrumentTool` wrapping (e.g. a wrapper whose inner tool already emits). */
  instrument?: boolean;
}

const EMPTY_SCHEMA: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

function toJsonSchema(schema: z.ZodTypeAny | undefined): JsonSchema {
  if (!schema) return EMPTY_SCHEMA;
  const js = zodToJsonSchema(schema, { $refStrategy: 'none' }) as JsonSchema;
  js.$schema = undefined;
  // biome-ignore lint/performance/noDelete: strip the JSON-schema meta key for clean provider payloads
  delete js.$schema;
  if (js.additionalProperties === undefined) js.additionalProperties = false;
  return js;
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
  toGemini(): JsonSchema {
    return { name: this.name, description: this.description, parameters: this.parameters };
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
