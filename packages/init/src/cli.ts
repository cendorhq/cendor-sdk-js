#!/usr/bin/env node
/**
 * `@cendor/init` — one command to make a project Cendor-ready and Cendor-fluent for its AI assistant,
 * plus a `doctor` that catches wiring mistakes before they bite. Offline: no network, no key.
 *
 *   npx @cendor/init            # detect + write assistant rules (idempotent)
 *   npx @cendor/init doctor     # validate wiring; non-zero exit on hard problems (CI-usable)
 *
 * See https://cendor.ai/docs/for-ai-assistants and https://cendor.ai/mcp.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SEVERITY_RANK, runDoctor } from './doctor.js';
import { type InitOptions, runInit } from './init.js';
import { ALL_ASSISTANTS, type Assistant, type Finding } from './types.js';

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const HELP = `cendor-init — wire Cendor + your AI assistant, offline.

USAGE
  npx @cendor/init [init] [options]     write assistant rules files (default command)
  npx @cendor/init doctor [options]     validate the wiring (never writes); exit 1 on hard problems

INIT OPTIONS
  --all                 write every assistant rules file, not just the detected ones
  --assistant <list>    comma-separated subset: copilot,cursor,agents,claude,windsurf
  --mcp                 also drop MCP connect config (.cursor/mcp.json, .vscode/mcp.json) if absent
  --scaffold            also write a minimal correct instrument()+budget starter for this project
  --force               overwrite an owned file (.cursor/rules/cendor.mdc) even if not ours
  --dry-run             show what would change without writing anything

COMMON
  -h, --help            show this help
  -v, --version         print the version

Docs: https://cendor.ai/docs/for-ai-assistants   MCP: https://cendor.ai/mcp`;

function parseAssistants(raw: string[] | undefined): Assistant[] | undefined {
  if (!raw || raw.length === 0) return undefined;
  const wanted = raw
    .flatMap((s) => s.split(','))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const valid = new Set<string>(ALL_ASSISTANTS);
  const bad = wanted.filter((w) => !valid.has(w));
  if (bad.length > 0) {
    process.stderr.write(`cendor-init: unknown assistant(s): ${bad.join(', ')}\n`);
    process.stderr.write(`             valid: ${ALL_ASSISTANTS.join(', ')}\n`);
    process.exit(2);
  }
  return wanted as Assistant[];
}

const ICON: Record<string, string> = {
  created: '+',
  updated: '~',
  appended: '~',
  skipped: '·',
  'would-create': '+',
  'would-update': '~',
  'would-append': '~',
  'would-skip': '·',
};

function cmdInit(root: string, opts: InitOptions): number {
  const result = runInit(opts);
  const dry = opts.dryRun === true;
  const eco = result.detected.ecosystem;

  process.stdout.write(
    `\ncendor-init — ${dry ? 'dry run (no files written)' : 'wiring Cendor for your assistant'}\n`,
  );
  process.stdout.write(
    `project: ${eco === 'unknown' ? 'no package.json / pyproject found' : `${eco} project`}`,
  );
  if (result.detected.declaredProviders.size > 0) {
    process.stdout.write(`  ·  providers: ${[...result.detected.declaredProviders].join(', ')}`);
  }
  process.stdout.write('\n\n');

  for (const a of result.actions) {
    const icon = ICON[a.status] ?? '·';
    process.stdout.write(
      `  ${icon} ${a.status.padEnd(13)} ${a.path}${a.note ? `  (${a.note})` : ''}\n`,
    );
  }

  process.stdout.write('\nMCP (agent-mode assistants):\n');
  for (const line of result.mcpGuidance.split('\n')) process.stdout.write(`  ${line}\n`);

  process.stdout.write('\nNext:\n');
  process.stdout.write(
    '  • Trust your editor’s hover/completion — every Cendor symbol ships an @example.\n',
  );
  process.stdout.write('  • Full trap sheet:  https://cendor.ai/docs/for-ai-assistants\n');
  process.stdout.write('  • Validate wiring:  npx @cendor/init doctor\n\n');
  return 0;
}

function printFinding(f: Finding): void {
  const tag =
    f.severity === 'error'
      ? 'ERROR'
      : f.severity === 'warn'
        ? 'WARN '
        : f.severity === 'ok'
          ? 'OK   '
          : 'INFO ';
  process.stdout.write(`  [${tag}] ${f.title}\n`);
  for (const line of wrap(f.detail, 88)) process.stdout.write(`          ${line}\n`);
  if (f.fix) process.stdout.write(`          fix: ${f.fix}\n`);
  if (f.locations && f.locations.length > 0) {
    for (const loc of f.locations) process.stdout.write(`          - ${loc}\n`);
  }
  process.stdout.write('\n');
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function cmdDoctor(root: string): number {
  const { findings, exitCode } = runDoctor(root);
  const sorted = [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  process.stdout.write('\ncendor-init doctor\n\n');
  for (const f of sorted) printFinding(f);

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  process.stdout.write(
    `${errors} error(s), ${warns} warning(s). ${exitCode === 0 ? 'OK.' : 'Fix the errors above.'}\n\n`,
  );
  return exitCode;
}

function main(): number {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean', short: 'v' },
      all: { type: 'boolean' },
      assistant: { type: 'string', multiple: true },
      mcp: { type: 'boolean' },
      scaffold: { type: 'boolean' },
      force: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
    },
  });

  if (values.help) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const command = positionals[0] ?? 'init';
  const root = process.cwd();

  switch (command) {
    case 'init':
      return cmdInit(root, {
        root,
        all: values.all,
        assistants: parseAssistants(values.assistant),
        mcp: values.mcp,
        scaffold: values.scaffold,
        force: values.force,
        dryRun: values['dry-run'],
      });
    case 'doctor':
      return cmdDoctor(root);
    default:
      process.stderr.write(`cendor-init: unknown command "${command}". Try --help.\n`);
      return 2;
  }
}

process.exit(main());
