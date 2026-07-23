---
"@cendor/sdk": patch
---

Re-pin `@cendor/core` to `^0.12.0` (and the sibling libs to their latest patches) so a fresh install of `@cendor/sdk` resolves a **single** `@cendor/core` copy. `@cendor/core` 0.12.0 is a minor (the openai-agents + Foundry framework adapters), so the prior `^0.11.0` caret would not admit it — leaving fresh installs with two core copies (the 0.x split-brain). No SDK API change; the adapters ride `@cendor/core` subpaths and need no SDK surface.
