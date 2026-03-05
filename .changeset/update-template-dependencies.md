---
"@tanstack/create": minor
---

Update all template dependencies to latest versions. All `@tanstack/*` packages now use `"latest"` in templates and are resolved to pinned exact versions at project generation time via the npm registry. Third-party packages (vite, biome, sentry, clerk, convex, trpc, orpc, drizzle, prisma, zod, etc.) are updated to their current latest semver ranges and standardized across all add-ons.
