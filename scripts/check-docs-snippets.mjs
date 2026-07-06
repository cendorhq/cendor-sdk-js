// Typecheck every TypeScript snippet in the product docs against the real packages.
//
// The docs are single-source, per-product (cendor-libs/docs + cendor-sdk/docs) with
// `<!-- tab: TypeScript -->` panels; tabs that aren't executed rot (PLAN-JS-TS §9). This
// harness extracts every ```ts fence from both docs trees, wraps each in its own module with
// a shared ambient-globals file (docs snippets legitimately use free identifiers like `agent`
// or `msgs`), and runs `tsc` over the lot:
//
//   - `@cendor/sdk` resolves to this workspace's built dist (catches breaking API changes
//     BEFORE they ship);
//   - `@cendor/*` libs + zod resolve from packages/sdk/node_modules (the published packages);
//   - a fence preceded (within 3 non-blank lines) by `<!-- ts-check: skip -->` is skipped —
//     for signature-shape pseudo-code that is documentation, not compilable TS.
//
// Usage: `pnpm check:docs` (builds are a prerequisite: `pnpm build`).
// Exit non-zero on any failing snippet, with errors mapped back to <docs-file>:<line>.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = path.join(repoRoot, 'packages', 'sdk', 'docs-snippets');
const sdkDist = path.join(repoRoot, 'packages', 'sdk', 'dist', 'index.d.ts');

const DOCS_DIRS = (
  process.env.DOCS_DIRS?.split(path.delimiter) ?? [
    path.join(repoRoot, '..', 'cendor-libs', 'docs'),
    path.join(repoRoot, '..', 'cendor-sdk', 'docs'),
  ]
).map((d) => path.resolve(d));

// Free DATA identifiers docs snippets may use without declaring (each snippet is its own
// module, so a local `const agent = …` shadows these cleanly). API names are NOT here — they
// get real-typed globals below, so a typo'd or misused API call still fails.
const AMBIENT = [
  'agent',
  'msgs',
  'audit',
  'log',
  'result',
  'kb',
  'conversation',
  'retrievedDocs',
  'systemPrompt',
  'SYSTEM_PROMPT',
  'userMsg',
  'chatHistory',
  'myAgent',
  'issueRefundTool',
  'getWeather',
  'loadCases',
  'containsPii',
  'myPgvectorSearch',
  'apiResponse',
  'hugeJson',
  'sourceCode',
  'logs',
  'drafter',
  'editor',
  'factchecker',
  'summarizerA',
  'summarizerB',
  'a',
  'b',
  'c',
  'application',
  'openaiClient',
  'ctx',
  'fn',
  'event',
  'scorer',
  'actual',
  'expected',
  'answer',
  'refundTool',
  'task',
  'client',
  'handle',
  'session',
  'store',
  'model',
  'messages',
];

// API names later snippets on a page use without re-importing (the page's earlier snippet
// imported them — standard docs convention). Typed via `typeof import(...)`, so the checker
// still enforces the real signatures.
const TYPED_GLOBALS = [
  ['run', '@cendor/sdk'],
  ['Agent', '@cendor/sdk'],
  ['Session', '@cendor/sdk'],
  ['evaluate', '@cendor/sdk'],
  ['budget', '@cendor/tokenguard'],
  ['track', '@cendor/tokenguard'],
  ['report', '@cendor/tokenguard'],
  ['estimate', '@cendor/tokenguard'],
  ['Context', '@cendor/contextkit'],
  ['Block', '@cendor/contextkit'],
  ['instrument', '@cendor/core'],
  ['prices', '@cendor/core'],
  ['tokens', '@cendor/core'],
];

// Whole-module namespaces used bare in continuation snippets (`cassette.using(...)`).
const NAMESPACE_GLOBALS = [['cassette', '@cendor/cassette']];

const SKIP_MARK = '<!-- ts-check: skip -->';
const FENCE_OPEN = /^```(ts|typescript)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

function extract(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const snippets = [];
  let open = null; // { startLine, buf }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (open) {
      if (FENCE_CLOSE.test(line)) {
        snippets.push({ line: open.startLine, code: open.buf.join('\n') });
        open = null;
      } else open.buf.push(line);
      continue;
    }
    if (FENCE_OPEN.test(line)) {
      // look back up to 3 non-blank lines for the skip marker
      let skip = false;
      for (let k = i - 1, seen = 0; k >= 0 && seen < 3; k--) {
        const prev = lines[k].trim();
        if (prev === '') continue;
        seen++;
        if (prev === SKIP_MARK) {
          skip = true;
          break;
        }
      }
      if (!skip)
        open = { startLine: i + 2, buf: [] }; // code starts on the next line (1-based)
      else {
        // consume the skipped fence
        while (i + 1 < lines.length && !FENCE_CLOSE.test(lines[++i])) {
          /* skip */
        }
      }
    }
  }
  return snippets;
}

// ---------------------------------------------------------------- collect
for (const dir of DOCS_DIRS) {
  if (!existsSync(dir)) {
    console.error(
      `docs dir not found: ${dir}\n(set DOCS_DIRS or check out the docs repos as siblings)`,
    );
    process.exit(2);
  }
}
if (!existsSync(sdkDist)) {
  console.error('packages/sdk/dist not built — run `pnpm build` first.');
  process.exit(2);
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const manifest = []; // index -> { source, line }
let n = 0;
for (const dir of DOCS_DIRS) {
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const file = path.join(dir, name);
    for (const s of extract(file)) {
      const id = `snip_${String(n).padStart(3, '0')}`;
      manifest.push({
        id,
        source: `${path.basename(dir) === 'docs' ? path.basename(path.dirname(dir)) : dir}/docs/${name}`,
        line: s.line,
      });
      writeFileSync(path.join(workDir, `${id}.ts`), `export {};\n${s.code}\n`);
      n++;
    }
  }
}
console.log(`extracted ${n} TypeScript snippets from ${DOCS_DIRS.length} docs trees`);

writeFileSync(
  path.join(workDir, 'globals.d.ts'),
  [
    '// Ambient DATA identifiers docs snippets may use without declaring.',
    ...AMBIENT.map((x) => `declare const ${x}: any;`),
    '// API names with their REAL types (a later snippet may rely on an earlier import).',
    ...TYPED_GLOBALS.map(
      ([name, pkg]) => `declare const ${name}: typeof import('${pkg}').${name};`,
    ),
    ...NAMESPACE_GLOBALS.map(([name, pkg]) => `declare const ${name}: typeof import('${pkg}');`),
    "declare const OpenAI: typeof import('openai').default;",
    'declare function test(name: string, fn: (...args: unknown[]) => unknown): void;',
    'declare const expect: any;',
    '',
  ].join('\n'),
);

writeFileSync(
  path.join(workDir, 'tsconfig.json'),
  JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        lib: ['es2022'],
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        types: ['node'],
        baseUrl: '.',
        paths: { '@cendor/sdk': ['../dist/index.d.ts'] },
      },
      include: ['./**/*.ts'],
    },
    null,
    2,
  ),
);

// ---------------------------------------------------------------- typecheck
let out = '';
let failed = false;
try {
  out = execFileSync('pnpm', ['exec', 'tsc', '-p', workDir, '--pretty', 'false'], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
} catch (e) {
  failed = true;
  out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
}

if (!failed) {
  console.log(`OK — all ${n} snippets typecheck against the real packages.`);
  process.exit(0);
}

// Map tsc errors (docs-snippets/snip_NNN.ts(row,col): message) back to the markdown source.
const byId = new Map(manifest.map((m) => [m.id, m]));
const errLine = /snip_(\d{3})\.ts\((\d+),(\d+)\): (.*)$/;
let count = 0;
for (const line of out.split(/\r?\n/)) {
  const m = line.match(errLine);
  if (!m) continue;
  count++;
  const meta = byId.get(`snip_${m[1]}`);
  // row-1 because of the injected `export {};` header line
  console.error(`${meta.source}:${meta.line + Number(m[2]) - 2} — ${m[4]}`);
}
console.error(
  `\n${count} snippet error(s). Fix the docs tab (or mark a signature block with ${SKIP_MARK}).`,
);
process.exit(1);
