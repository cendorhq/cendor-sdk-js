# @cendor/init

## 0.1.1

### Patch Changes

- 9c81182: Tidy the init CLI: remove the dead, undocumented `-y/--yes` flag; snapshot the `@cendor/mcp` /
  `@cendor/init` package versions so `doctor` can flag them when a project pins an outdated one; and
  re-point the vendored rules-template comments at the new `assistant-rules` docs page (the docs split
  the AI-assistant material out of `for-ai-assistants`). Template bodies are byte-identical — no
  behavior change.
