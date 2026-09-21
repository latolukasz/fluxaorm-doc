---
description: "fluxaorm.Context explained: per-request unit of work with identity map, transaction, pipelines, query loggers, metadata, Clone and CloneWithContext."
---

# Context

`fluxaorm.Context` is the handle every FluxaORM operation takes as its first argument. It bundles a standard `context.Context`, a reference to the [Engine](/guide/engine.html), and per-unit-of-work state: the identity map, the current transaction, pending cache invalidations, pipelines, query loggers and metadata.

A `Context` represents **one request or one unit of work**. Create a fresh one per request (or per job) and do not share it between goroutines - it holds mutable state such as the transaction and the identity map. When concurrent work needs the same settings, hand each goroutine its own `Clone()`.

## Creating a Context

```go{15}
package main

import (
    "context"
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    // ... register data pools and entities
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    ctx := engine.NewContext(context.Background())
    _ = ctx
}
```

In a web application, create the `Context` from the request's `context.Context` so cancellation and deadlines propagate:

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := engine.NewContext(r.Context())
    // use ctx for all database operations in this request
}
```

## Context Interface

```go
type Context interface {
    // The wrapped standard context and the owning Engine
    Context() context.Context
    Engine() Engine

    // Copies that share settings but not state
    Clone() Context
    CloneWithContext(context context.Context) Context

    // Entity writes and reloads
    Save(entities ...Entity) error
    Reload(entities ...Entity) error
    Delete(entities ...Entity) error
    ForceDelete(entities ...Entity) error

    // Transactions
    Transaction(fn func(tx Context) error) error
    InTransaction() bool
    DB(pool string) DBBase

    // Redis cache invalidation tied to the next Save
    InvalidateCacheKey(pool, key string)

    // Pipelines
    RedisPipeLine(pool string) *RedisPipeLine
    DatabasePipeLine(pool string) *DatabasePipeline

    // Query logging
    RegisterQueryLogger(handler LogHandler, options QueryLoggerOptions)
    EnableQueryDebug()
    EnableQueryDebugCustom(options QueryLoggerOptions)

    // Metadata
    SetMetaData(key, value string)
    GetMetaData() Meta

    // Identity map (context cache)
    DisableContextCache()
    GetFromContextCache(cacheIndex string, id uint64) Entity
    SetInContextCache(cacheIndex string, id uint64, entity Entity)
}

type Meta map[string]string

func (m Meta) Get(key string) string
```

## Standard Context and Engine

`Context()` returns the `context.Context` passed to `NewContext` (or `CloneWithContext`), for handing to non-FluxaORM code. `Engine()` returns the engine that created the context and is the usual way to reach pools from inside a function that only received a `Context`:

```go
stdCtx := ctx.Context()
redisPool := ctx.Engine().Redis(fluxaorm.DefaultPoolCode)
```

## Cloning

`Clone()` creates a new `Context` with the **same** `context.Context`; `CloneWithContext(c)` creates one bound to a different `context.Context` (a sub-deadline, a detached background context, ...). `Clone()` is literally `CloneWithContext(ctx.Context())`.

```go
ctx := engine.NewContext(context.Background())
ctx.SetMetaData("request_id", "abc123")
ctx.EnableQueryDebug()

// Same settings, independent state
worker := ctx.Clone()

// Same settings, 5 second deadline
timed, cancel := context.WithTimeout(ctx.Context(), 5*time.Second)
defer cancel()
sub := ctx.CloneWithContext(timed)
```

What a clone **inherits** (copied at clone time):

- the engine,
- query loggers registered so far and their enabled sources,
- the metadata map - as a **deep copy**, so `SetMetaData` on either side afterwards is not visible to the other,
- the `DisableContextCache()` flag.

What a clone **does not** inherit (starts empty):

- the identity map - the clone reads entities fresh (see [Context Cache](/guide/context_cache.html)),
- the transaction - a clone made inside `ctx.Transaction(...)` is **not** part of that transaction and its `InTransaction()` is `false`,
- pending cache invalidations,
- Redis and database pipelines.

Cloning is therefore the tool for fanning out to goroutines with the same logging and metadata, and for reading a row "as it is in the database" while the original context still holds a stale handle.

## Saving, Reloading and Deleting

```go
user := entities.UserEntityProvider.New(ctx)
user.SetName("Alice")
if err := ctx.Save(user); err != nil {
    return err
}

if err := ctx.Reload(user); err != nil {   // refresh the handle from the database
    return err
}
if err := ctx.Delete(user); err != nil {   // honours FakeDelete when the entity has it
    return err
}
```

- `Save(entities...)` writes exactly the given entities; a clean entity is a no-op. Saving more than one entity outside a transaction wraps them in one automatically.
- `Reload(entities...)` re-reads the rows from MySQL (bypassing the Redis row cache) and updates the handles in place, so every holder of the pointer, including the identity map, sees the fresh row. It refuses handles with unsaved changes (`ErrEntityUnsavedChanges`).
- `Delete(entities...)` removes the rows, or marks them when the entity has a `FakeDelete` field; `ForceDelete(entities...)` always removes the rows.

Details, dirty tracking and error values are in [CRUD](/guide/crud.html) and [Fake Delete](/guide/fake_delete.html).

## Transactions

```go
err := ctx.Transaction(func(tx fluxaorm.Context) error {
    order := entities.OrderEntityProvider.New(tx)
    order.SetQuantity(2)
    if err := tx.Save(order); err != nil {
        return err
    }
    _, err := tx.DB(fluxaorm.DefaultPoolCode).Exec(tx, "UPDATE stock SET count = count - ? WHERE id = ?", 2, 42)
    return err
})
```

- `Transaction(fn)` runs `fn` with every write on this context enrolled in one database transaction per MySQL pool. `BEGIN` is lazy - a function that only reads never opens one. Nested calls join the outer transaction; when a nested call fails the outer one can no longer commit and returns `fluxaorm.ErrTxRollbackOnly`. The `tx` argument is the same `Context` as the receiver.
- `InTransaction()` reports whether the context currently holds an open transaction.
- `DB(pool)` returns a `DBBase` for raw SQL that is **transaction-aware**: inside `Transaction` it returns the open transaction for that pool, otherwise the plain pool. Use `ctx.DB(pool)` rather than `ctx.Engine().DB(pool)` whenever the query must see or join the transaction's writes.

Nesting rules, rollback behaviour, `PostCommitError` and how caches behave around commit are described in [Transactions](/guide/transactions.html); the `DBBase` query API in [MySQL Queries](/guide/mysql_queries.html).

## Cache Invalidation

`InvalidateCacheKey(pool, key)` records a Redis key that the pending write makes stale. Generated write code registers the keys it knows about; the next `Save` deletes them once before the statement runs and once again after the transaction commits, closing the window in which a concurrent reader could repopulate the key from a pre-commit snapshot. Keys registered inside a transaction that rolls back are discarded. Use it for custom cache keys that depend on entity data:

```go
ctx.InvalidateCacheKey(fluxaorm.DefaultPoolCode, "user:42:profile")
err := ctx.Save(user)
```

See [Redis Cache](/guide/redis_cache.html) for the caching model.

## Pipelines

`RedisPipeLine(pool)` returns a **new** pipeline on every call; `DatabasePipeLine(pool)` returns the **same** pipeline per pool for the lifetime of the context.

```go
rp := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
rp.Set("key1", "value1", 0)
rp.Set("key2", "value2", 0)
_, err := rp.Exec(ctx)

dp := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
dp.AddQuery("INSERT INTO logs (message) VALUES (?)", "event happened")
dp.AddQuery("UPDATE counters SET count = count + 1 WHERE name = ?", "events")
err = dp.Exec(ctx)
```

Redis pipelines are covered in [Redis Operations](/guide/redis_operations.html), database pipelines in [MySQL Queries](/guide/mysql_queries.html).

## Query Logging

Query loggers are registered **per context** and inherited by clones. Each logger is enabled for one or more sources:

```go
type QueryLoggerOptions struct {
    MySQL      bool
    Redis      bool
    Clickhouse bool
    Nats       bool
}

type LogHandler interface {
    Handle(ctx Context, log map[string]any)
}
```

```go
// Built-in colored stderr logger for all four sources
ctx.EnableQueryDebug()

// Built-in logger for selected sources only
ctx.EnableQueryDebugCustom(fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true})

// Your own handler
ctx.RegisterQueryLogger(myLogger, fluxaorm.QueryLoggerOptions{MySQL: true, Nats: true})
```

`EnableQueryDebug()` is `EnableQueryDebugCustom(QueryLoggerOptions{MySQL: true, Redis: true, Clickhouse: true, Nats: true})`. Registering the same handler twice for a source is a no-op. The log map fields (`operation`, `query`, `pool`, `source`, `meta`, timings, `error`) are documented in [Queries Log](/guide/queries_log.html).

## Metadata

`SetMetaData`/`GetMetaData` store request-scoped string pairs on the context. Metadata is passed to query loggers under the `meta` key and copied into clones:

```go
ctx.SetMetaData("endpoint", "POST /orders")
ctx.SetMetaData("user_id", "42")

meta := ctx.GetMetaData()   // Meta{"endpoint": "POST /orders", "user_id": "42"}
value := meta.Get("user_id") // "42"
```

`GetMetaData()` returns the live map; treat it as read-only.

One key is special: `fluxaorm.MetricsMetaKey`. Its value becomes the `source` label on every Prometheus metric emitted through this context (default `"default"`). Task consumers set it to the task name automatically.

```go
ctx.SetMetaData(fluxaorm.MetricsMetaKey, "checkout-api")
```

See [Metrics](/guide/metrics.html).

## Context Cache

Every context keeps an **identity map**: the first time an entity row is loaded through this context (for example with `GetByID`), the resulting `*Entity` is stored under its type and ID, and later loads of the same row in the same context return the same pointer without touching Redis or MySQL. Entries never expire - the map lives exactly as long as the context. Use `Reload` to refresh a handle, or a `Clone()` to read fresh.

```go
ctx.DisableContextCache() // this context (and its later clones) always reads from the data source
```

`GetFromContextCache(cacheIndex, id)` and `SetInContextCache(cacheIndex, id, entity)` are the low-level accessors used by generated code; `cacheIndex` is the entity's package-qualified type name. After `DisableContextCache()` the getter returns `nil` and the setter is a no-op. See [Context Cache](/guide/context_cache.html).
