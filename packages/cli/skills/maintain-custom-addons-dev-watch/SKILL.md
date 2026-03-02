---
name: maintain-custom-addons-dev-watch
description: >
  Build and iterate custom add-ons/templates with tanstack add-on init,
  add-on compile, add-on dev, and tanstack dev --dev-watch, including sync
  loop preconditions, watch-path validation, and project metadata constraints.
type: lifecycle
library: tanstack-cli
library_version: "0.61.0"
requires:
  - add-addons-existing-app
---

# Maintain Custom Add-ons In Dev Watch

Use this skill for local add-on authoring workflows where you continuously compile and sync package output into a target app.

## Setup

```bash
npx @tanstack/cli add-on init
npx @tanstack/cli add-on compile
```

## Core Patterns

### Run add-on dev loop while editing source

```bash
npx @tanstack/cli add-on dev
```

### Sync watched package output into target app

```bash
npx @tanstack/cli dev --dev-watch ../my-addon-package
```

### Re-run compile before apply when changing metadata

```bash
npx @tanstack/cli add-on compile
npx @tanstack/cli add my-custom-addon
```

## Common Mistakes

### HIGH Use --dev-watch with --no-install

Wrong:
```bash
npx @tanstack/cli dev --dev-watch ../my-addon-package --no-install
```

Correct:
```bash
npx @tanstack/cli dev --dev-watch ../my-addon-package
```

Dev-watch rejects `--no-install`, so automated loops fail before any sync work starts.

Source: packages/cli/src/dev-watch.ts:112

### HIGH Start dev-watch without valid package entry

Wrong:
```bash
npx @tanstack/cli dev --dev-watch ../missing-or-invalid-package
```

Correct:
```bash
npx @tanstack/cli dev --dev-watch ../valid-addon-package
```

Watch setup validates path and package metadata first, so invalid targets fail before file syncing begins.

Source: packages/cli/src/dev-watch.ts:100

### CRITICAL Author add-on from code-router project

Wrong:
```bash
npx @tanstack/cli add-on init
```

Correct:
```bash
# Run add-on init from a file-router project
npx @tanstack/cli add-on init
```

Custom add-on authoring expects file-router mode and exits when run from incompatible project modes.

Source: packages/create/src/custom-add-ons/add-on.ts

### HIGH Run add-on workflows without scaffold metadata

Wrong:
```bash
npx @tanstack/cli add-on dev
```

Correct:
```bash
# Run in a project scaffolded by TanStack CLI (contains .cta.json), then:
npx @tanstack/cli add-on dev
```

Custom add-on flows rely on persisted scaffold options, so missing metadata blocks initialization and update paths.

Source: packages/create/src/custom-add-ons/shared.ts:158

### HIGH Tension: Backwards support vs deterministic automation

This domain's patterns conflict with add-addons-existing-app. Tooling assumes reusable automation, but hidden metadata preconditions from legacy support make add-on loops non-portable across repositories.

See also: add-addons-existing-app/SKILL.md § Common Mistakes
