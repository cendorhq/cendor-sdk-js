/**
 * Q1 — `Checkpointer.save()` must survive a transient Win32 sharing violation WITHOUT giving up the
 * crash-atomicity the temp file exists for.
 *
 * MEASURED MECHANISM (plan/evidence-gapclose-2026-07-31/q1_probe_*.mjs, Windows 11 / node 24):
 * `rename` over an existing destination is `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which needs
 * exclusive access to the DESTINATION. 11 of 500 plain saves failed with EPERM (~2%) — the OS had a
 * handle open on the file we had just created — and it is deterministic while a handle is held.
 * With 3 retries: 500/500 succeeded. The Python twin measured 8/500 with the same errno, so both
 * SDKs were fixed together.
 *
 * Every "now works" claim below is paired with a negative control, because a retry loop that retries
 * everything is worse than no retry loop: it would turn a full disk into a 62ms pause and then the
 * same failure, and it would hide a real bug.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Checkpointer, atomicReplaceSync } from '../src/checkpoint.js';

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'cendor-ckpt-atomic-'));
}

/** An fs error shaped exactly like node's, so the classification under test is the real one. */
function fsError(code: string, syscall = 'rename'): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(`${code}: simulated, ${syscall}`);
  e.code = code;
  e.syscall = syscall;
  return e;
}

describe('@cendor/sdk — checkpoint atomic replace (Q1)', () => {
  it('retries a transient sharing violation and then succeeds', () => {
    const d = dir();
    const target = join(d, 'run.ckpt.json');
    const tmp = `${target}.tmp`;
    writeFileSync(target, '{"gen":1}');
    writeFileSync(tmp, '{"gen":2}');

    let attempts = 0;
    atomicReplaceSync(tmp, target, (from, to) => {
      attempts++;
      if (attempts <= 3) throw fsError('EPERM'); // the OS holds `to` open, then lets go
      writeFileSync(to, readFileSync(from));
    });

    expect(attempts).toBe(4); // 1 failed + 3 retries consumed, then through
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ gen: 2 });
  });

  it('EACCES and EBUSY are retried too (the same violation, different errno)', () => {
    for (const code of ['EACCES', 'EBUSY']) {
      const d = dir();
      const target = join(d, 'run.ckpt.json');
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, '{"ok":true}');
      let attempts = 0;
      atomicReplaceSync(tmp, target, (from, to) => {
        attempts++;
        if (attempts === 1) throw fsError(code);
        writeFileSync(to, readFileSync(from));
      });
      expect(attempts, code).toBe(2);
    }
  });

  // --- NEGATIVE CONTROL 1: a permanent error must NOT be retried at all. ----
  it('a permanent error raises on the FIRST attempt — the retry does not mask real failures', () => {
    for (const code of ['ENOENT', 'ENOSPC', 'EROFS', 'EXDEV']) {
      const d = dir();
      const target = join(d, 'run.ckpt.json');
      const tmp = `${target}.tmp`;
      writeFileSync(tmp, '{"x":1}');
      let attempts = 0;
      expect(
        () =>
          atomicReplaceSync(tmp, target, () => {
            attempts++;
            throw fsError(code);
          }),
        code,
      ).toThrow(code);
      expect(attempts, `${code} must not be retried`).toBe(1);
    }
  });

  // --- NEGATIVE CONTROL 2: the budget is bounded, and the original error survives. ---
  it('an unrelenting violation gives up after a bounded number of attempts and rethrows', () => {
    const d = dir();
    const target = join(d, 'run.ckpt.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, '{"x":1}');
    let attempts = 0;
    expect(() =>
      atomicReplaceSync(tmp, target, () => {
        attempts++;
        throw fsError('EPERM');
      }),
    ).toThrow('EPERM');
    expect(attempts).toBe(6); // 1 + 5 retries — a ceiling, never an unbounded loop
  });

  // --- NEGATIVE CONTROL 3: the guarantee unlink-then-rename would have broken. ---
  it('a failed replace leaves the PREVIOUS checkpoint intact (crash-atomicity holds)', () => {
    const d = dir();
    const target = join(d, 'run.ckpt.json');
    const tmp = `${target}.tmp`;
    writeFileSync(target, '{"generation":"previous-good"}');
    writeFileSync(tmp, '{"generation":"new"}');

    expect(() =>
      atomicReplaceSync(tmp, target, () => {
        throw fsError('ENOSPC');
      }),
    ).toThrow('ENOSPC');

    // The measured alternative (`unlink(dest)` then `rename`) leaves NO file here at all.
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ generation: 'previous-good' });
  });

  it('a failed replace does not leave a stale .tmp behind', () => {
    const d = dir();
    const target = join(d, 'run.ckpt.json');
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, '{"x":1}');
    expect(() =>
      atomicReplaceSync(tmp, target, () => {
        throw fsError('EROFS');
      }),
    ).toThrow('EROFS');
    expect(existsSync(tmp)).toBe(false);
  });

  // --- End-to-end through the real filesystem: the wiring, not just the helper. ---
  it('save() overwrites an existing checkpoint repeatedly and leaves no temp file', () => {
    const d = dir();
    const path = join(d, 'run.ckpt.json');
    const ckpt = new Checkpointer(path);
    for (let i = 0; i < 40; i++) {
      ckpt.save({ run_id: 'r1', messages: [], done: false, seg: i });
    }
    expect(ckpt.load()?.seg).toBe(39);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
