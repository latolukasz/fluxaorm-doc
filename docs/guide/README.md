---
description: "Introduction and quick start for FluxaORM v2, a code-generation-based Go ORM for MySQL and Redis with ClickHouse queries and NATS JetStream events, consumers and tasks."
---

# Introduction

FluxaORM is a **code-generation-first** ORM for Go, purpose-built for [MySQL](https://www.mysql.com/) and [Redis](https://redis.io/) 8.2+, with query-only [ClickHouse](https://clickhouse.com/) support for analytics and [NATS JetStream](https://nats.io/) for entity change events, consumers and background tasks. Instead of relying on runtime reflection to map structs to database rows, FluxaORM generates fully typed Go code from your entity definitions — giving you compile-time safety, zero-reflection data access, and built-in dirty tracking.

## How It Works

The FluxaORM workflow has four steps:

1. **Define** entity structs with `orm:` struct tags
2. **Register** entities and connection pools in a `Registry`
3. **Validate** the registry to produce an `Engine`, then call `Generate()` to emit typed Go code
4. **Use** the generated `Provider` and `Entity` types in your application

### Step 1: Define an entity

```go
package model

type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Email string `orm:"required"`
    Age   uint8
}

func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{{"Email"}}
}
```

### Steps 2 and 3: Register and generate

Code generation is a separate command you run whenever entities change. `ValidateForCodeGen()` builds the `Engine` without opening any network connection, so the generator does not need a running database. The output directory must already exist; its base name becomes the generated package name.

```go
package main

import (
    "github.com/latolukasz/fluxaorm/v2"

    "myapp/model"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("root:root@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(model.UserEntity{})

    engine, err := registry.ValidateForCodeGen()
    if err != nil {
        panic(err)
    }
    if err = fluxaorm.Generate(engine, "./entities"); err != nil {
        panic(err)
    }
}
```

After running this program, the `./entities` directory contains `UserEntity.go` with an `entities.UserEntity` type, the `entities.UserEntityProvider` singleton, typed field descriptors under `UserEntityProvider.Fields`, and `providers.go` listing every provider in `entities.AllProviders`.

::: warning
Pass `&fluxaorm.MySQLOptions{}` rather than `nil` to `RegisterMySQL`. `Validate()` reads the options struct and panics on a nil pointer.
:::

### Step 4: Use the generated code

At runtime the same registry is validated with `Validate()`, which connects to MySQL and Redis (and enforces Redis 8.2 or newer). `GetAlters()` diffs the registered entities against the live schema and returns the DDL needed to bring the tables up to date.

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
    "myapp/model"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("root:root@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(model.UserEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    ctx := engine.NewContext(context.Background())

    // Create or update tables
    alters, err := fluxaorm.GetAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        if err = alter.Exec(ctx); err != nil {
            panic(err)
        }
    }

    // Create a new entity; the ID is assigned locally (snowflake)
    user := entities.UserEntityProvider.New(ctx)
    user.SetName("Alice").SetEmail("alice@example.com").SetAge(30)
    if err = ctx.Save(user); err != nil {
        panic(err)
    }

    // Fetch by ID (context cache -> Redis row cache -> MySQL)
    loaded, found, err := entities.UserEntityProvider.GetByID(ctx, user.GetID())
    if err != nil {
        panic(err)
    }
    if found {
        fmt.Println(loaded.GetName(), loaded.GetAge()) // Alice 30
    }

    // Look up by unique index
    byEmail, found, err := entities.UserEntityProvider.SearchOne(ctx,
        fluxaorm.NewQuery().Filter(entities.UserEntityProvider.Fields.Email.Is("alice@example.com")),
    )
    if err != nil {
        panic(err)
    }
    fmt.Println(found, byEmail.GetID())

    // Search with the type-safe query builder
    adults, err := entities.UserEntityProvider.SearchMany(ctx,
        fluxaorm.NewQuery().
            Filter(entities.UserEntityProvider.Fields.Age.Gte(18)).
            SortByASC(entities.UserEntityProvider.Fields.Name),
    )
    if err != nil {
        panic(err)
    }
    for _, u := range adults {
        fmt.Println(u.GetName(), u.GetEmail())
    }
}
```

## Architecture

### Designed for MySQL

FluxaORM is tailored for MySQL rather than abstracting over many databases. It uses MySQL DDL and types directly (including `ENUM` and `SET`), sizes its connection pool from the server's `max_connections` and `wait_timeout`, and manages schema changes itself: `GetAlters()` returns one `Alter` per unit of work, each classified as `AlterSafe` (forward-compatible with the previous code version) or `AlterDestructive`, so `SplitAlters()` can apply the safe half during a rolling deploy and hold the rest. See [Schema Update](/guide/schema_update.html).

### Writes and transactions

Generated setters compare the new value against the loaded one and record only real changes. `ctx.Save(entities...)` writes exactly the entities you pass; saving more than one wraps them in a transaction. `ctx.Transaction(func(tx fluxaorm.Context) error)` opens `BEGIN` lazily per pool on the first write, joins an outer transaction when nested, and queues cache invalidation, Redis Search updates, entity events and `OnAfter*` handlers to run after `COMMIT`. See [CRUD](/guide/crud.html) and [Transactions](/guide/transactions.html).

### Two-tier caching

1. **Context cache** — a per-`Context` identity map: one row is one `*Entity` for the life of the context. Populated by `GetByID`, `GetByIDs` and `New`; refresh a handle with `ctx.Reload(entity)`. See [Context Cache](/guide/context_cache.html).
2. **Redis row cache** — enabled per entity with `orm:"redisCache"`. Rows are stored as Redis lists and unique-index lookups are cached as ID pointers. Writes invalidate the keys before the SQL statement and again after commit; nothing is ever written back. See [Redis Cache](/guide/redis_cache.html).

### Redis Search

Entities can opt in to [Redis Search](https://redis.io/docs/latest/develop/interact/search-and-query/) via struct tags. FluxaORM maintains the hash documents and `FT.SEARCH` index on every `Save`, and the provider gains `SearchManyInRedis` and friends. See [Redis Search](/guide/redis_search.html).

### ClickHouse

Register a ClickHouse pool for analytics and reporting queries alongside MySQL, and optionally describe tables with `NewClickhouseTable` so `GetClickhouseAlters()` reconciles their schema. There is no entity mapping for ClickHouse. See [ClickHouse Queries](/guide/clickhouse_queries.html) and [ClickHouse Schema](/guide/clickhouse_schema.html).

### NATS JetStream: entity events, consumers, tasks and outbox

- **Entity change events** — tag an entity `orm:"cdc"` and every committed insert, update or delete is published once as a `DirtyEvent` on `fluxa.entity.<table>` in the `FLUXA_ENTITY` stream. See [Entity Events](/guide/entity_events.html).
- **Consumers** — declare a `ConsumerDef` naming the entities (or task queues) it reads; the generator emits a typed consumer with one `On<Entity>` handler per entity and `Validate()` rejects topologies that would fail silently. See [Consumers](/guide/consumers.html).
- **Tasks** — register a plain struct with `RegisterTask`, dispatch it with the generated `Dispatch<Task>`, and let a consumer run it with a retry ladder; every dispatch is recorded in `JobRunEntity`. See [Tasks](/guide/tasks.html).
- **Transactional outbox** — tag an entity `orm:"outbox"` so the event row is written in the same MySQL transaction as the change, and relay anything left pending. See [Outbox](/guide/outbox.html).

NATS pool registration, raw publish/fetch and `GetNatsAlters()` are covered in [NATS](/guide/nats.html).

### IDs and observability

Entity IDs are snowflake values generated in-process by `engine.NextID()`; call `engine.SetNodeID` so every process uses a distinct node. Enable Prometheus metrics with `registry.EnableMetrics(promauto.Factory)` — see [Metrics](/guide/metrics.html) — and inspect every MySQL, Redis, ClickHouse and NATS operation with query loggers, see [Queries Log](/guide/queries_log.html).

::: warning Requirements
FluxaORM requires **Redis 8.2** or later. `Validate()` returns an error if any registered Redis pool runs an older version.
:::

## What's Next

- [Registry](/guide/registry.html) — register pools, entities, consumers and tasks
- [Data Pools](/guide/data_pools.html) — MySQL, Redis, ClickHouse and NATS pool options
- [Entities](/guide/entities.html) and [Entity Fields](/guide/entity_fields.html) — struct tags and supported types
- [Code Generation](/guide/code_generation.html) — what `Generate()` emits and how to wire it into your build
- [Testing](/guide/testing.html) — `PrepareTables` helpers for integration tests
