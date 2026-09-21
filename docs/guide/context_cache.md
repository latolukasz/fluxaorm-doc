---
description: "The FluxaORM context cache: a per-Context identity map that returns one pointer per entity ID and never expires within the Context."
---

# Context Cache

The context cache is the **identity map** of a `fluxaorm.Context`: for every entity type and ID it holds at most one `*Entity`, and every load on that context returns that same pointer. It lives exactly as long as the `Context` and never expires.

```go
ctx := engine.NewContext(context.Background())

a, _, _ := entities.UserEntityProvider.GetByID(ctx, 1) // Redis or MySQL
b, _, _ := entities.UserEntityProvider.GetByID(ctx, 1) // served from the context cache
// a == b: the same pointer
```

## Why an identity map

Two handles on one row are how updates get lost: code path A loads a user and changes the name, code path B loads the "same" user, changes the e-mail and saves — B's save carries B's stale name and, once A saves, A's stale e-mail. With one pointer per row and per context both paths change the same object, and whoever saves writes both changes. This is also why the map never expires: an expiring entry would silently hand out a second, divergent handle in the middle of a unit of work. To make a handle current, use [`ctx.Reload`](/guide/crud.html#reloading), which refreshes the pointer everyone holds.

The consequence is that a `Context` should be scoped to one unit of work — an HTTP request, a job, a message — and created fresh for the next one. A long-running loop that loads many rows on one `Context` keeps all of them in memory.

## What populates and evicts it

| Operation | Effect on the context cache |
|:----------|:----------------------------|
| `Provider.New(ctx)`, `Provider.NewWithID(ctx, id)` | The new entity is inserted immediately, before it is saved. |
| `GetByID`, `MustGetByID`, `GetByIDs` | Hits are served from the map; misses loaded from Redis or MySQL are inserted. |
| `SearchOne`, `SearchMany`, `SearchManyWithTotal`, `SearchOneInRedis`, `SearchManyInRedis`, `SearchManyInRedisWithTotal` | These select ids and hydrate through `GetByID` / `GetByIDs`, so search results come from and go into the map too. |
| Setters | No effect. A dirty entity stays in the map — that is the point. |
| `ctx.Save` | The entity stays in the map, now clean. |
| `ctx.Delete`, `ctx.ForceDelete` | The entity is removed after the write commits. A [fake-deleted](/guide/fake_delete.html) entity is removed as well; the next `GetByID` re-reads it from the database (found, with `GetFakeDelete() == true`). |
| `ctx.Reload` | The entry is refreshed in place; the pointer does not change. |
| `ctx.Clone()`, `ctx.CloneWithContext(...)` | The clone starts with an **empty** map. It shares no entities with the original, so a row loaded on both is two handles — treat the clone as a separate unit of work. |

## Disabling the context cache

```go
ctx := engine.NewContext(context.Background())
ctx.DisableContextCache()

a, _, _ := entities.UserEntityProvider.GetByID(ctx, 1) // Redis or MySQL
b, _, _ := entities.UserEntityProvider.GetByID(ctx, 1) // Redis or MySQL again, a != b
```

Once disabled it cannot be re-enabled on that context; clones inherit the flag. With the cache disabled every load creates a new handle, which brings back the lost-update problem described above — use it for measurements and tests (for example to count Redis or SQL round trips), not as a memory-saving device.

## Low-level access

The generated code talks to the identity map through two methods of `Context`:

```go
GetFromContextCache(cacheIndex string, id uint64) Entity
SetInContextCache(cacheIndex string, id uint64, entity Entity)
```

`cacheIndex` is the fully qualified Go type name of the entity struct as registered (`model.UserEntity`); it is stored in every provider and assigned during `registry.Validate()`. `GetFromContextCache` returns `nil` when the entry is missing or the cache is disabled; `SetInContextCache` is a no-op when the cache is disabled. You should not need them in application code.
