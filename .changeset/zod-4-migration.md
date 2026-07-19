---
"@cendor/sdk": minor
---

Require zod 4 for tool and output schemas; drop `zod-to-json-schema`.

Tool parameters and structured-output schemas are now converted with zod 4's native
`z.toJSONSchema` (`io: 'input'`, `additionalProperties: false` on every object) — the emitted
per-provider tool shapes are unchanged.

**Breaking for zod 3 callers.** A zod 3 schema passed to `tool({ parameters })` or an agent's
`outputType` is now rejected with a clear error instead of silently producing an empty parameter
schema (the failure mode in `@cendor/sdk` ≤ 0.10 when a zod 4 schema was passed). To migrate: on
zod 3.25+ change the import to `import { z } from 'zod/v4'`, or upgrade zod to `^4`, or pass a
pre-built JSON Schema via `jsonSchema:`. Users do not need to match the SDK's bundled zod version.
