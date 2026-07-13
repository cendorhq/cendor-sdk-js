/**
 * `init` — make a project Cendor-ready and Cendor-fluent for its AI assistant.
 *
 * Writes the matching assistant rules file(s) from the vendored P2 templates (idempotent, marker
 * delimited, never clobbers user content), optionally the MCP connect config (P3) and a correct
 * starter, then reports what it did. Offline: no network, no key.
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Detected, detectProject } from './detect.js';
import { SENTINEL, ensureDir, readIfExists, upsertManaged } from './io.js';
import { agentsBody, claudeBody, copilotBody, cursorFile } from './templates.js';
import { ALL_ASSISTANTS, type Assistant, type Ecosystem, type FileAction } from './types.js';

export interface InitOptions {
  root: string;
  /** Explicit assistant selection; when omitted, auto-detect + always include AGENTS.md. */
  assistants?: Assistant[];
  all?: boolean;
  /** Also write the MCP connect config for detected assistants (only where the file is absent). */
  mcp?: boolean;
  /** Also write a minimal correct `instrument()` + budgeted-call starter for the project language. */
  scaffold?: boolean;
  /** Overwrite an owned file (`.cursor/rules/cendor.mdc`) even if we didn't write it. */
  force?: boolean;
  /** Compute actions without touching disk. */
  dryRun?: boolean;
}

export interface InitResult {
  detected: Detected;
  chosen: Assistant[];
  actions: FileAction[];
  /** The MCP connect guidance (always returned so the CLI can print it). */
  mcpGuidance: string;
}

interface Target {
  assistant: Assistant;
  path: string; // relative
  /** `owned` = a dedicated Cendor file written verbatim; `shared` = our block inserted into a user file. */
  mode: 'owned' | 'shared';
  body: () => string;
}

function targetFor(a: Assistant): Target {
  switch (a) {
    case 'copilot':
      return {
        assistant: a,
        path: '.github/copilot-instructions.md',
        mode: 'shared',
        body: copilotBody,
      };
    case 'cursor':
      return { assistant: a, path: '.cursor/rules/cendor.mdc', mode: 'owned', body: cursorFile };
    case 'agents':
      return { assistant: a, path: 'AGENTS.md', mode: 'shared', body: agentsBody };
    case 'claude':
      return { assistant: a, path: 'CLAUDE.md', mode: 'shared', body: claudeBody };
    case 'windsurf':
      // Windsurf has no dedicated rules-file template; the generic AGENTS body is the right cheatsheet.
      return { assistant: a, path: '.windsurf/rules', mode: 'shared', body: agentsBody };
  }
}

function chooseAssistants(opts: InitOptions, detected: Detected): Assistant[] {
  if (opts.all) return [...ALL_ASSISTANTS];
  if (opts.assistants && opts.assistants.length > 0) return [...new Set(opts.assistants)];
  // Auto: everything already configured in the repo, plus AGENTS.md as the cross-tool default.
  return [...new Set<Assistant>([...detected.assistants, 'agents'])];
}

function writeTarget(root: string, t: Target, opts: InitOptions): FileAction {
  const abs = join(root, t.path);
  const existing = readIfExists(abs);
  const dry = opts.dryRun === true;

  if (t.mode === 'owned') {
    // A dedicated file (cendor.mdc). Safe to create; only overwrite if it's ours or --force.
    if (existing === null) {
      if (!dry) {
        ensureDir(abs);
        writeFileSync(abs, `${t.body().trimEnd()}\n`);
      }
      return { path: t.path, status: dry ? 'would-create' : 'created' };
    }
    const ours = existing.includes(SENTINEL);
    if (!ours && opts.force !== true) {
      return {
        path: t.path,
        status: dry ? 'would-skip' : 'skipped',
        note: 'exists and not managed by cendor — re-run with --force to overwrite',
      };
    }
    if (!dry) writeFileSync(abs, `${t.body().trimEnd()}\n`);
    return { path: t.path, status: dry ? 'would-update' : 'updated' };
  }

  // Shared file: insert/refresh our managed block, never disturb the user's other content.
  const { content, kind } = upsertManaged(existing, t.body());
  if (!dry) {
    ensureDir(abs);
    writeFileSync(abs, content);
  }
  // `kind` is past tense (created/updated/appended); the dry-run label is present tense.
  const wouldMap = {
    created: 'would-create',
    updated: 'would-update',
    appended: 'would-append',
  } as const;
  return { path: t.path, status: dry ? wouldMap[kind] : kind };
}

function scaffoldLang(detected: Detected): Ecosystem {
  if (detected.python && !detected.node) return 'python';
  if (detected.node) return 'node';
  return detected.ecosystem;
}

/** Is the cendor SDK (the "second door") declared/installed? Then scaffold a governed agent, not the
 * bare libs starter. Checks installed + declared npm and declared pypi (cross-ecosystem projects). */
function sdkDetected(detected: Detected): boolean {
  return (
    '@cendor/sdk' in detected.installedNpm ||
    '@cendor/sdk' in detected.declaredNpm ||
    'cendor-sdk' in detected.declaredPypi
  );
}

// The bare-libraries starter: instrument once, then cap spend.
const PY_LIBS_SCAFFOLD = `"""Minimal Cendor starter — instrument once, then cap spend. Offline-safe scaffold.

Install:  pip install cendor-tokenguard "cendor-sdk[openai]"   (or just what you call)
Auth:     OPENAI_API_KEY from your env (OpenAI() reads it) — no Cendor key needed
Docs:     https://cendor.ai/docs/getting-started
"""

from cendor.core import instrument
from cendor.tokenguard import budget, track, report


def main() -> None:
    from openai import OpenAI

    client = instrument(OpenAI())  # wrap the client ONCE — idempotent, additive

    @budget(usd=0.50, on_exceed="raise")  # trips before a runaway loop overspends
    def answer(question: str) -> str:
        with track(feature="support", user_id="alice"):
            resp = client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": question}],
            )
            return resp.choices[0].message.content or ""

    print(answer("Why was I charged twice?"))
    print(report(group_by=["feature"]))  # spend grouped by tag — for free


if __name__ == "__main__":
    main()
`;

const NODE_LIBS_SCAFFOLD = `// Minimal Cendor starter — instrument once, then cap spend. Offline-safe scaffold.
//
// Install:  npm i @cendor/core @cendor/tokenguard openai   (or just what you call)
// Auth:     OPENAI_API_KEY from your env (new OpenAI() reads it) — no Cendor key needed
// Docs:     https://cendor.ai/docs/getting-started
import { instrument } from '@cendor/core';
import { budget, track, report } from '@cendor/tokenguard';
import OpenAI from 'openai';

const client = instrument(new OpenAI()); // wrap the client ONCE — idempotent, additive

// NOTE: budget is CURRIED — budget(cfg)(fn), never budget(cfg, fn).
const answer = budget({ usd: 0.5, onExceed: 'raise' })((question) =>
  track({ feature: 'support', userId: 'alice' }, async () => {
    const resp = await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: question }],
    });
    return resp.choices[0].message.content;
  }),
);

console.log(await answer('Why was I charged twice?'));
console.log(report(['feature'])); // spend grouped by tag — for free
`;

// The governed-agent starter (cendor-sdk detected): Agent + guardrails + budget + guard + run.
const PY_SDK_SCAFFOLD = `"""Minimal governed-agent starter (cendor-sdk). Offline-safe scaffold.

Install:  pip install "cendor-sdk[openai]"
Auth:     OPENAI_API_KEY from your env, or Agent(api_key=...) — no Cendor key needed
Docs:     https://cendor.ai/docs/sdk/getting-started
"""

from cendor.sdk import Agent, run, budget, guard, rules, Policy, AuditLog


def main() -> None:
    agent = Agent(
        name="assistant",
        model="gpt-4o",
        instructions="Answer using tools when helpful.",
        guardrails=[rules.keyword_deny(["ignore previous instructions"], action="block")],
        max_usd=0.50,  # per-agent cost cap — NOT budget=
    )
    log = AuditLog(system="assistant", risk_tier="limited", path="audit.jsonl")

    # budget -> tokenguard pre-flight; guard -> acttrace PII redaction + audit chain
    with budget(usd=0.25, on_exceed="block"), guard(Policy.default(), audit=log):
        result = run(agent, "Summarize today's standup notes.", audit=log)

    print(result.output, result.cost)  # the answer + Decimal money — governed & audited


if __name__ == "__main__":
    main()
`;

const NODE_SDK_SCAFFOLD = `// Minimal governed-agent starter (@cendor/sdk). Offline-safe scaffold.
//
// Install:  npm i @cendor/sdk openai
// Auth:     OPENAI_API_KEY from your env, or apiKey on the Agent — no Cendor key needed
// Docs:     https://cendor.ai/docs/sdk/getting-started
import { Agent, run, withBudget, guard, rules, Policy, AuditLog } from '@cendor/sdk';

const agent = new Agent({
  name: 'assistant',
  model: 'gpt-4o',
  instructions: 'Answer using tools when helpful.',
  guardrails: [rules.keywordDeny(['ignore previous instructions'], { action: 'block' })],
  maxUsd: 0.5, // per-agent cost cap — NOT budget=
});
const log = new AuditLog('assistant', { riskTier: 'limited', path: 'audit.jsonl' });

// budget -> tokenguard pre-flight; guard -> acttrace PII redaction + audit chain
const result = await withBudget({ usd: 0.25, onExceed: 'block' }, () =>
  guard({ policy: Policy.default(), audit: log }, () =>
    run(agent, "Summarize today's standup notes.", { audit: log })));

console.log(result.output, result.cost?.toString()); // governed & audited
`;

function scaffoldTarget(lang: Ecosystem, sdk: boolean): { path: string; body: string } | null {
  if (lang === 'python') {
    return { path: 'cendor_quickstart.py', body: sdk ? PY_SDK_SCAFFOLD : PY_LIBS_SCAFFOLD };
  }
  if (lang === 'node') {
    return { path: 'cendor-quickstart.mjs', body: sdk ? NODE_SDK_SCAFFOLD : NODE_LIBS_SCAFFOLD };
  }
  return null;
}

/** The MCP connect guidance printed at the end of `init` (and optionally written with --mcp). */
export function mcpGuidance(): string {
  return [
    'Agent-mode assistant (Claude Code / Cursor / Copilot agent / Windsurf)? Connect the Cendor MCP',
    'server so it can look up the correct call-shape live:',
    '  • Remote (always current):  https://mcp.cendor.ai',
    '  • Local  (offline, bundled): npx -y @cendor/mcp   |   uvx cendor-mcp',
    '  Claude Code:  claude mcp add --transport http cendor https://mcp.cendor.ai',
    '  Full setup for every assistant: https://cendor.ai/mcp',
  ].join('\n');
}

/** MCP config files we can drop in (only when absent), keyed by the assistant that reads them. */
function mcpConfigFiles(): { path: string; body: string }[] {
  return [
    {
      path: '.cursor/mcp.json',
      body: `${JSON.stringify({ mcpServers: { cendor: { url: 'https://mcp.cendor.ai' } } }, null, 2)}\n`,
    },
    {
      path: '.vscode/mcp.json',
      body: `${JSON.stringify(
        { servers: { cendor: { type: 'http', url: 'https://mcp.cendor.ai' } } },
        null,
        2,
      )}\n`,
    },
  ];
}

export function runInit(opts: InitOptions): InitResult {
  const detected = detectProject(opts.root);
  const chosen = chooseAssistants(opts, detected);
  const actions: FileAction[] = [];

  for (const a of chosen) actions.push(writeTarget(opts.root, targetFor(a), opts));

  if (opts.mcp) {
    for (const f of mcpConfigFiles()) {
      const abs = join(opts.root, f.path);
      if (existsSync(abs)) {
        actions.push({ path: f.path, status: 'skipped', note: 'exists — left as-is; see /mcp' });
        continue;
      }
      if (!opts.dryRun) {
        ensureDir(abs);
        writeFileSync(abs, f.body);
      }
      actions.push({ path: f.path, status: opts.dryRun ? 'would-create' : 'created' });
    }
  }

  if (opts.scaffold) {
    const target = scaffoldTarget(scaffoldLang(detected), sdkDetected(detected));
    if (target) {
      const abs = join(opts.root, target.path);
      if (existsSync(abs)) {
        actions.push({ path: target.path, status: 'skipped', note: 'exists — left as-is' });
      } else {
        if (!opts.dryRun) {
          ensureDir(abs);
          writeFileSync(abs, target.body);
        }
        actions.push({ path: target.path, status: opts.dryRun ? 'would-create' : 'created' });
      }
    }
  }

  return { detected, chosen, actions, mcpGuidance: mcpGuidance() };
}
