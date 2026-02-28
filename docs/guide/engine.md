# Engine

In previous sections, you learned how to create a `Registry` object and register entities with it. You should also know how to configure database connections by now. In this section, you will learn about the `Engine`, which is the heart of FluxaORM.

## Validating the Registry

To create an Engine, you first need to create a `Registry` object and register the necessary database connections and entities with it. Then, you can call the `registry.Validate()` method to create an `Engine` object.

Here is an example:

```go{16}
package main

import "github.com/latolukasz/fluxaorm/v2"

type UserEntity struct {
    ID   uint64
    Name string `orm:"required"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
}
```


::: tip
It is recommended to create the `Registry` object and call `registry.Validate()` only once in your application, when it starts. For example, if you are running an HTTP server, you should run the above code before the `http.ListenAndServe(":8080", nil)` line.
:::

The `Engine` object should be shared across all goroutines in your application. It serves as a read-only, validated source of FluxaORM settings, including connection credentials and entity structures. You cannot use it to register more entities or connections -- this should be done using a `Registry` object. In other words, the `Registry` is where you configure FluxaORM, while the `Engine` is a read-only source of the resulting configuration.

## Creating a Context

The primary purpose of the `Engine` is to create `Context` instances via the `NewContext()` method. A `Context` is required for all data operations (queries, inserts, updates, deletes).

```go
import "context"

ctx := engine.NewContext(context.Background())
```

`NewContext` takes a standard `context.Context` as its argument. This allows you to propagate deadlines, cancellation, and request-scoped values from your HTTP handler or gRPC interceptor into all FluxaORM operations.

```go
func handleRequest(w http.ResponseWriter, r *http.Request) {
    ctx := engine.NewContext(r.Context())
    // use ctx for all database operations in this request
}
```

See the [Context](context.md) page for full details on the `Context` interface.

## Engine Interface

The `Engine` interface provides the following methods:

```go
type Engine interface {
    // Creates a new Context for data operations
    NewContext(parent context.Context) Context

    // Returns a MySQL connection pool by its registered code
    DB(code string) DB

    // Returns a local in-memory cache pool by its registered code
    LocalCache(code string) LocalCache

    // Returns a Redis connection pool by its registered code
    Redis(code string) RedisCache

    // Returns the engine's registry with metadata about all registered entities and pools
    Registry() EngineRegistry

    // Returns a custom option value previously set via SetOption or registry
    Option(key string) any

    // Returns all registered Redis stream group configurations
    GetRedisStreams() map[string]map[string]string
}
```

## Engine Registry

The `Engine` object provides a `Registry()` method for accessing information about registered data pools:

```go{15,20,25}
package main

import (
    "fmt"
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 0)
    engine, _ := registry.Validate()

    // Returns all MySQL pools
    for code, db := range engine.Registry().DBPools() {
        fmt.Println("MySQL pool:", code)
    }

    // Returns all Redis pools
    for code, redisPool := range engine.Registry().RedisPools() {
        fmt.Println("Redis pool:", code)
    }

    // Returns all local cache pools
    for code, localCache := range engine.Registry().LocalCachePools() {
        fmt.Println("Local cache pool:", code)
    }
}
```

The `EngineRegistry` interface provides:

```go
type EngineRegistry interface {
    // Returns all registered MySQL connection pools
    DBPools() map[string]DB

    // Returns all registered local cache pools
    LocalCachePools() map[string]LocalCache

    // Returns all registered Redis connection pools
    RedisPools() map[string]RedisCache

    // Returns a custom option value
    Option(key string) any
}
```

## Getting a MySQL Pool

To retrieve a MySQL pool by its registered code, use the `DB()` method:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
```

## Getting a Redis Pool

To retrieve a Redis pool by its registered code, use the `Redis()` method:

```go
redisPool := engine.Redis(fluxaorm.DefaultPoolCode)
```

## Getting a Local Cache Pool

To retrieve a local cache pool by its registered code, use the `LocalCache()` method:

```go
localCache := engine.LocalCache(fluxaorm.DefaultPoolCode)
```

## Custom Options

You can store and retrieve arbitrary key-value options on the Engine via the `EngineSetter` interface:

```go
engine.(fluxaorm.EngineSetter).SetOption("app_name", "my-service")
name := engine.Option("app_name") // returns "my-service"
```

Options are useful for passing application-level configuration that needs to be accessible wherever the Engine is available.
