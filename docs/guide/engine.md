---
description: "The FluxaORM Engine: validated result of a Registry that owns pools and schemas, creates Contexts, generates snowflake IDs and registers after-write handlers."
---

# Engine

The `Engine` is the validated, read-only result of a [Registry](/guide/registry.html). It owns the connection pools, the entity schemas and the messaging topology, and it is the factory for the [Context](/guide/context.html) objects every data operation needs.

## Creating the Engine

An `Engine` is obtained from `registry.Validate()` (or `registry.ValidateForCodeGen()` for code generation without network access):

```go{16}
package main

import "github.com/latolukasz/fluxaorm/v2"

type UserEntity struct {
    ID   uint64
    Name string `orm:"required"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    _ = engine
}
```

::: tip
Create the `Registry` and call `Validate()` exactly once, when the application starts - for an HTTP server, before `http.ListenAndServe`. Share the resulting `Engine` across all goroutines.
:::

## Engine Interface

```go
type Engine interface {
    // Creates a Context bound to the given context.Context
    NewContext(parent context.Context) Context

    // Connection pools by code; nil when the code is unknown
    DB(code string) DB
    Clickhouse(code string) Clickhouse
    Nats(code string) Nats
    Redis(code string) RedisCache

    // Metadata about all pools and registry options
    Registry() EngineRegistry

    // Runtime options set with EngineSetter.SetOption
    Option(key string) any

    // Snowflake ID generator
    NextID() uint64
    SetNodeID(node int64)
}

type EngineSetter interface {
    SetOption(key string, value any)
}

const DefaultPoolCode = "default"
```

## Creating a Context

The main purpose of the `Engine` is to create `Context` instances. A `Context` wraps a standard `context.Context`, so deadlines, cancellation and request-scoped values from an HTTP handler or gRPC interceptor flow into every FluxaORM operation:

```go
import "context"

ctx := engine.NewContext(context.Background())

func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := engine.NewContext(r.Context())
    // use ctx for all database operations in this request
}
```

Create one `Context` per request or unit of work. See [Context](/guide/context.html).

## Accessing Pools

Each getter returns the pool registered under the given code, or `nil` when no such pool exists - there is no error return, so guard against `nil` when the code comes from configuration.

```go
db := engine.DB(fluxaorm.DefaultPoolCode)          // MySQL pool
redisPool := engine.Redis(fluxaorm.DefaultPoolCode) // Redis pool
ch := engine.Clickhouse("analytics")                // ClickHouse pool
natsPool := engine.Nats(fluxaorm.DefaultPoolCode)   // NATS pool
```

| Getter | Returns | Notes |
|---|---|---|
| `DB(code)` | `DB` | Non-transactional MySQL handle. Inside a transaction use `ctx.DB(code)` instead (see [Transactions](/guide/transactions.html)). Raw queries: [MySQL Queries](/guide/mysql_queries.html). |
| `Redis(code)` | `RedisCache` | Redis commands, pipelines and locks: [Redis Operations](/guide/redis_operations.html), [Distributed Lock](/guide/distributed_lock.html). |
| `Clickhouse(code)` | `Clickhouse` | [ClickHouse Queries](/guide/clickhouse_queries.html). |
| `Nats(code)` | `Nats` | Connects lazily on first use; call `Ping()` to connect eagerly and `Close()` on shutdown. See [NATS](/guide/nats.html). |

## Engine Registry

`engine.Registry()` returns an `EngineRegistry` with the complete pool maps and the options set on the `Registry`:

```go
type EngineRegistry interface {
    DBPools() map[string]DB
    ClickhousePools() map[string]Clickhouse
    NatsPools() map[string]Nats
    RedisPools() map[string]RedisCache
    Option(key string) any
}
```

```go
for code := range engine.Registry().DBPools() {
    fmt.Println("MySQL pool:", code)
}
for code := range engine.Registry().RedisPools() {
    fmt.Println("Redis pool:", code)
}
for code := range engine.Registry().ClickhousePools() {
    fmt.Println("ClickHouse pool:", code)
}
for code := range engine.Registry().NatsPools() {
    fmt.Println("NATS pool:", code)
}
```

The maps are the engine's live internal maps; treat them as read-only.

## Options

There are two independent key-value stores:

| Set with | Read with | Purpose |
|---|---|---|
| `registry.SetOption(key, value)` before `Validate()` | `engine.Registry().Option(key)` | Static configuration decided at startup |
| `engine.(fluxaorm.EngineSetter).SetOption(key, value)` | `engine.Option(key)` | Values attached at runtime |

```go
registry.SetOption("app_name", "my-service")
engine, _ := registry.Validate()
engine.Registry().Option("app_name") // "my-service"
engine.Option("app_name")            // nil - different store

engine.(fluxaorm.EngineSetter).SetOption("region", "eu-west-1")
engine.Option("region")              // "eu-west-1"
```

`EngineSetter.SetOption` writes to a plain map and is not safe to call concurrently with readers; set runtime options during startup.

## ID Generation

Every new entity receives its primary key from the engine's in-process **snowflake** generator; `NextID()` exposes the same generator for your own use:

```go
id := engine.NextID()
```

An ID is a positive 63-bit value composed of:

| Bits | Content |
|---|---|
| 41 | milliseconds since `2024-01-01T00:00:00Z` |
| 11 | node ID (`0`-`2047`) |
| 11 | per-millisecond sequence (`0`-`2047`) |

`NextID()` never touches the network and never fails. IDs from one process are strictly increasing: if the clock moves backwards the generator keeps issuing from the last timestamp, and when the sequence for a millisecond is exhausted it rolls forward to the next one.

Uniqueness **across processes** relies on each running process having its own node ID. The engine starts with node `0`; assign a distinct node per process right after `Validate()`:

```go
engine.SetNodeID(nodeID) // e.g. from an environment variable, the pod ordinal, or a lease
```

`SetNodeID` masks the value to 11 bits (`node & 2047`) instead of failing, so two processes whose IDs differ by 2048 would collide - keep node IDs in `0`-`2047`.

::: danger
Two processes with the same node ID can generate the same primary key within the same millisecond. Always give every replica of your application a unique node ID.
:::

## Lifecycle Handlers

Generated provider code registers after-write hooks on the engine through three package-level functions:

```go
func RegisterAfterInsertHandler(engine Engine, cacheIndex string, handler func(Context, Entity) error)
func RegisterAfterUpdateHandler(engine Engine, cacheIndex string, handler func(Context, Entity, map[string]any) error)
func RegisterAfterDeleteHandler(engine Engine, cacheIndex string, handler func(Context, Entity) error)
```

One handler is stored per `cacheIndex` (the entity's package-qualified type name); a later registration replaces the earlier one. Prefer the typed `OnAfterInsert`/`OnAfterUpdate`/`OnAfterDelete` methods of the generated providers, which call these functions for you - see [Lifecycle Callbacks](/guide/lifecycle_callbacks.html).

## Immutability

After `Validate()` the set of pools, entities, streams, consumers and tasks is fixed: there is no way to register more on an `Engine`, and no `Close()` - pools live as long as the process (close NATS connections explicitly with `engine.Nats(code).Close()` if needed). The only mutable state on an `Engine` is:

- the node ID (`SetNodeID`),
- runtime options (`EngineSetter.SetOption`),
- lifecycle handlers (`RegisterAfter*Handler`),
- mock database clients used in tests (`SetMockDBClient`, see [Testing](/guide/testing.html)).

All of these are meant to be set during startup, before the engine is shared between goroutines.
