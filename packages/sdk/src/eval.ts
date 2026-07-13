/**
 * Eval — the TS port of `cendor.sdk.eval`. Replays each case's cassette (so cost/tokens are the real
 * recorded figures), runs the agent, and checks output / contains / tool sequence / cost & token
 * ceilings / a custom judge.
 */
import { type Normalizer, using } from '@cendor/cassette';
import { Dec } from '@cendor/core';
import type { Agent } from './agent.js';
import { run } from './runner.js';
import type { Message, Result } from './types.js';

export type Judge = (
  output: unknown,
  c: EvalCase,
) => boolean | [boolean, string] | Promise<boolean | [boolean, string]>;

export interface EvalCase {
  name: string;
  input: string | Message | Message[];
  cassette: string;
  expectOutput?: unknown;
  expectContains?: string;
  expectTools?: string[];
  maxUsd?: number;
  maxTokens?: number;
  judge?: Judge;
  /** Forwarded to cassette's replay matching — normalize volatile request parts (timestamps,
   * uuids) before hashing, so a prompt that embeds "today's date" still replays. Same signature
   * as `@cendor/cassette`'s `normalizer`. */
  normalizer?: Normalizer;
}

export class EvalResult {
  constructor(
    readonly name: string,
    readonly passed: boolean,
    readonly failures: string[],
    readonly output: unknown,
    readonly costUsd: string,
    readonly tokens: number,
    readonly tools: string[],
  ) {}
}

export class EvalReport {
  constructor(readonly results: EvalResult[] = []) {}
  get passed(): number {
    return this.results.filter((r) => r.passed).length;
  }
  get failed(): number {
    return this.results.filter((r) => !r.passed).length;
  }
  get ok(): boolean {
    return this.results.every((r) => r.passed);
  }
  assertOk(): void {
    if (this.ok) return;
    const lines = this.results
      .filter((r) => !r.passed)
      .map((r) => `  ${r.name}: ${r.failures.join('; ')}`);
    throw new Error(`eval failures (${this.failed}/${this.results.length}):\n${lines.join('\n')}`);
  }
  toString(): string {
    return `EvalReport(${this.passed}/${this.results.length} passed)\n${this.results.map((r) => `  [${r.passed ? 'PASS' : 'FAIL'}] ${r.name}${r.failures.length ? ` — ${r.failures.join('; ')}` : ''}`).join('\n')}`;
  }
}

/** Run an agent against recorded cassettes and check each expectation. */
export async function evaluate(agent: Agent, cases: EvalCase[]): Promise<EvalReport> {
  const results: EvalResult[] = [];
  for (const c of cases) {
    let result: Result | undefined;
    await using(c.cassette, { mode: 'replay', normalizer: c.normalizer ?? null }, async () => {
      result = await run(agent, c.input);
    });
    const r = result as Result;
    const failures: string[] = [];
    const tools = r.toolSteps.map((s) => s.name);
    const cost = r.cost.amount;
    const tokens = r.usage.totalTokens;
    if (
      c.expectOutput !== undefined &&
      JSON.stringify(r.output) !== JSON.stringify(c.expectOutput)
    ) {
      failures.push(
        `output ${JSON.stringify(r.output)} != expected ${JSON.stringify(c.expectOutput)}`,
      );
    }
    if (
      c.expectContains !== undefined &&
      !(typeof r.output === 'string' && r.output.includes(c.expectContains))
    ) {
      failures.push(`output does not contain ${JSON.stringify(c.expectContains)}`);
    }
    if (c.expectTools !== undefined && JSON.stringify(tools) !== JSON.stringify(c.expectTools)) {
      failures.push(`tools ${JSON.stringify(tools)} != ${JSON.stringify(c.expectTools)}`);
    }
    if (c.maxUsd !== undefined && cost.greaterThan(new Dec(String(c.maxUsd)))) {
      failures.push(`cost ${cost.toString()} exceeds maxUsd ${c.maxUsd}`);
    }
    if (c.maxTokens !== undefined && tokens > c.maxTokens) {
      failures.push(`tokens ${tokens} exceeds maxTokens ${c.maxTokens}`);
    }
    if (c.judge) {
      const verdict = await c.judge(r.output, c);
      const [ok, reason] = Array.isArray(verdict) ? verdict : [verdict, ''];
      if (!ok) failures.push(`judge rejected${reason ? `: ${reason}` : ''}`);
    }
    results.push(
      new EvalResult(
        c.name,
        failures.length === 0,
        failures,
        r.output,
        cost.toString(),
        tokens,
        tools,
      ),
    );
  }
  return new EvalReport(results);
}
