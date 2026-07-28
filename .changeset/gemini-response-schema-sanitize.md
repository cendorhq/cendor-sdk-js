---
'@cendor/sdk': patch
---

`Agent({ outputType })` and tool declarations no longer send Gemini a JSON-Schema key its API rejects.

The Gemini `Schema` proto does not model `additionalProperties`, and the SDK deliberately stamps
`additionalProperties: false` onto every object node (zod 4 omits it under `io: 'input'`). `@google/genai`
does strip that key itself — **but only while recursing `properties` / `items` / `anyOf`**. A
`prefixItems` subtree (a zod tuple) or a `$defs` subtree is copied to the wire verbatim, so the key
reached the Gemini Developer API and it answered 400 `INVALID_ARGUMENT`. Measured against
`@google/genai` 2.13.0 with the network mocked, so a schema-level assertion could not miss it:

```
"responseSchema":{"type":"OBJECT","properties":{"tup":{"type":"ARRAY",
  "prefixItems":[{ … "additionalProperties":false}]}}}
```

`config.responseSchema` and `Tool.toGemini()`'s `parameters` now go through one sanitizer, so the two
cannot drift. It returns a new structure — a caller's schema object (and the public `Tool.parameters`
field) is never mutated. Also dropped: `additional_properties`, google-genai's own snake_case spelling
of the same field, which the TS client forwards verbatim because it only knows the camelCase name; and
`title` / `default`, which the proto does accept but which `cendor-sdk` drops, for cross-language
parity — both are hints, not constraints.

`$defs` / `$ref` are deliberately **kept**: dropping half the pair breaks a nested model outright. So is
`$schema` — `@google/genai` re-routes a `$schema`-bearing schema to the permissive `responseJsonSchema`
field, where full JSON Schema is legal, so stripping it would *downgrade* a working request onto the
strict proto. That is the one place this diverges from the Python fix, which can drop `$schema` because
its client inlines `$defs` first. Keys inside `properties` / `$defs` are user data, so a field genuinely
named `title` or `default` still survives.

Mirrors the `cendor-sdk` fix so the two languages agree (severity high — structured output on Gemini
did not work).
