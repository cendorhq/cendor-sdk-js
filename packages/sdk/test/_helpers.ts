import { bus } from '@cendor/core';
import { reset as tokenguardReset } from '@cendor/tokenguard';
import { beforeEach } from 'vitest';
import { resetProviderCache } from '../src/index.js';

/** Test isolation: clear tokenguard state + provider client cache before each test. */
export function isolate(): void {
  beforeEach(() => {
    tokenguardReset();
    resetProviderCache();
    bus._reset();
    tokenguardReset(); // re-arm the tokenguard subscription after the bus reset
  });
}

export interface StubToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** Build an OpenAI Chat Completions response object (the exact wire shape). */
export function openaiChat(opts: {
  content?: string | null;
  toolCalls?: StubToolCall[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}): unknown {
  const toolCalls = opts.toolCalls ?? [];
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: opts.content ?? null,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((t, i) => ({
                  id: t.id ?? `call_${i}`,
                  type: 'function',
                  function: { name: t.name, arguments: JSON.stringify(t.args) },
                })),
              }
            : {}),
        },
      },
    ],
    usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** A stub OpenAI-shaped client that returns queued responses (last one repeats). */
export function stubOpenAI(responses: unknown[]): {
  chat: { completions: { create: (p: unknown) => Promise<unknown> } };
} {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (_p: unknown) => responses[Math.min(i++, responses.length - 1)],
      },
    },
  };
}

/** A stub OpenAI-shaped streaming client: `create({stream:true})` yields the given chunks. */
export function stubOpenAIStream(
  chunks: unknown[],
  usage = { prompt_tokens: 5, completion_tokens: 3 },
): { chat: { completions: { create: (p: { stream?: boolean }) => Promise<unknown> } } } {
  return {
    chat: {
      completions: {
        create: async (p: { stream?: boolean }) => {
          if (p.stream) {
            return (async function* () {
              for (const c of chunks) yield c;
              yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage };
            })();
          }
          return openaiChat({ content: chunks.map((c) => textOf(c)).join('') });
        },
      },
    },
  };
}

function textOf(chunk: unknown): string {
  const choices = (chunk as { choices?: { delta?: { content?: string } }[] }).choices;
  return choices?.[0]?.delta?.content ?? '';
}

/** An OpenAI streaming text chunk. */
export function delta(text: string): unknown {
  return { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
}

/** A stub Anthropic-shaped client. */
export function stubAnthropic(response: unknown): {
  messages: { create: (p: unknown) => Promise<unknown> };
} {
  return { messages: { create: async (_p: unknown) => response } };
}

/** A stub OpenAI-shaped client that also records the kwargs each `create` received. */
export function recordingOpenAI(responses: unknown[]): {
  calls: unknown[];
  client: { chat: { completions: { create: (p: unknown) => Promise<unknown> } } };
} {
  const calls: unknown[] = [];
  let i = 0;
  return {
    calls,
    client: {
      chat: {
        completions: {
          create: async (p: unknown) => {
            calls.push(p);
            return responses[Math.min(i++, responses.length - 1)];
          },
        },
      },
    },
  };
}

/** An OpenAI streaming text chunk (mirrors PY conftest `_text_chunk`). */
export function streamTextChunk(
  content: string | null,
  opts: { finish?: string | null; usage?: unknown } = {},
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: { content, tool_calls: null },
        finish_reason: opts.finish ?? null,
      },
    ],
    usage: opts.usage ?? null,
  };
}

/** An OpenAI streaming tool-call chunk (mirrors PY conftest `_tool_chunk`; args stream as fragments). */
export function streamToolChunk(
  idx: number,
  opts: {
    id?: string;
    name?: string;
    args?: string;
    finish?: string | null;
    usage?: unknown;
  } = {},
): unknown {
  return {
    choices: [
      {
        index: 0,
        delta: {
          content: null,
          tool_calls: [
            {
              index: idx,
              id: opts.id ?? null,
              function: { name: opts.name ?? null, arguments: opts.args ?? null },
            },
          ],
        },
        finish_reason: opts.finish ?? null,
      },
    ],
    usage: opts.usage ?? null,
  };
}

/** A stub OpenAI-shaped streaming client where each `create({stream:true})` yields the next turn's chunks. */
export function stubStreamTurns(turns: unknown[][]): {
  chat: { completions: { create: (p: { stream?: boolean }) => Promise<unknown> } };
} {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async (_p: { stream?: boolean }) => {
          const chunks = turns[Math.min(i++, turns.length - 1)] ?? [];
          return (async function* () {
            for (const c of chunks) yield c;
          })();
        },
      },
    },
  };
}

/** Usage payload for a stream's terminal chunk. */
export function streamUsage(prompt = 5, completion = 2): unknown {
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
  };
}

/** Build an Anthropic Messages response object (the exact wire shape). */
export function anthropicMessage(opts: {
  text?: string;
  toolUse?: { id?: string; name: string; input: Record<string, unknown> };
  usage?: { input_tokens: number; output_tokens: number };
}): unknown {
  const content: unknown[] = [];
  if (opts.text != null) content.push({ type: 'text', text: opts.text });
  if (opts.toolUse)
    content.push({
      type: 'tool_use',
      id: opts.toolUse.id ?? 'toolu_1',
      name: opts.toolUse.name,
      input: opts.toolUse.input,
    });
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-8',
    content,
    stop_reason: opts.toolUse ? 'tool_use' : 'end_turn',
    usage: opts.usage ?? { input_tokens: 20, output_tokens: 8 },
  };
}
