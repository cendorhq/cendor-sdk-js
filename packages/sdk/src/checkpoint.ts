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

  /** Atomically write the run state (temp file + rename, which overwrites on Windows too). */
  save(state: CheckpointState): void {
    mkdirSync(dirname(this.path) || '.', { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.path);
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
