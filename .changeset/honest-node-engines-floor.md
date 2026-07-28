---
"@cendor/sdk": patch
"@cendor/init": patch
---

Declare the Node floor we actually test and can satisfy: `>=20`, not `>=18`.

`@cendor/sdk` claimed `engines.node >=18` while every `@cendor/*` library it depends on declares
`>=20`, so a Node 18 install resolved to an engines conflict raised by the transitive `@cendor/core`
rather than by the package the user asked for. CI has only ever tested Node 20 and 22, in both
`ci.yml` and the `verify` job that gates a release, so `>=18` was never an evidenced claim.

`@cendor/init` has no runtime dependencies, so `>=18` was satisfiable there — but equally untested,
and a CLI that claims a floor no CI exercises is the same defect in a quieter form. Both now state
the tested floor. Nothing else changes: no API, no behaviour, no output.
