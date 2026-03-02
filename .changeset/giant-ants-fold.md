---
'@tanstack/cli': minor
---

Remove the built-in MCP server from the CLI by dropping `tanstack mcp` and all MCP transport/tooling code.

Add CLI-native agent introspection commands (`libraries`, `doc`, `search-docs`, `ecosystem`) and JSON output for `create --list-add-ons` / `create --addon-details` so AI agents can rely on CLI commands directly.
