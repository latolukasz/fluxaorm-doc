# Introduction

FluxaORM is a **code-generation-first** ORM for Go, purpose-built for [MySQL](https://www.mysql.com/) and [Redis](https://redis.io/). Instead of relying on runtime reflection to map structs to database rows, FluxaORM generates fully typed Go code from your entity definitions — giving you compile-time safety, zero-reflection data access, and built-in dirty tracking.

## How It Works

The FluxaORM workflow has four steps:

1. **Define** entity structs with `orm:` struct tags
2. **Register** entities and connection pools in a `Registry`
3. **Validate** the registry to produce an `Engine`, then call `Generate()` to emit typed Go code
4. **Use** the generated `Provider` and `Entity` types in your application

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

// Step 1: Define your entity struct
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Email string `orm:"unique=Email;required"`
    Age   uint8
}

func main() {
    // Step 2: Register entities and pools
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("root:root@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 100000)
    registry.RegisterEntity(&UserEntity{})

    // Step 3: Validate and generate
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    err = fluxaorm.Generate(engine, "./entities")
    if err != nil {
        panic(err)
    }
}
```

After running this program, the `./entities` directory will contain generated code including a `UserEntityProvider` and a `UserEntity` type with typed getters and setters.

### Using Generated Code

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
    "myapp/entities"
)

func main() {
    // ... registry setup and validation as above ...
    ctx := engine.NewContext(context.Background())

    // Create a new entity
    user := entities.UserEntityProvider.New(ctx)
    user.SetName("Alice")
    user.SetEmail("alice@example.com")
    user.SetAge(30)
    err := ctx.Flush()
    if err != nil {
        panic(err)
    }

    // Fetch by ID
    user, found, err := entities.UserEntityProvider.GetByID(ctx, 1)
    if err != nil {
        panic(err)
    }
    if found {
        fmt.Println(user.GetName())  // "Alice"
        fmt.Println(user.GetAge())   // 30
    }

    // Search with WHERE clause
    users, err := entities.UserEntityProvider.Search(
        ctx,
        fluxaorm.NewWhere("`Age` >= ?", 18),
        nil,
    )
    if err != nil {
        panic(err)
    }
    for _, u := range users {
        fmt.Println(u.GetName(), u.GetEmail())
    }
}
```

## Designed for MySQL

Unlike generic ORM libraries that abstract away database differences behind a lowest-common-denominator interface, FluxaORM is specifically tailored for MySQL. This allows it to take full advantage of MySQL-specific features, optimizations, and DDL semantics — including automatic schema migrations, proper ENUM/SET types, and efficient connection pool management based on your server's `max_connections` and `wait_timeout` settings.

## Three-Tier Caching

FluxaORM provides a transparent, three-tier caching system for entity reads:

1. **Context cache** — a per-request in-memory cache with a configurable TTL (default: 1 second). Populated automatically by `GetByID` and `GetByIDs`. Zero configuration required.
2. **Local cache** — a per-process LRU cache stored in application memory. Configured per pool with a maximum key count.
3. **Redis cache** — entities are serialized into Redis Lists, enabling fast lookups that bypass MySQL entirely. Enabled per entity with the `orm:"redisCache"` struct tag.

When an entity is requested, FluxaORM checks each tier in order and only falls through to MySQL when no cached copy is available. Cache invalidation is handled automatically when entities are modified and flushed.

## Redis Search

Entities can opt in to [Redis Search](https://redis.io/docs/stack/search/) indexing via struct tags. The ORM automatically maintains Redis hash documents and FT.SEARCH indexes, enabling full-text and numeric queries that run entirely in Redis.

## Dirty Tracking and Flush

Generated entity setters compare new values against the original database values and only mark changed fields as dirty. When you call `ctx.Flush()`, FluxaORM batches all pending INSERT, UPDATE, and DELETE operations into efficient SQL statements and updates Redis caches in a single pass.

For non-critical writes, `ctx.FlushAsync(true)` publishes SQL operations to a Redis Stream for asynchronous processing while updating cache immediately, and `ctx.FlushAsync(false)` defers both SQL and cache updates to the consumer.

## Built-in Redis Client

FluxaORM includes its own Redis client with support for all standard commands plus additional features like distributed locks and rate limiters. No external Redis client library is needed.

## What's Next

Continue to the [Registry](/guide/registry.html) page to learn how to configure connection pools and register entities, or jump to [Data Pools](/guide/data_pools.html) for details on MySQL, Redis, and local cache pool options.
