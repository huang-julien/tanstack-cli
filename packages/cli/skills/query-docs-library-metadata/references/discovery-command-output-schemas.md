# Discovery Command Output Schemas

Targets `@tanstack/cli` v0.61.0.

## `tanstack libraries --json`

```json
{
  "count": 3,
  "libraries": [
    {
      "id": "router",
      "label": "TanStack Router",
      "description": "Type-safe routing",
      "latestVersion": "latest"
    }
  ]
}
```

## `tanstack search-docs <query> --json`

```json
{
  "query": "server functions",
  "results": [
    {
      "library": "start",
      "version": "latest",
      "title": "Server Functions",
      "path": "/docs/framework/react/guide/server-functions"
    }
  ]
}
```

## `tanstack create --list-add-ons --json`

```json
{
  "count": 4,
  "addOns": [
    {
      "id": "drizzle",
      "name": "Drizzle",
      "category": "database",
      "dependsOn": []
    }
  ]
}
```

## `tanstack create --addon-details <id> --json`

```json
{
  "id": "prisma",
  "name": "Prisma",
  "options": [
    {
      "name": "provider",
      "default": "postgres",
      "choices": ["postgres", "sqlite", "mysql"]
    }
  ],
  "dependsOn": []
}
```

Use this reference to parse shapes defensively and normalize fields before feeding downstream planning or generation steps.
