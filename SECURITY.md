# Security Policy

We take the security of the Cendor projects seriously. Thank you for helping keep them and their
users safe.

This policy covers the packages published from this repository: **`@cendor/sdk`** (the governed agent
SDK) and **`@cendor/init`** (the offline `init` / `doctor` dev-tooling CLI).

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through **GitHub Private Vulnerability Reporting**:

> https://github.com/cendorhq/cendor-sdk-js/security/advisories/new

(or open this repository's **Security** tab and choose **Report a vulnerability**). This creates a
private advisory only the maintainers can see, and lets us collaborate on a fix and coordinate
disclosure with you.

Please include, where you can:

- the affected package(s) and version(s),
- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- any known mitigations.

## Scope

`@cendor/sdk` is a **local-first** library — it runs in your process, with no Cendor-operated servers
or network services, and no account or API key of ours. The only calls it makes are to *your* LLM
provider with *your* key. That shapes the threat model: there is no hosted endpoint of ours to
attack. Relevant classes of issues include, for example:

- audit hash-chain verification flaws, or `_meta`/HMAC signature forgery in an `AuditLog`,
- a redaction bypass on a governed call (PII reaching a provider, a log, a span, or an audit entry),
- budget enforcement that a run can escape — spend that gets past a cap or a per-agent ceiling,
- a guardrail gate that can be evaded, or that fails *open* where it should fail closed,
- unsafe deserialization of a cassette, checkpoint, session store, policy file, or tool argument,
- a tool-calling or MCP path that executes something the agent's declared schema does not allow,
- secret leakage into a log, span, audit entry, checkpoint, or exception message.

For `@cendor/init`, which writes files into *your* repository: writing outside the target directory,
clobbering content it does not own, or emitting a scaffold that leaks a key. `init` and `doctor` make
**no network call** unless you pass `doctor --online`, which does one read-only GET to
`https://cendor.ai/releases.json`.

Out of scope: findings that require a modified build of the package, the security of a third-party
provider SDK we merely wrap (report those upstream), and anything that depends on you deliberately
opting into content capture and then exporting it somewhere unprotected.

The audit trail produces **evidence to support** a compliance case — it is not a compliance
guarantee.

## What to expect

- We aim to acknowledge a report within a few business days.
- We'll work with you on a fix and a coordinated disclosure timeline, and credit you in the advisory
  unless you prefer to remain anonymous.

## Supported versions

Fixes land on the latest released minor of each affected package (see
[`packages/sdk/CHANGELOG.md`](packages/sdk/CHANGELOG.md) and
[`packages/init/CHANGELOG.md`](packages/init/CHANGELOG.md)). Versions are independent across
languages, so the same fix may ship under different version numbers here and in the Python
[`cendor-sdk`](https://github.com/cendorhq/cendor-sdk).
