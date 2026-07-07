---
"@cendor/sdk": minor
---

Unify the `@cendor/*` dependency line on the core 0.4.0 cascade and ship keyless Entra-ID auth.

- **Fix (dependency resolution):** bump every `@cendor/*` dependency to the published set that resolves a **single** `@cendor/core` (`core`/`acttrace` → `^0.4.0`, `tokenguard`/`cassette`/`squeeze` → `^0.2.5`, `contextkit` → `^1.0.5`). Previously the SDK pinned `@cendor/core ^0.3.0` and `@cendor/acttrace ^0.3.0` while the other libs had moved to `core ^0.4.0`, so a fresh `npm i @cendor/sdk` installed two `@cendor/core` instances — two event-bus singletons — and budget enforcement, `track`, cassette replay, and downgrade-reroute silently no-op'd. All governance/orchestration tests pass with the unified single core.
- **Feature:** `azureADTokenProvider` (an async `() => Promise<string>` token callback) on the agent/client options authenticates against Azure AI Foundry with Microsoft Entra ID (keyless), refreshing the token per request. Requires the `AzureOpenAI` client from `openai >= 4.53`.
