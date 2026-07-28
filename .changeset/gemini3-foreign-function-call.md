---
'@cendor/sdk': patch
---

A cross-provider handoff into a Gemini 3 agent no longer 400s on a missing `thought_signature`.

Gemini 3.x rejects a replayed `functionCall` that carries no `thoughtSignature` (400, "missing
thought_signature"). A handoff replays the *supervisor's* history into the receiving agent — an OpenAI
supervisor's `transfer_to_*` call, plus any real tool it called first — and none of those ever had a
signature, so the receiving Gemini agent could not make its first call.

**Nothing is fabricated.** A thought signature is an opaque token Google issues over **Gemini's own**
reasoning for that context; minting one would misrepresent provenance and be rejected as invalid
anyway. Instead the foreign turn is re-emitted as a text part stating the call, and its matching
`functionResponse` follows as text — the same information in a shape the API always accepts.

The scope is deliberately narrow, so Gemini's own tool loops are unchanged:

- only for models that validate signatures — `gemini-3` and later; 2.x and 1.5 never did, and their
  payload is byte-identical to before;
- only for a model turn where **not one** function-call part carries a signature. A turn with at least
  one signature came from Gemini itself (a parallel-call turn signs only the first part) and is
  replayed verbatim, signature included.

Found by the external black-box suite driving a live Gemini key (severity medium). The companion
finding on that scenario — Anthropic validating a foreign `tool_use.id` against `^[a-zA-Z0-9_-]+$` — is
untouched here.
