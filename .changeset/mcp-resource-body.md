---
'@cendor/sdk': patch
---

`loadMcpResources` returns the resource body instead of `"[object Object]"`.

An MCP *resource read* body rides `contents[].text` (`ReadResourceResult`), not the `content[].text` of
a tool-call result. The loader fed the read result to the tool-result extractor, which recognized
neither key and fell through to `String(result)` — so every resource collapsed to the literal string
`"[object Object]"`, and any agent handed one got no content at all.

Resource reads now have their own extractor:

- every text entry is joined with `\n` (so a multi-part resource keeps all of it);
- an empty `contents` list is `''`;
- a `BlobResourceContents` entry contributes nothing — this function's contract is the resource's
  *text*, and base64 bytes are not text to hand a model;
- any other shape still falls back to the tool-result extractor, so a non-spec server behaves exactly
  as before.

Found by the external black-box suite driving live MCP servers (severity medium).
