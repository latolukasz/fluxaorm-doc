# Context

In this section, we will explore the fundamental element of FluxaORM: the `fluxaorm.Context` interface, and discover how to create and effectively use it.

In the previous chapter, you learned how to create the `Engine` object, an essential component for accessing data pools and managing registered entities. The `Context` plays a pivotal role in all FluxaORM operations -- it is typically the first argument to every Provider method, facilitating data retrieval and modification in your databases.

## Creating a Context

To create a `fluxaorm.Context`, call the `NewContext()` method on an `Engine` object, passing a standard `context.Context`:

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
}
```

In a web application, you would typically create a new `Context` for each incoming request, using the request's `context.Context`:

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := engine.NewContext(r.Context())
    // use ctx for all database operations in this request
}
```

## Context Interface

The `fluxaorm.Context` interface provides the following methods:

```go
type Context interface {
    // Returns the underlying standard context.Context
    Context() context.Context

    // Creates a copy of this Context sharing metadata and debug settings
    Clone() Context

    // Creates a copy with a different context.Context
    CloneWithContext(context context.Context) Context

    // Returns the Engine that created this Context
    Engine() Engine

    // Disables the per-request context cache
    DisableContextCache()

    // Sets the time-to-live for context cache entries
    SetContextCacheTTL(ttl time.Duration)

    // Flushes all tracked entity changes to MySQL and Redis
    Flush() error

    // Flushes changes asynchronously via Redis Streams
    FlushAsync() error

    // Returns an async SQL consumer for processing queued FlushAsync operations
    GetAsyncSQLConsumer() (AsyncSQLConsumer, error)

    // Discards all tracked entity changes without flushing
    ClearFlush()

    // Returns a Redis pipeline for batching Redis commands
    RedisPipeLine(pool string) *RedisPipeLine

    // Returns a database pipeline for batching SQL queries
    DatabasePipeLine(pool string) *DatabasePipeline

    // Registers a query logger for observing executed queries
    RegisterQueryLogger(handler LogHandler, mysql, redis, local bool)

    // Enables debug logging for all query types
    EnableQueryDebug()

    // Enables debug logging for specific query types
    EnableQueryDebugCustom(mysql, redis, local bool)

    // Stores a metadata key-value pair
    SetMetaData(key, value string)

    // Returns all stored metadata
    GetMetaData() Meta

    // Tracks an entity for the next Flush() call
    Track(e Entity, cacheIndex uint64)

    // Returns the event broker for publishing/subscribing to entity events
    GetEventBroker() EventBroker
}
```

## Flushing Changes

The `Flush()` method is one of the most important operations in FluxaORM. When you create, modify, or delete entities, those changes are not sent to the database immediately. Instead, entities are tracked in memory, and all changes are persisted in a single batch when you call `Flush()`.

```go
// Create and modify entities
user := entities.UserProvider.New(ctx)
user.SetName("Alice")
user.SetEmail("alice@example.com")

product := entities.ProductProvider.New(ctx)
product.SetName("Widget")

// Persist all changes at once
err := ctx.Flush()
if err != nil {
    // handle error
}
```

`Flush()` executes the following steps in order:

1. Calls `PrivateFlush()` on each tracked entity, which builds the necessary SQL queries and Redis commands.
2. Executes all batched SQL queries via database pipelines.
3. Executes all batched Redis commands via Redis pipelines.
4. Marks all tracked entities as flushed and clears the tracking list.

### Asynchronous Flush

`FlushAsync()` works similarly to `Flush()`, but instead of executing SQL queries directly against MySQL, it publishes them to a Redis Stream. Redis cache and search indexes are still updated immediately (optimistic update). A separate consumer process retrieves and executes the SQL queries asynchronously.

```go
err := ctx.FlushAsync()
if err != nil {
    // handle error
}
```

To process the queued SQL operations, create a consumer:

```go
consumer, err := ctx.GetAsyncSQLConsumer()
if err != nil {
    // handle error
}
// Run the consumer in a goroutine or dedicated worker
```

### Clearing Tracked Changes

If you want to discard all pending changes without flushing, use `ClearFlush()`:

```go
user := entities.UserProvider.New(ctx)
user.SetName("Alice")

// Changed your mind -- discard everything
ctx.ClearFlush()
```

## Entity Tracking

When you create a new entity via `Provider.New()` or `Provider.NewWithID()`, it is automatically tracked by the Context. When you modify an existing entity (via any setter), it is also automatically tracked. You do not need to manually track entities in normal usage.

The `Track()` method is used internally by generated code. Each call to a setter that changes a value will call `Track()` automatically to ensure the entity is included in the next `Flush()`.

## Query Debug

You can activate debug mode to observe all queries executed against MySQL, Redis, and the local cache.

```go
// Enable debug logging for all query types
ctx.EnableQueryDebug()

// Enable debug logging for specific types only
ctx.EnableQueryDebugCustom(true, false, false)  // MySQL only
ctx.EnableQueryDebugCustom(true, true, false)   // MySQL and Redis
ctx.EnableQueryDebugCustom(false, false, true)  // Local cache only
```

Every query is displayed in two lines. The first line contains:

- FluxaORM logo
- Query source (MySQL, Redis, local cache)
- Data pool name
- Operation type
- Query time in milliseconds

The length of the indicator bar correlates with query time -- longer and more red for slower queries, helping you identify performance issues. The full query is displayed on the second line.

### Custom Query Loggers

For production use, you can register custom query loggers that implement the `LogHandler` interface:

```go
ctx.RegisterQueryLogger(myLogger, true, true, false) // MySQL + Redis
```

## Metadata

You can use the Context to store request-scoped key-value metadata using `SetMetaData` and `GetMetaData`:

```go
ctx.SetMetaData("source", "cron_A")
ctx.SetMetaData("user_id", "42")

meta := ctx.GetMetaData() // Meta{"source": "cron_A", "user_id": "42"}
value := meta.Get("source") // "cron_A"
```

Metadata is useful for tagging queries with request information (e.g., which API endpoint or background job triggered them), which can then be used in query loggers or metrics.

## Cloning a Context

You can create as many `Context` instances as needed. However, if you want to share settings like metadata and debug mode across multiple contexts, use `Clone()`:

```go
ctx := engine.NewContext(context.Background())
ctx.SetMetaData("admin_user_id", "34")
ctx.EnableQueryDebug()

// Clone shares metadata and debug settings
ctx2 := ctx.Clone()
ctx2.GetMetaData() // Meta{"admin_user_id": "34"}
```

`Clone()` creates a new `Context` that inherits:

- Metadata
- Debug/logger settings
- Context cache settings (disabled state, TTL)

The cloned context has its own tracking state -- entities tracked in the original context are not tracked in the clone. Each context flushes independently.

### Clone with a Different context.Context

Use `CloneWithContext()` to create a clone with a different `context.Context`, useful for sub-requests with different deadlines:

```go
ctx := engine.NewContext(context.Background())
ctx.SetMetaData("request_id", "abc123")

subCtx := ctx.CloneWithContext(
    context.WithTimeout(r.Context(), 5*time.Second),
)
```

## Context Cache

The Context includes a short-lived, per-request entity cache. When an entity is loaded (e.g., via `GetByID`), it is stored in the context cache. Subsequent requests for the same entity within the same Context return the cached instance without hitting Redis or MySQL.

### Disabling Context Cache

If you need to always fetch fresh data:

```go
ctx.DisableContextCache()
```

### Setting Context Cache TTL

The default TTL is 1 second. You can adjust it:

```go
ctx.SetContextCacheTTL(5 * time.Second)
```

After the TTL expires, the cache is cleared on the next access, and entities are loaded fresh from the data source.

## Database Pipeline

For batch SQL operations within a single connection, use `DatabasePipeLine()`:

```go
pipeline := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
pipeline.AddQuery("INSERT INTO logs (message) VALUES (?)", "event happened")
pipeline.AddQuery("UPDATE counters SET count = count + 1 WHERE name = ?", "events")
err := pipeline.Exec(ctx)
```

The database pipeline batches multiple SQL statements and executes them efficiently. Internally, `Flush()` uses database pipelines to batch all entity INSERT/UPDATE/DELETE operations.

## Redis Pipeline

For batch Redis operations, use `RedisPipeLine()`:

```go
pipeline := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
pipeline.Set("key1", "value1", 0)
pipeline.Set("key2", "value2", 0)
result, err := pipeline.Exec(ctx)
```

Redis pipelines are also used internally by `Flush()` to batch all Redis cache updates.

## Event Broker

The Context provides access to an event broker for entity lifecycle events:

```go
broker := ctx.GetEventBroker()
```

The event broker allows you to subscribe to entity changes (inserts, updates, deletes) and publish custom events. See the Event Broker documentation for details.

## Accessing the Engine

You can always access the `Engine` from a `Context`:

```go
engine := ctx.Engine()
db := ctx.Engine().DB(fluxaorm.DefaultPoolCode)
redis := ctx.Engine().Redis(fluxaorm.DefaultPoolCode)
```

## Accessing the Underlying context.Context

To retrieve the standard `context.Context`:

```go
stdCtx := ctx.Context()
```

This is useful when you need to pass the context to non-FluxaORM functions that expect a `context.Context`.
