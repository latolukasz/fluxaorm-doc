# Registry

The `Registry` is the starting point for configuring FluxaORM. It lets you register entity structs, connection pools (MySQL, Redis, local cache), and streams before validating everything into an immutable `Engine`.

## Creating a Registry

```go
package main

import "github.com/latolukasz/fluxaorm/v2"

func main() {
    registry := fluxaorm.NewRegistry()

    // Register connection pools
    registry.RegisterMySQL("root:root@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 100000)

    // Register entities
    registry.RegisterEntity(&UserEntity{}, &ProductEntity{}, &CategoryEntity{})

    // Validate and get the Engine
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
}
```

## Registering Entities

Use `RegisterEntity()` to register one or more entity struct pointers. Each entity must have an `ID` field with an unsigned integer type.

```go
registry.RegisterEntity(&UserEntity{})
registry.RegisterEntity(&ProductEntity{}, &OrderEntity{})
```

Entity structs use `orm:` struct tags to configure caching, indexes, enums, and more:

```go
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Email string `orm:"unique=Email;required"`
    Age   uint8
}

type ProductEntity struct {
    ID       uint64 `orm:"redisCache"`
    Name     string `orm:"required"`
    Price    float64
    Category fluxaorm.Reference[CategoryEntity] `orm:"required"`
    Status   string `orm:"enum=draft,active,archived;required"`
}

type CategoryEntity struct {
    ID   uint16
    Name string `orm:"required;unique=Name"`
}

type OrderEntity struct {
    ID        uint64 `orm:"redisCache"`
    User      fluxaorm.Reference[UserEntity] `orm:"required"`
    Product   fluxaorm.Reference[ProductEntity] `orm:"required"`
    Quantity  uint32 `orm:"required"`
    CreatedAt time.Time
}
```

## Registering Connection Pools

### MySQL

```go
registry.RegisterMySQL("user:password@tcp(localhost:3306)/mydb", fluxaorm.DefaultPoolCode, nil)
registry.RegisterMySQL("user:password@tcp(localhost:3306)/logs", "logs", &fluxaorm.MySQLOptions{
    MaxOpenConnections: 50,
})
```

See [Data Pools](/guide/data_pools.html) for all `MySQLOptions` fields.

### Redis

```go
// Standard connection
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

// With authentication
registry.RegisterRedis("localhost:6379", 1, "sessions", &fluxaorm.RedisOptions{
    User:     "user",
    Password: "secret",
})

// Sentinel connection
registry.RegisterRedis("", 0, "cluster", &fluxaorm.RedisOptions{
    Master:    "mymaster",
    Sentinels: []string{":26379", "192.168.1.2:26379", "192.168.1.3:26379"},
})
```

See [Data Pools](/guide/data_pools.html) for all `RedisOptions` fields.

### Local Cache

```go
// LRU cache with max 100,000 entries
registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 100000)

// Unlimited cache (no eviction)
registry.RegisterLocalCache("static_data", 0)
```

## Registering Streams

### Redis Streams

Register a named Redis Stream backed by a specific Redis pool:

```go
registry.RegisterRedisStream("order-events", fluxaorm.DefaultPoolCode)
registry.RegisterRedisStream("notifications", "events")
```

Each stream is assigned a consumer group automatically. Streams are used for event-driven workflows such as entity change notifications and asynchronous processing.

### Async SQL Stream

Register the built-in async SQL stream for non-critical writes. This enables `ctx.FlushAsync(true)` and `ctx.FlushAsync(false)` to publish SQL operations to a Redis Stream instead of executing them immediately:

```go
registry.RegisterAsyncSQLStream(fluxaorm.DefaultPoolCode)
```

This call registers two internal streams on the specified Redis pool: the main async SQL stream and a dead-letter stream for failed operations.

::: tip
If you have a Redis pool registered with the code `"default"` and do not explicitly call `RegisterAsyncSQLStream()`, FluxaORM will automatically register the async SQL streams on the default pool during `Validate()`.
:::

## Validating the Registry

Once all pools, entities, and streams are registered, call `Validate()` to produce an `Engine`:

```go
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
```

`Validate()` performs the following:

- Connects to all MySQL pools and configures connection limits based on server settings
- Connects to all Redis pools
- Parses entity struct tags and builds schema metadata
- Resolves entity references and indexes
- Returns an immutable `Engine` ready for creating contexts and generating code

The `Engine` is the runtime entry point. Use it to create per-request contexts:

```go
ctx := engine.NewContext(context.Background())
```

## Code Generation

After validation, call `Generate()` to emit typed Go code for all registered entities:

```go
err = fluxaorm.Generate(engine, "./entities")
if err != nil {
    panic(err)
}
```

This produces one `.go` file per entity in the output directory, containing:

- A typed `XxxProvider` singleton with methods like `GetByID`, `GetByIDs`, `New`, `Search`, `SearchOne`, and more
- A typed `XxxEntity` struct with `GetXxx()` / `SetXxx()` methods for each field, with built-in dirty tracking
- An `XxxSQLRow` struct for efficient, reflection-free database scanning

You typically run code generation once during development (or in a `go generate` step), then import the generated package in your application.

## Configuration via Config Struct

Instead of calling individual `Register*` methods, you can configure everything through a `Config` struct:

```go
registry := fluxaorm.NewRegistry()

config := &fluxaorm.Config{
    MySQlPools: []fluxaorm.ConfigMysql{
        {Code: "default", URI: "root:root@tcp(localhost:3306)/app"},
        {Code: "logs", URI: "root:root@tcp(localhost:3306)/logs", MaxOpenConnections: 50},
    },
    RedisPools: []fluxaorm.ConfigRedis{
        {Code: "default", URI: "localhost:6379", Database: 0, Streams: []string{"order-events"}},
        {Code: "sessions", URI: "localhost:6379", Database: 1},
    },
    RedisSentinelPools: []fluxaorm.ConfigRedisSentinel{
        {
            Code:       "cluster",
            MasterName: "mymaster",
            Database:   0,
            Sentinels:  []string{":26379", "192.168.1.2:26379"},
        },
    },
    LocalCachePools: []fluxaorm.ConfigLocalCache{
        {Code: "default", Limit: 100000},
    },
}

err := registry.InitByConfig(config)
if err != nil {
    panic(err)
}
```

### Config Struct Reference

```go
type Config struct {
    MySQlPools         []ConfigMysql
    RedisPools         []ConfigRedis
    RedisSentinelPools []ConfigRedisSentinel
    LocalCachePools    []ConfigLocalCache
}

type ConfigMysql struct {
    Code               string   // required — pool name
    URI                string   // required — MySQL DSN
    ConnMaxLifetime    int      // seconds
    MaxOpenConnections int
    MaxIdleConnections int
    DefaultEncoding    string
    DefaultCollate     string
    IgnoredTables      []string
}

type ConfigRedis struct {
    Code     string   // required — pool name
    URI      string   // required — host:port or /path/to/socket.sock
    Database int      // Redis database number (0-15)
    User     string
    Password string
    Streams  []string // stream names to register on this pool
}

type ConfigRedisSentinel struct {
    Code       string   // required — pool name
    MasterName string   // required — Sentinel master name
    Database   int
    Sentinels  []string // list of sentinel addresses
    User       string
    Password   string
    Streams    []string
}

type ConfigLocalCache struct {
    Code  string // required — pool name
    Limit int    // required — max number of cached entries (0 = unlimited)
}
```

## Configuration via YAML

You can also load configuration from a parsed YAML map:

```go
package main

import (
    "os"

    "github.com/latolukasz/fluxaorm/v2"
    "gopkg.in/yaml.v2"
)

func main() {
    data, err := os.ReadFile("./config.yaml")
    if err != nil {
        panic(err)
    }
    var parsedYaml map[string]interface{}
    err = yaml.Unmarshal(data, &parsedYaml)
    if err != nil {
        panic(err)
    }

    registry := fluxaorm.NewRegistry()
    err = registry.InitByYaml(parsedYaml)
    if err != nil {
        panic(err)
    }
}
```

### YAML Format

```yml
default:
  mysql:
    uri: root:root@tcp(localhost:3306)/app
  redis: localhost:6379:0
  local_cache: 100000
  streams:
    - order-events
    - notifications
logs:
  mysql:
    uri: root:root@tcp(localhost:3306)/logs
    maxOpenConnections: 50
sessions:
  redis: localhost:6379:1?user=myuser&password=secret
cluster:
  sentinel:
    mymaster:0:
      - :26379
      - 192.168.1.2:26379
      - 192.168.1.3:26379
```

Each top-level key is a pool name. Within each pool, you can define:

- `mysql` — MySQL connection with a `uri` and optional settings (`maxOpenConnections`, `maxIdleConnections`, `connMaxLifetime`, `defaultEncoding`, `defaultCollate`, `ignoredTables`)
- `redis` — Redis connection in the format `host:port:db` with optional query parameters for credentials (`?user=x&password=y`)
- `sentinel` — Redis Sentinel connection with master name, optional database number, and a list of sentinel addresses
- `local_cache` — maximum number of cached entries (integer)
- `streams` — list of Redis Stream names to register on the pool

## Setting Options

You can attach arbitrary key-value options to the registry, which are carried over to the `Engine`:

```go
registry.SetOption("app_name", "my-service")

// Later, retrieve from engine:
engine.Option("app_name") // returns "my-service"
```
