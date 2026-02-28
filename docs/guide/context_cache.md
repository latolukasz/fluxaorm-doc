# Context Cache

In this section, you will learn how to use the context cache to speed up your application.

The context cache is a per-request, in-memory cache that lives on the `fluxaorm.Context` object. It is **enabled by default** with a TTL of **1 second**. When an entity is loaded via `GetByID` or `GetByIDs`, it is automatically stored in the context cache. Subsequent calls to `GetByID` or `GetByIDs` for the same entity within the TTL window will return the cached copy without hitting MySQL or Redis.

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

ctx := engine.NewContext(context.Background())
user, found, err := UserEntityProvider.GetByID(ctx, 1) // executes query to DB/Redis
user, found, err = UserEntityProvider.GetByID(ctx, 1)  // served from context cache (no DB/Redis query)
```

:::tip
The context cache is only populated by `GetByID` and `GetByIDs`. Search methods (`Search`, `SearchOne`, `SearchIDs`, etc.) do **not** read from or write to the context cache.
:::

## TTL and Expiration

The default TTL is 1 second (1000 milliseconds). When the TTL expires, the **entire** context cache map is cleared on the next read attempt. This means all cached entities across all entity types are removed at once, not on a per-entry basis.

This design makes the context cache ideal for short-lived scopes such as a single HTTP request. For long-running processes, either disable the context cache or use a short TTL and create a fresh context for each unit of work.

## Customizing the TTL

You can change the TTL using `SetContextCacheTTL()`:

```go
ctx := engine.NewContext(context.Background())
ctx.SetContextCacheTTL(5 * time.Second) // cache entries are valid for 5 seconds
```

Set the TTL before any `GetByID` / `GetByIDs` calls to ensure it takes effect from the start.

## Disabling the Context Cache

You can disable the context cache entirely by calling `DisableContextCache()`:

```go
ctx := engine.NewContext(context.Background())
ctx.DisableContextCache()

user, found, err := UserEntityProvider.GetByID(ctx, 1) // always executes query to DB/Redis
user, found, err = UserEntityProvider.GetByID(ctx, 1)  // always executes query to DB/Redis
```

Once disabled, the context cache cannot be re-enabled on the same context. If you need caching again, create a new context.

## How It Works Internally

The context cache uses two low-level methods on the `Context` interface that are called by the generated entity code:

- `GetFromContextCache(cacheIndex uint64, id uint64) Entity` -- looks up an entity in the cache by its type index and ID. Returns `nil` if not found or if the cache is disabled/expired.
- `SetInContextCache(cacheIndex uint64, id uint64, entity Entity)` -- stores an entity in the cache. Does nothing if the cache is disabled.

The `cacheIndex` is a unique identifier for each entity type, generated at code-generation time. You should not need to call these methods directly -- they are used automatically by the generated `GetByID` and `GetByIDs` functions.

## Interaction with Entity Tracking

When an entity is modified and tracked for flushing (via `ctx.Track()`), it is **removed** from the context cache. This prevents stale reads of an entity that has pending changes. After `ctx.Flush()` completes, subsequent `GetByID` calls will fetch the updated entity from the database and re-populate the context cache.
