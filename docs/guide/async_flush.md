# Async Flush

In the [previous chapter](/guide/crud.html), you learned how to add, update, and delete entities using the `Flush()` method.
`Flush()` executes both MySQL and cache (Redis, local cache) queries synchronously. Redis operations usually take a few milliseconds, and local cache changes are almost instantaneous. However, SQL queries can take a significant amount of time, typically more than 100 milliseconds. In high-traffic applications, SQL queries often become a performance bottleneck.

To address this issue, FluxaORM provides a powerful feature that allows you to run all SQL queries asynchronously. Instead of executing SQL directly against MySQL, `FlushAsync()` publishes the SQL operations to a Redis Stream. Cache updates (Redis and local cache) and Redis Search index updates are applied immediately (optimistic update), so reads see consistent data right away. A separate consumer process then picks up the queued SQL operations and executes them against MySQL.

## Registering the Async SQL Stream

Before using `FlushAsync()`, you must register the async SQL stream with a Redis pool. Use `RegisterAsyncSQLStream()` during registry setup:

```go
package main

import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterAsyncSQLStream(fluxaorm.DefaultPoolCode) // register the async stream on the default Redis pool
    registry.RegisterEntity(UserEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    // ...
}
```

::: tip
If you have a default Redis pool registered and do not call `RegisterAsyncSQLStream()` explicitly, FluxaORM automatically registers the async SQL streams on the default pool during `Validate()`. However, it is recommended to register it explicitly for clarity.
:::

## Using FlushAsync

Once the stream is registered, use `FlushAsync()` instead of `Flush()` on the context:

```go
ctx := engine.NewContext(context.Background())

user := UserProvider.New(ctx)
user.SetName("Alice")
user.SetEmail("alice@example.com")

err := ctx.FlushAsync()
if err != nil {
    // handle error
}
```

When `FlushAsync()` is called, the following happens:

1. **Redis cache and search indexes are updated immediately** -- entity data is written to Redis cache and Redis Search hashes right away.
2. **SQL queries are serialized and published** to the `_fluxa_async_sql` Redis Stream instead of being executed against MySQL.
3. The entity is marked as flushed and tracking is cleared.

This means that reads using cached lookups (e.g., `GetByID`, `GetByIDs`, `GetByUniqueIndex`) will return updated data immediately, while SQL-based searches will not return updated data until the consumer processes the queued operations.

## Consuming Async Queries

You must run a consumer to process the queued SQL operations. The consumer reads events from the Redis Stream and executes them against MySQL.

Use `ctx.GetAsyncSQLConsumer()` to obtain a consumer:

```go
ctx := engine.NewContext(context.Background())

consumer, err := ctx.GetAsyncSQLConsumer()
if err != nil {
    panic(err)
}

// Process up to 100 events, blocking for up to 1 second waiting for new events
for {
    err = consumer.Consume(100, time.Second)
    if err != nil {
        log.Printf("transient error consuming async SQL: %v", err)
        time.Sleep(time.Second) // back off and retry
    }
}
```

The `Consume(count int, blockTime time.Duration)` method:
- Reads up to `count` events from the stream.
- Blocks for up to `blockTime` waiting for new events if none are available.
- Executes each SQL operation against the appropriate MySQL pool.
- Acknowledges successfully processed events.

### AutoClaim for Stale Events

If a consumer crashes and leaves events in a pending state, you can use `AutoClaim()` to reclaim and process them:

```go
// Reclaim events that have been pending for more than 30 seconds
err = consumer.AutoClaim(100, 30*time.Second)
```

This is useful for recovering from consumer failures without losing queued operations.

## Understanding Cache Updates

When `FlushAsync()` is called, cache updates happen immediately but SQL execution is deferred. This affects which read operations return updated data before the consumer processes the SQL:

**Returns updated data immediately:**
- `GetByID()` -- when the entity uses `redisCache` or `localCache`
- `GetByIDs()` -- when the entity uses cache
- `GetByUniqueIndex()` -- unique indexes are always cached in Redis

**Does NOT return updated data until consumed:**
- `Search()`, `SearchOne()`, `SearchIDs()`, `SearchWithCount()`, `SearchIDsWithCount()` -- these query MySQL directly, so they will not see the new data until the consumer has executed the SQL.

::: warning
Entities without any cache (`redisCache` or `localCache`) will not be available via `GetByID()` or `GetByIDs()` until the consumer processes the SQL operations.
:::

## Handling Errors

The consumer classifies MySQL errors into two categories:

### Transient Errors

Transient errors are temporary problems that may succeed on retry. When a transient error occurs, `Consume()` returns the error and the event remains in the stream's pending list for reprocessing.

Examples of transient errors:
- Connection refused or timeout
- Error 1040: Too many connections
- Error 1213: Deadlock found when trying to get lock
- Error 1031: Disk full

When you encounter a transient error, you should log it, wait briefly, and retry:

```go
err = consumer.Consume(100, time.Second)
if err != nil {
    log.Printf("transient error: %v", err)
    time.Sleep(time.Second)
    // retry on next loop iteration
}
```

### Permanent Errors (Dead-Letter Stream)

Permanent errors are problems that will not succeed on retry no matter how many times the query is re-executed. When a permanent error occurs, the event is moved to the dead-letter stream (`_fluxa_async_sql_failed`) and acknowledged from the main stream so it does not block processing.

Examples of permanent errors:
- Error 1062: Duplicate entry (duplicate key)
- Error 1146: Table doesn't exist
- Error 1054: Unknown column
- Error 1064: Syntax error
- Error 1406: Data too long for column
- Error 1048: Column cannot be null
- Error 1452: Foreign key constraint fails

The dead-letter stream retains the failed SQL operations along with their error messages. You should monitor this stream and manually resolve the issues:

```go
// The dead-letter stream name is available as a constant:
// fluxaorm.AsyncSQLDeadLetterStreamName = "_fluxa_async_sql_failed"
```

## Multi-Query Transactions

When a single `FlushAsync()` call produces multiple SQL queries for the same database pool (e.g., inserting an entity and updating related records), those queries are grouped into a single `AsyncSQLOperation`. The consumer executes multiple queries within a database transaction to ensure atomicity. Single-query operations are executed without a transaction for better performance.
