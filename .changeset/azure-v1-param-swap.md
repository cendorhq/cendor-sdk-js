---
'@cendor/sdk': minor
---

**Two Azure/Foundry fixes found by live verification of the SDK door, plus the Foundry SDK path in
the docs.** Both defects need a real deployment to reproduce, so the offline suite could not see
them; both are now pinned offline with negative controls, and the door was re-verified live on five
legs (`provider: 'azure'` on both host forms, `azure_responses`, an injected Foundry-SDK client, and
the project endpoint as `baseUrl`).

1. **`Agent({ maxTokens })` failed outright on a reasoning-family deployment.** A `gpt-5`/`o*`
   deployment answers a Chat Completions call carrying `max_tokens` with *"Unsupported parameter:
   'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."* This cannot
   be solved with a model-name prefix list the way `temperature` was — on Azure the id a call carries
   is the **deployment** name the user chose, and `"my-chat"` says nothing about the model behind it.
   The new `callModel(create, kwargs, retry)` therefore reads the provider's own message: when a
   failure names both the rejected parameter **and** its replacement, the request is re-issued
   **once** with the rename. Narrow by construction (message names both sides, the old key is
   present, the new key is not already set), costs no retry attempt and no backoff, and a second
   failure reaches the caller. `paramSwap` is exported for testing/introspection; `callWithRetry` is
   unchanged.

2. **A Foundry *project* endpoint is accepted as `baseUrl`.**
   `https://<res>.services.ai.azure.com/api/projects/<name>` — the value the portal shows and the one
   `@azure/ai-projects` is constructed with — now takes the `/openai/v1/` route like the two bare
   host forms. Measured: with the route it serves Chat Completions (exactly what
   `AIProjectClient.getOpenAIClient()` builds); without it the bare endpoint answers
   `400 Missing required query parameter: api-version` — an error that reads like *"go back to the
   legacy AzureOpenAI client"* and is not. Matched on the **path**, so a sovereign/private Foundry
   host is covered too.

Docs (`cendor-sdk/docs/providers.md`, shared by both languages) gain a **With the Foundry SDK**
subsection — `AIProjectClient` → `getOpenAIClient()` → `Agent({ client })` — and record one honest
cross-language difference: the Python `azure-ai-projects` documents an `api_key=` override on
`get_openai_client(...)`, while `@azure/ai-projects` always overwrites `apiKey` with its Entra token
provider, so on the JS side authentication goes through the constructor's credential.
