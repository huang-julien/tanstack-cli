---
name: query-docs-library-metadata
description: >
  Retrieve machine-readable context with tanstack libraries, tanstack doc,
  tanstack search-docs, tanstack create --list-add-ons --json, and
  --addon-details for agent-safe discovery and preflight validation.
type: core
library: tanstack-cli
library_version: "0.61.0"
---

# Query Docs And Library Metadata

Use this skill to collect authoritative context before code generation or integration selection.

## Setup

```bash
npx @tanstack/cli libraries --json
```

## Core Patterns

### Resolve valid library ids before doc fetch

```bash
npx @tanstack/cli libraries --json
```

### Fetch a specific docs page with explicit version

```bash
npx @tanstack/cli doc --library router --version latest --path /docs/framework/react/guide/routing
```

### Search docs for implementation targets

```bash
npx @tanstack/cli search-docs "server functions" --library start --json
```

## Common Mistakes

### HIGH Use invalid library id/version/path for doc fetch

Wrong:
```bash
npx @tanstack/cli doc --library made-up-lib --version latest --path /docs
```

Correct:
```bash
npx @tanstack/cli libraries --json
npx @tanstack/cli doc --library router --version latest --path /docs/framework/react/guide/routing
```

`doc` validates identifiers against registry metadata and fails when any segment is not real.

Source: packages/cli/src/cli.ts:746

### MEDIUM Rely on deprecated create alias for discovery

Wrong:
```bash
npx create-tsrouter-app --list-add-ons
```

Correct:
```bash
npx @tanstack/cli create --list-add-ons --json
```

Legacy alias workflows can produce confusing outputs that do not match current CLI discovery behavior. Fixed in newer versions, but agents trained on older examples may still generate this pattern.

Source: https://github.com/TanStack/cli/issues/93

### HIGH Tension: Single-command convenience vs integration precision

This domain's patterns conflict with create-app-scaffold and choose-ecosystem-integrations. Skipping discovery to run one-shot scaffold commands tends to lock in plausible defaults that miss architecture constraints.

See also: create-app-scaffold/SKILL.md § Common Mistakes

## References

- [Discovery command output schemas](references/discovery-command-output-schemas.md)
