/**
 * Checkpointed / resumable runs — the TS port of `cendor.sdk.checkpoint`. A `Checkpointer` persists a
 * run's conversation to a local JSON file after each turn, so a long agent can resume after a crash or
 * restart without re-doing completed work (already-run tools are in the saved messages and are not
 * re-executed). Local by default; no server. On-disk keys stay snake_case for cross-tool consistency.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { emitCheckpoint } from './_telemetry.js';
import type { Message } from './types.js';

/**
 * Error codes a rename can fail with *transiently* because someone else has the destination open.
 * Everything else (ENOENT, ENOSPC, EROFS, …) is a real failure and must propagate on the first try.
 */
const SHARING_VIOLATION = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** 5 retries at 2ms doubling — a hard ceiling of 62ms of waiting, then the original error. */
const REPLACE_RETRIES = 5;
const REPLACE_BASE_MS = 2;

/** Sleep without spinning. `save()` is synchronous API, so the wait has to be too. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Replace `target` with `tmp` atomically, retrying a transient sharing violation.
 *
 * WHY THIS IS NOT A PLAIN `renameSync`
 * On Win32 `rename` is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which needs exclusive access to the
 * DESTINATION. It overwrites correctly — but it returns ERROR_ACCESS_DENIED (`EPERM`) whenever any
 * other process has a handle open on that path, and a file we just created is precisely what
 * Defender and the Search indexer open. Measured on Windows 11 / node 24: 11 of 500 plain saves over
 * an existing file failed (~2%), and the failure is deterministic while a handle is held. The holder
 * releases in microseconds, so a bounded retry clears it — 500/500 with 3 retries.
 *
 * A `unlink`-then-`rename` would also clear the violation (measured), but it opens a window in which
 * a crash leaves NO checkpoint at all — destroying the previous good state, which is the exact
 * failure the temp file exists to prevent. Retrying keeps the atomicity guarantee intact.
 *
 * Honest limit: a synchronous sleep blocks this thread, so a holder *inside the same thread* can
 * never release during the backoff. That is not the production case (the holder is another OS
 * process), and it is why the retry budget is small and bounded rather than generous.
 *
 * @internal test-only: `rename` is injectable so the retry/no-retry classification can be driven
 * deterministically. Production always uses `renameSync`.
 */
export function atomicReplaceSync(
  tmp: string,
  target: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt >= REPLACE_RETRIES || !SHARING_VIOLATION.has(code)) {
        // Don't leave a stale `.tmp` behind; `load()` only ever reads `target`, so this is tidy-up.
        try {
          unlinkSync(tmp);
        } catch {
          /* best effort */
        }
        throw err;
      }
      sleepSync(REPLACE_BASE_MS * 2 ** attempt);
    }
  }
}

/**
 * The persisted run state. Single-agent runs use `{run_id, messages, done, output?}`; multi-agent runs
 * additionally carry `{active, seen, seg}`. Keys are snake_case (the cross-tool wire convention).
 */
export interface CheckpointState {
  run_id?: string;
  messages?: Message[];
  done?: boolean;
  output?: unknown;
  active?: string;
  seen?: string[];
  seg?: number;
}

/**
 * The final assistant answer a transcript already ends with, or `null`.
 *
 * A transcript whose last message is an assistant turn with non-empty `content` and no `tool_calls`
 * is complete in substance: every runner loop breaks on exactly that message, and a tool or handoff
 * turn always appends `role: "tool"` results after it — so an *unfinished* checkpoint can only
 * carry this shape when the crash landed in the window between the last per-turn save and the
 * `done` save. Conservative on purpose: empty/absent content falls through to the normal resume.
 */
function finalAnswer(messages: Message[]): string | null {
  const last = messages[messages.length - 1] as Record<string, unknown> | undefined;
  if (
    last &&
    last.role === 'assistant' &&
    !last.tool_calls &&
    typeof last.content === 'string' &&
    last.content.length > 0
  ) {
    return last.content;
  }
  return null;
}

/**
 * Normalise an unfinished state that is finished in substance to a finished one.
 *
 * Returns the state unchanged when it is already `done` (or null); returns a settled copy
 * (`done: true`, `output` recovered from the stored output or the final answer) when the transcript
 * already ends with a final assistant answer; otherwise returns the state unchanged. A stored
 * `output` (the streaming paths persist it with `done: false`, possibly guardrail-transformed) wins
 * over the raw last-message content. This is what stops a resume from re-invoking the model on a
 * complete conversation — where re-doing the task, completed tool calls included, is a legitimate
 * sample for the model to take (measured live by the external suite). PY parity: `_settle`.
 */
export function settleCheckpoint(state: CheckpointState | null): CheckpointState | null {
  if (state && !state.done) {
    const answer = finalAnswer(state.messages ?? []);
    if (answer !== null) {
      return { ...state, done: true, output: state.output ?? answer };
    }
  }
  return state;
}

/**
 * Persist and restore run state to a local JSON file — pass one as `run(agent, input, { checkpoint })`
 * and a crashed run resumes from the last saved turn without re-running completed work.
 *
 * @example
 * ```ts
 * import { Agent, run, Checkpointer } from '@cendor/sdk';
 * const agent = new Agent({ name: 'support', model: 'gpt-4o' });
 * const result = await run(agent, 'Draft the report', { checkpoint: new Checkpointer('run.json') });
 * ```
 */
export class Checkpointer {
  constructor(readonly path: string) {}

  /** The saved state, or `null` if the file is absent, unreadable, or malformed. */
  load(): CheckpointState | null {
    try {
      if (!existsSync(this.path)) return null;
      return JSON.parse(readFileSync(this.path, 'utf-8')) as CheckpointState;
    } catch {
      return null;
    }
  }

  /**
   * Atomically write the run state (temp file + replace).
   *
   * The replace retries a transient Win32 sharing violation — see {@link atomicReplaceSync}. A
   * permanent error (a full disk, a read-only path) still raises on the first attempt.
   */
  save(state: CheckpointState): void {
    mkdirSync(dirname(this.path) || '.', { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    atomicReplaceSync(tmp, this.path);
    // E-wave: checkpoint.save span (correlated by the run id carried in the state itself).
    emitCheckpoint(
      'save',
      state.run_id ?? '',
      Boolean(state.done),
      (state.messages ?? []).length,
      state.seg ?? null,
    );
  }

  /** Saved messages to resume from, or `null` if there's no unfinished checkpoint. */
  resumableMessages(): Message[] | null {
    const state = this.load();
    if (state && !state.done) return [...(state.messages ?? [])];
    return null;
  }

  /** Delete the checkpoint file (e.g. after a successful, finished run). */
  clear(): void {
    try {
      unlinkSync(this.path);
    } catch {
      /* already gone / not writable — nothing to clear */
    }
  }
}

/** Coerce a `Checkpointer | string | null | undefined` to a `Checkpointer | null` (PY `_as_checkpointer`). */
export function asCheckpointer(
  value: Checkpointer | string | null | undefined,
): Checkpointer | null {
  if (value == null) return null;
  if (value instanceof Checkpointer) return value;
  return new Checkpointer(String(value));
}
