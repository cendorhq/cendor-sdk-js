---
'@cendor/sdk': patch
---

Raised the `@cendor/core` floor to `^3.3.0` (and `@cendor/contextkit` to `^3.1.0`) so the SDK's own
governance composes. This is a correctness floor, not a feature one — nothing in this package changed.

The loop installs a `tokenguard` budget **and** a guardrails/acttrace gate on the same call, and before
core 3.3.0 a `Reroute` ended core's interceptor chain: the first library to rewrite a request silently
skipped the other, and which one you lost depended on registration order. Measured on the libraries
door with the real seams — a clamp registered before a `guard()` fired the clamp and sent the PII to
the provider **unredacted**; the reverse order redacted and left the token cap **silently unbound**. An
SDK user with both a budget and a guardrail was subject to exactly that, so admitting an older core
would leave the composition guarantee untrue.

Core 3.3.0 also brings two things an SDK user gets for free: a post-flight output guardrail now fires
for a response consumed through `responses.parse` / `chat.completions.parse` (the
`create()._thenUnwrap()` escape, which used to deliver banned text), and `instrument()` captures a raw
aws-sdk-v3 `BedrockRuntimeClient`. That last one means the SDK's synthetic `converse()` provider is no
longer the only way to see v3 Bedrock traffic — it still works, and it cannot double-count: a `send`
reached from inside another instrumented call stands down.
