/** Detect the project shape, which assistants are configured, which providers/cendor packages exist. */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Assistant, Ecosystem } from './types.js';

/** npm provider package → normalized provider key. */
const NPM_PROVIDERS: Record<string, string> = {
  openai: 'openai',
  '@anthropic-ai/sdk': 'anthropic',
  '@google/genai': 'google',
  '@google/generative-ai': 'google',
  '@aws-sdk/client-bedrock-runtime': 'bedrock',
  ollama: 'ollama',
  '@mistralai/mistralai': 'mistral',
  'cohere-ai': 'cohere',
};

/** PyPI provider distribution → normalized provider key. */
const PYPI_PROVIDERS: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  'google-genai': 'google',
  'google-generativeai': 'google',
  boto3: 'bedrock',
  ollama: 'ollama',
  mistralai: 'mistral',
  cohere: 'cohere',
  huggingface_hub: 'huggingface',
  'huggingface-hub': 'huggingface',
  // Source-import spellings (not distribution names, but seen in `import ...` statements).
  'google.genai': 'google',
  google_genai: 'google',
};

/** Regex matching a provider import in JS/TS source → normalized key. */
const NPM_IMPORT_RE =
  /(?:from|require|import)\s*\(?\s*['"](openai|@anthropic-ai\/sdk|@google\/genai|@google\/generative-ai|@aws-sdk\/client-bedrock-runtime|ollama|@mistralai\/mistralai|cohere-ai)['"]/g;

/** Regex matching a provider import in Python source → normalized key. */
const PY_IMPORT_RE =
  /(?:^|\n)[ \t]*(?:import|from)[ \t]+(openai|anthropic|google\.genai|google_genai|boto3|ollama|mistralai|cohere|huggingface_hub)\b/g;

export interface Detected {
  root: string;
  ecosystem: Ecosystem;
  node: boolean;
  python: boolean;
  /** Provider SDKs declared in manifests (package.json deps / pyproject / requirements). */
  declaredProviders: Set<string>;
  /** Assistant configs already present in the repo. */
  assistants: Assistant[];
  /** Installed @cendor/* → version (from node_modules), best source of truth for npm. */
  installedNpm: Record<string, string>;
  /** Declared @cendor/* → version range string (from package.json). */
  declaredNpm: Record<string, string>;
  /** Declared cendor-* → version spec (from pyproject/requirements); TS can't run Python to get installed. */
  declaredPypi: Record<string, string>;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pkgDeps(pkg: Record<string, unknown> | null): Record<string, string> {
  if (!pkg) return {};
  const out: Record<string, string> = {};
  for (const key of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const block = pkg[key];
    if (block && typeof block === 'object') {
      for (const [name, ver] of Object.entries(block as Record<string, string>)) out[name] = ver;
    }
  }
  return out;
}

function detectAssistants(root: string): Assistant[] {
  const found: Assistant[] = [];
  if (existsSync(join(root, '.github'))) found.push('copilot');
  if (existsSync(join(root, '.cursor'))) found.push('cursor');
  if (existsSync(join(root, 'AGENTS.md'))) found.push('agents');
  if (existsSync(join(root, 'CLAUDE.md'))) found.push('claude');
  if (existsSync(join(root, '.windsurf'))) found.push('windsurf');
  return found;
}

/** Parse `cendor-*` / provider pins out of a pyproject.toml or requirements file (line-based). */
function parsePyDeps(text: string): { cendor: Record<string, string>; providers: Set<string> } {
  const cendor: Record<string, string> = {};
  const providers = new Set<string>();
  // Match a dependency token like `cendor-core>=1.3,<2` or `openai` (quoted or bare).
  const depRe = /["'\s]([a-zA-Z][a-zA-Z0-9._-]*)\s*((?:[<>=!~]=?|==)\s*[0-9][^"',\]]*)?/g;
  let m = depRe.exec(text);
  while (m !== null) {
    const rawName = (m[1] ?? '').toLowerCase();
    const spec = (m[2] ?? '').replace(/\s+/g, '');
    const base = rawName.split('[')[0] as string; // strip extras like cendor-sdk[all]
    if (base.startsWith('cendor')) cendor[base] = spec || '*';
    const prov = PYPI_PROVIDERS[base];
    if (prov) providers.add(prov);
    m = depRe.exec(text);
  }
  return { cendor, providers };
}

export function detectProject(root: string): Detected {
  const node = existsSync(join(root, 'package.json'));
  const python =
    existsSync(join(root, 'pyproject.toml')) ||
    existsSync(join(root, 'setup.py')) ||
    existsSync(join(root, 'setup.cfg')) ||
    readdirSync(root, { withFileTypes: true }).some(
      (e) => e.isFile() && /^requirements.*\.txt$/.test(e.name),
    );

  const ecosystem: Ecosystem = node ? 'node' : python ? 'python' : 'unknown';

  const declaredProviders = new Set<string>();
  const installedNpm: Record<string, string> = {};
  const declaredNpm: Record<string, string> = {};
  const declaredPypi: Record<string, string> = {};

  if (node) {
    const deps = pkgDeps(readJson(join(root, 'package.json')));
    for (const [name, ver] of Object.entries(deps)) {
      if (NPM_PROVIDERS[name]) declaredProviders.add(NPM_PROVIDERS[name] as string);
      if (name.startsWith('@cendor/')) declaredNpm[name] = ver;
    }
    // Installed versions win over declared ranges — read node_modules/@cendor/*/package.json.
    const scopeDir = join(root, 'node_modules', '@cendor');
    if (existsSync(scopeDir)) {
      for (const entry of readdirSync(scopeDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pkg = readJson(join(scopeDir, entry.name, 'package.json'));
        const v = pkg?.version;
        if (typeof v === 'string') installedNpm[`@cendor/${entry.name}`] = v;
      }
    }
  }

  if (python) {
    for (const fname of [
      'pyproject.toml',
      'requirements.txt',
      'requirements-dev.txt',
      'setup.cfg',
    ]) {
      const fpath = join(root, fname);
      if (!existsSync(fpath)) continue;
      const parsed = parsePyDeps(readFileSync(fpath, 'utf8'));
      for (const p of parsed.providers) declaredProviders.add(p);
      Object.assign(declaredPypi, parsed.cendor);
    }
  }

  return {
    root,
    ecosystem,
    node,
    python,
    declaredProviders,
    assistants: detectAssistants(root),
    installedNpm,
    declaredNpm,
    declaredPypi,
  };
}

/** Scan source text for provider imports actually used (independent of what's declared). */
export function providersUsedInSource(text: string, kind: 'node' | 'python'): Set<string> {
  const used = new Set<string>();
  const re = kind === 'node' ? NPM_IMPORT_RE : PY_IMPORT_RE;
  re.lastIndex = 0;
  let m = re.exec(text);
  while (m !== null) {
    const token = (m[1] ?? '').replace('.', '_');
    const key =
      kind === 'node'
        ? NPM_PROVIDERS[m[1] ?? '']
        : (PYPI_PROVIDERS[token] ?? PYPI_PROVIDERS[m[1] ?? '']);
    if (key) used.add(key);
    m = re.exec(text);
  }
  return used;
}

/** The npm package that ships each provider SDK (for the "install X" fix hint). */
export const NPM_PKG_FOR_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: '@anthropic-ai/sdk',
  google: '@google/genai',
  bedrock: '@aws-sdk/client-bedrock-runtime',
  ollama: 'ollama',
  mistral: '@mistralai/mistralai',
  cohere: 'cohere-ai',
};

export const PYPI_EXTRA_FOR_PROVIDER: Record<string, string> = {
  openai: 'openai',
  anthropic: 'anthropic',
  google: 'google',
  bedrock: 'bedrock',
  ollama: 'ollama',
  huggingface: 'huggingface',
};
