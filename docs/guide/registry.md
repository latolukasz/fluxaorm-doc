---
description: "How to configure FluxaORM with the Registry: register MySQL, Redis, ClickHouse and NATS pools, entities, streams, consumers and tasks, load YAML config and call Validate()."
---

# Registry

The `Registry` is where FluxaORM is configured. You register connection pools (MySQL, Redis, ClickHouse, NATS), entity structs, messaging topology (streams, consumers, tasks), options and metrics, then call `Validate()` once to turn all of it into an immutable [Engine](/guide/engine.html).

## Creating a Registry

```go
package main

import (
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()

    // Connection pools
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, nil)

    // Entities
    registry.RegisterEntity(UserEntity{}, ProductEntity{})

    // Validate and get the Engine
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    _ = engine
}
```

`fluxaorm.DefaultPoolCode` is the string `"default"`. Every pool is identified by its code; entities use the `default` pools unless their tags say otherwise.

::: warning
`RegisterMySQL` stores the options pointer exactly as passed. Passing `nil` panics inside `Validate()` when the pool limits are read. Always pass at least `&fluxaorm.MySQLOptions{}`. `RegisterRedis`, `RegisterClickhouse` and `RegisterNats` accept `nil`.
:::

## Registry Interface

```go
type Registry interface {
    Validate() (Engine, error)
    ValidateForCodeGen() (Engine, error)
    RegisterEntity(entity ...any)
    RegisterMySQL(dataSourceName string, poolCode string, poolOptions *MySQLOptions)
    RegisterRedis(address string, db int, poolCode string, options *RedisOptions)
    InitByYaml(yaml any) error
    InitByConfig(config *Config) error
    SetOption(key string, value any)
    RegisterClickhouse(dataSourceName string, poolCode string, poolOptions *ClickhouseOptions)
    RegisterClickhouseTable(table *ClickhouseTableBuilder)
    RegisterNats(urls []string, poolCode string, options *NatsPoolOptions)
    RegisterNatsStream(stream *NatsStreamBuilder)
    RegisterNatsConsumer(consumer *NatsConsumerBuilder)
    RegisterConsumer(def ConsumerDef)
    RegisterEntityStream(opts EntityStreamOptions)
    RegisterTask(task any, opts TaskOptions)
    RegisterTaskStream(opts TaskStreamOptions)
    EnableMetrics(factory promauto.Factory)
}
```

## Registering Entities

`RegisterEntity()` accepts one or more entity structs, as values or pointers. Entities are keyed by their package-qualified type name, so registering the same type twice is harmless.

```go
registry.RegisterEntity(UserEntity{})
registry.RegisterEntity(&ProductEntity{}, &OrderEntity{})
```

Two entities ship with FluxaORM and must be registered explicitly when the feature that needs them is used:

- `fluxaorm.JobRunEntity{}` - required as soon as any task is registered (see [Tasks](/guide/tasks.html))
- `fluxaorm.CDCOutboxEntity{}` - required as soon as any entity is tagged `orm:"outbox"` (see [Outbox](/guide/outbox.html))

How entity structs are defined and which `orm:` tags exist is covered in [Entities](/guide/entities.html) and [Entity Fields](/guide/entity_fields.html).

## Registering Connection Pools

All pool options, DSN formats and defaults are described in [Data Pools](/guide/data_pools.html). This section only shows the registration calls.

### MySQL

```go
registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
registry.RegisterMySQL("user:password@tcp(localhost:3306)/logs", "logs", &fluxaorm.MySQLOptions{
    MaxOpenConnections: 50,
})
```

### Redis

```go
// Standard connection
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

// With ACL credentials
registry.RegisterRedis("localhost:6379", 1, "sessions", &fluxaorm.RedisOptions{
    User:     "app",
    Password: "secret",
})

// Unix socket (detected by the ".sock" suffix)
registry.RegisterRedis("/var/run/redis.sock", 0, "local", nil)

// Sentinel: the address is ignored, the sentinels are used instead
registry.RegisterRedis("", 0, "cluster", &fluxaorm.RedisOptions{
    Master:    "mymaster",
    Sentinels: []string{":26379", "192.168.1.2:26379", "192.168.1.3:26379"},
})
```

### ClickHouse

```go
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", nil)
registry.RegisterClickhouse("clickhouse://localhost:9000/logs", "ch_logs", &fluxaorm.ClickhouseOptions{
    MaxOpenConnections: 20,
})
```

ClickHouse table definitions are registered with `RegisterClickhouseTable()`:

```go
registry.RegisterClickhouseTable(
    fluxaorm.NewClickhouseTable("events", "analytics").
        Column("id", "UInt64").
        Column("created_at", "DateTime").
        Engine("MergeTree").
        OrderBy("id"),
)
```

See [ClickHouse Schema](/guide/clickhouse_schema.html) for the full builder API.

### NATS

```go
registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, &fluxaorm.NatsPoolOptions{
    ClientID: "my-service",
})
```

Custom JetStream streams and durable consumers are registered with builders:

```go
registry.RegisterNatsStream(
    fluxaorm.NewNatsStream("ORDERS_RAW", fluxaorm.DefaultPoolCode).Subjects("orders.>"),
)
registry.RegisterNatsConsumer(
    fluxaorm.NewNatsConsumer("orders-audit", fluxaorm.DefaultPoolCode).FilterSubjects("orders.>"),
)
```

See [NATS](/guide/nats.html) for the stream and consumer builders.

## Registering Consumers and Tasks

Entity change events and background tasks are declared on the registry, not on the entities themselves:

```go
// A consumer that receives change events of entities tagged `orm:"cdc"`
registry.RegisterConsumer(fluxaorm.ConsumerDef{
    Name:     "search-indexer",
    Entities: []any{ProductEntity{}},
})

// A task struct and the consumer that drains its queue
registry.RegisterEntity(fluxaorm.JobRunEntity{})
registry.RegisterTask(SendWelcomeEmail{}, fluxaorm.TaskOptions{})
registry.RegisterConsumer(fluxaorm.ConsumerDef{
    Name:   "emails-worker",
    Queues: []fluxaorm.Queue{"emails"},
})

// Optional tuning of the two internal streams (last call wins)
registry.RegisterEntityStream(fluxaorm.EntityStreamOptions{Replicas: 3})
registry.RegisterTaskStream(fluxaorm.TaskStreamOptions{Replicas: 3})
```

| Method | Purpose | Details |
|---|---|---|
| `RegisterConsumer(def ConsumerDef)` | Declares a durable JetStream consumer for entity events **or** task queues | [Consumers](/guide/consumers.html) |
| `RegisterEntityStream(opts EntityStreamOptions)` | Tunes the `FLUXA_ENTITY` stream that carries entity events | [Entity Events](/guide/entity_events.html) |
| `RegisterTask(task any, opts TaskOptions)` | Declares a task struct that can be dispatched | [Tasks](/guide/tasks.html) |
| `RegisterTaskStream(opts TaskStreamOptions)` | Tunes the `FLUXA_TASK` stream that carries dispatched tasks | [Tasks](/guide/tasks.html) |

## Options

`SetOption()` attaches arbitrary key-value pairs to the registry. After validation they are available through `engine.Registry().Option()`:

```go
registry.SetOption("app_name", "my-service")

engine, _ := registry.Validate()
name := engine.Registry().Option("app_name") // "my-service"
```

::: warning
`engine.Option(key)` is a separate store that only returns values set at runtime with `engine.(fluxaorm.EngineSetter).SetOption()`. It does **not** return options set on the registry. See [Engine](/guide/engine.html#options).
:::

## Metrics

Call `EnableMetrics()` with a Prometheus `promauto.Factory` **before** `Validate()`. The metric collectors are created during validation:

```go
import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
)

registry.EnableMetrics(promauto.With(prometheus.DefaultRegisterer))
```

See [Metrics](/guide/metrics.html) for the list of exported metrics.

## Validating the Registry

`Validate()` is the only way to obtain an `Engine`. Call it once, at application start:

```go
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

### What `Validate()` connects to

| Pool | Behaviour during `Validate()` |
|---|---|
| MySQL | Opens the pool and runs `SHOW VARIABLES LIKE 'max_connections'` and `SHOW VARIABLES LIKE 'wait_timeout'` to derive the connection limits. **The server must be reachable.** |
| Redis | Runs `INFO server` and rejects servers older than **8.2**. **The server must be reachable.** |
| ClickHouse | Opens the pool and sets the limits. No query is sent; an unreachable server is not detected here. |
| NATS | Nothing. The connection is opened lazily on first use. |

`Validate()` does not create tables, streams or consumers. That is the job of the schema tools described in [Schema Update](/guide/schema_update.html), [ClickHouse Schema](/guide/clickhouse_schema.html) and [NATS](/guide/nats.html).

### Validation rules

All checks below return an `error` from `Validate()`. Nothing is created, so a failed validation is always safe to retry after fixing the configuration.

**Pools**

- Redis: `redis pool '<code>' version <v> is not supported, minimum required is 8.2`, or `failed to get Redis server info for pool '<code>'` when the server cannot be reached.
- MySQL: any driver error while opening the pool or reading the server variables.

**ClickHouse tables** (`RegisterClickhouseTable`)

- A table needs a name, a pool code, at least one column, an engine and an `ORDER BY`.
- `clickhouse pool '<pool>' not registered for table '<table>'` - the builder references an unknown pool.
- `duplicate clickhouse table '<table>' in pool '<pool>' ...` - the same table registered twice.

**NATS streams and consumers** (`RegisterNatsStream`, `RegisterNatsConsumer`)

- A stream needs a name, a pool code and at least one subject; a consumer needs a name and a pool code.
- `nats pool '<pool>' not registered for stream '<name>'` / `nats pool '<pool>' not registered for consumer '<name>'`.
- `duplicate nats stream '<name>' in pool '<pool>' ...` / `duplicate nats consumer '<name>' in pool '<pool>' ...`.

**Entities** (`RegisterEntity`)

- `mysql pool '<code>' not found` - the pool named by `orm:"mysql=<code>"` (default `default`) is not registered.
- `redis pool '<code>' not found` / `redis pool '<code>' not found for redisSearch in entity '<name>'` - the pool named by `orm:"redisCache"` or `orm:"redisSearch"` is not registered.
- `invalid ttl '<value>' for entity '<name>'` - `orm:"ttl=..."` is not an integer.
- Index definitions: duplicate index names, index columns that do not exist, cached unique indexes that are not declared in `UniqueIndexes()`. See [MySQL Indexes](/guide/mysql_indexes.html).
- Unsupported field types and enum/set fields without values are reported as `invalid entity struct '<type>': ...`.
- Shared enums: `enum/set '<name>' has conflicting values defined in both '<a>' and '<b>', definition must be in only one entity` and `enum/set '<name>' referenced in '<entity>' but no entity defines its values`.
- Redis key prefixes must be unique across entities: `redis key prefix "<prefix>" is claimed by both <table> (<kind>) and <table> (<kind>); rename one of the tables`.

**Tasks** (`RegisterTask`) - see [Tasks](/guide/tasks.html)

- A task must be a named, exported struct type with at least one exported field; its name must match `^[A-Z][A-Za-z0-9_]*$` and its queue `^[a-z0-9_]+$`.
- A custom `Subject()` must stay under `fluxa.task.`; `MaxBackoff` may not be lower than `BaseBackoff`; two task types may not share a name.
- `task '<name>' is registered but fluxaorm.JobRunEntity is not; add registry.RegisterEntity(fluxaorm.JobRunEntity{})`.

**Consumers** (`RegisterConsumer`) - see [Consumers](/guide/consumers.html)

- A consumer name must match `^[a-z][a-z0-9-]*$` and may be declared only once.
- A consumer declares **either** `Entities` **or** `Queues`, never both and never neither.
- Every declared entity must be registered and tagged `orm:"cdc"`, and listed once.
- A queue may be drained by exactly one consumer, must have at least one task assigned, and every queue used by a task must be drained by some consumer.
- Every entity tagged `orm:"cdc"` must be declared on some consumer: `entity '<name>' is tagged `orm:"cdc"` but no consumer declares it ...`.

**Outbox** - see [Outbox](/guide/outbox.html)

- `entity '<name>' is tagged `orm:"outbox"` but fluxaorm.CDCOutboxEntity is not registered; ...`.
- All outbox entities must live on the same MySQL pool as `CDCOutboxEntity`, otherwise the outbox row could not share their transaction.

### `ValidateForCodeGen()`

`ValidateForCodeGen()` builds an `Engine` **without any network I/O**: no MySQL, Redis, ClickHouse or NATS connection is opened, and the pool checks above are skipped. Entity schemas, shared enums, Redis key prefixes, tasks and consumers are still resolved, so the generator sees the complete topology. It is the right choice for `go generate` steps and CI:

```go
engine, err := registry.ValidateForCodeGen()
if err != nil {
    panic(err)
}
if err := fluxaorm.Generate(engine, "./entities"); err != nil {
    panic(err)
}
```

Pool codes referenced by entity tags must still be *registered* (with any DSN); they just do not have to be reachable. The outbox rules, registry options and metrics are not applied on this path, and ClickHouse table, NATS stream and NATS consumer builders are neither validated nor carried into the `Engine`. See [Code Generation](/guide/code_generation.html).

## Loading Configuration from YAML

`InitByYaml()` takes an already parsed YAML document (`map[string]any` or yaml.v2's `map[interface{}]interface{}`). FluxaORM does not read files itself:

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
    var parsed map[string]interface{}
    if err := yaml.Unmarshal(data, &parsed); err != nil {
        panic(err)
    }

    registry := fluxaorm.NewRegistry()
    if err := registry.InitByYaml(parsed); err != nil {
        panic(err)
    }
}
```

### YAML Format

Each top-level key is a **pool code**. Under it, each key selects the pool kind. Several kinds may share one code:

```yml
default:
  mysql:
    uri: user:password@tcp(localhost:3306)/app
    maxOpenConnections: 50
    maxIdleConnections: 20
    connMaxLifetime: 180
    defaultEncoding: utf8mb4
    defaultCollate: 0900_ai_ci
    ignoredTables:
      - legacy_table
  redis: localhost:6379:0
  nats:
    urls:
      - nats://localhost:4222
    clientID: my-service
    authUser: app
    authPassword: secret
    ignoredSubjects:
      - legacy.>
    streams:
      - name: ORDERS_RAW
        poolCode: default
        subjects:
          - orders.>
        maxAgeMs: 604800000
    consumers:
      - name: orders-audit
        filterSubjects:
          - orders.>
        ackWaitMs: 30000
        maxAckPending: 16
        maxDeliver: -1
sessions:
  redis: localhost:6379:1?user=app&password=secret
local:
  redis: /var/run/redis.sock:0
cluster:
  sentinel:
    mymaster:0?user=app&password=secret:
      - :26379
      - 192.168.1.2:26379
analytics:
  clickhouse:
    uri: clickhouse://localhost:9000/analytics
    maxOpenConnections: 20
    ignoredTables:
      - raw_imports
```

| Key | Value | Notes |
|---|---|---|
| `mysql` | map | `uri` plus `connMaxLifetime` (seconds), `maxOpenConnections`, `maxIdleConnections`, `defaultEncoding`, `defaultCollate`, `ignoredTables` |
| `redis` | string | `host:port:db` or `/path/to/socket.sock:db`, optionally followed by `?user=<u>&password=<p>` (both must be present to take effect). A trailing fourth segment is accepted and ignored. |
| `sentinel` | map | keys are `master[:db][?user=<u>&password=<p>]`, values are lists of sentinel addresses |
| `clickhouse` | map | `uri` plus `connMaxLifetime` (seconds), `maxOpenConnections`, `maxIdleConnections`, `ignoredTables` |
| `nats` | map | `urls` (required), `clientID`, `maxReconnects`, `reconnectWaitMs`, `reconnectBufSize`, `authToken`, `authUser`, `authPassword`, `authCredsFile`, `ignoredSubjects`, `ignoredConsumers`, `consumers`, `streams` |
| `kafka` | any | **Error**: `kafka pool '<code>' is no longer supported; rename to 'nats' and migrate keys ...` |

Unknown pool kinds (for example a leftover `local_cache:` key) and unknown sub-keys are silently ignored. Integer values must be YAML integers and lists must be lists of strings; a wrong type yields `orm value for <key>: <value> is not valid`.

::: warning
Streams declared inside a `nats:` block must carry an explicit `poolCode`; without it `Validate()` fails with `nats pool code is required for stream '<name>'`. Consumers automatically belong to the enclosing pool. `connectTimeoutMs`, `retryOnFailedConnect`, `authNKeySeed` and `PingInterval` are not readable from this YAML shape - use the `Config` struct or `RegisterNats()` for them.
:::

## Loading Configuration from a Config Struct

`InitByConfig()` takes a `Config` value. The struct carries `yaml` tags, so it can also be unmarshalled directly from a list-based YAML file:

```go
registry := fluxaorm.NewRegistry()

config := &fluxaorm.Config{
    MySQlPools: []fluxaorm.ConfigMysql{
        {Code: "default", URI: "user:password@tcp(localhost:3306)/app"},
        {Code: "logs", URI: "user:password@tcp(localhost:3306)/logs", MaxOpenConnections: 50},
    },
    RedisPools: []fluxaorm.ConfigRedis{
        {Code: "default", URI: "localhost:6379", Database: 0},
        {Code: "sessions", URI: "localhost:6379", Database: 1, User: "app", Password: "secret"},
    },
    RedisSentinelPools: []fluxaorm.ConfigRedisSentinel{
        {Code: "cluster", MasterName: "mymaster", Sentinels: []string{":26379", "192.168.1.2:26379"}},
    },
    ClickhousePools: []fluxaorm.ConfigClickhouse{
        {Code: "analytics", URI: "clickhouse://localhost:9000/analytics"},
    },
    NatsPools: []fluxaorm.ConfigNats{
        {
            Code:     "default",
            URLs:     []string{"nats://localhost:4222"},
            ClientID: "my-service",
            Streams: []fluxaorm.ConfigNatsStream{
                {Name: "ORDERS_RAW", Subjects: []string{"orders.>"}, MaxAgeMs: 604800000},
            },
            Consumers: []fluxaorm.ConfigNatsConsumer{
                {Name: "orders-audit", FilterSubjects: []string{"orders.>"}, MaxDeliver: -1},
            },
        },
    },
}

if err := registry.InitByConfig(config); err != nil {
    panic(err)
}
```

### Config Struct Reference

```go
type Config struct {
    MySQlPools         []ConfigMysql         `yaml:"mysqlPools"`
    RedisPools         []ConfigRedis         `yaml:"redisPools"`
    RedisSentinelPools []ConfigRedisSentinel `yaml:"redisSentinelPools"`
    ClickhousePools    []ConfigClickhouse    `yaml:"clickhousePools"`
    NatsPools          []ConfigNats          `yaml:"natsPools"`
}

type ConfigMysql struct {
    Code               string   `yaml:"code"`               // required - pool code
    URI                string   `yaml:"uri"`                // required - MySQL DSN
    ConnMaxLifetime    int      `yaml:"connMaxLifetime"`    // seconds
    MaxOpenConnections int      `yaml:"maxOpenConnections"`
    MaxIdleConnections int      `yaml:"maxIdleConnections"`
    DefaultEncoding    string   `yaml:"defaultEncoding"`
    DefaultCollate     string   `yaml:"defaultCollate"`
    IgnoredTables      []string `yaml:"ignoredTables"`
}

type ConfigRedis struct {
    Code     string `yaml:"code"`     // required - pool code
    URI      string `yaml:"uri"`      // required - host:port or /path/to/socket.sock
    Database int    `yaml:"database"`
    User     string `yaml:"user"`
    Password string `yaml:"password"`
}

type ConfigRedisSentinel struct {
    Code       string   `yaml:"code"`       // required - pool code
    MasterName string   `yaml:"masterName"` // required
    Database   int      `yaml:"database"`
    Sentinels  []string `yaml:"sentinels"`
    User       string   `yaml:"user"`
    Password   string   `yaml:"password"`
}

type ConfigClickhouse struct {
    Code               string   `yaml:"code"` // required - pool code
    URI                string   `yaml:"uri"`  // required - ClickHouse DSN
    ConnMaxLifetime    int      `yaml:"connMaxLifetime"` // seconds
    MaxOpenConnections int      `yaml:"maxOpenConnections"`
    MaxIdleConnections int      `yaml:"maxIdleConnections"`
    IgnoredTables      []string `yaml:"ignoredTables"`
}

type ConfigNats struct {
    Code                 string               `yaml:"code"` // required - pool code
    URLs                 []string             `yaml:"urls"` // required
    ClientID             string               `yaml:"clientID"`
    MaxReconnects        int                  `yaml:"maxReconnects"`
    ReconnectWaitMs      int                  `yaml:"reconnectWaitMs"`
    ReconnectBufSize     int                  `yaml:"reconnectBufSize"`
    ConnectTimeoutMs     int                  `yaml:"connectTimeoutMs"`
    RetryOnFailedConnect bool                 `yaml:"retryOnFailedConnect"`
    AuthToken            string               `yaml:"authToken"`
    AuthUser             string               `yaml:"authUser"`
    AuthPassword         string               `yaml:"authPassword"`
    AuthCredsFile        string               `yaml:"authCredsFile"`
    AuthNKeySeed         string               `yaml:"authNKeySeed"`
    IgnoredSubjects      []string             `yaml:"ignoredSubjects"`
    IgnoredConsumers     []string             `yaml:"ignoredConsumers"`
    Consumers            []ConfigNatsConsumer `yaml:"consumers"`
    Streams              []ConfigNatsStream   `yaml:"streams"`
}

type ConfigNatsConsumer struct {
    Name           string   `yaml:"name"` // required
    FilterSubjects []string `yaml:"filterSubjects"`
    AckWaitMs      int      `yaml:"ackWaitMs"`
    MaxAckPending  int      `yaml:"maxAckPending"`
    MaxDeliver     int      `yaml:"maxDeliver"` // applied when != 0, so -1 (unlimited) works
}

type ConfigNatsStream struct {
    Name            string   `yaml:"name"`     // required
    Subjects        []string `yaml:"subjects"` // required
    MaxAgeMs        int      `yaml:"maxAgeMs"`
    MaxBytes        int64    `yaml:"maxBytes"`
    MaxMsgSize      int32    `yaml:"maxMsgSize"`
    Replicas        int      `yaml:"replicas"`
    DuplicateWindow int      `yaml:"duplicateWindowMs"`
    Storage         string   `yaml:"storage"`
    Retention       string   `yaml:"retention"`
}
```

Streams and consumers inside a `ConfigNats` entry automatically belong to that pool. `InitByConfig()` always returns `nil`; problems surface in `Validate()`.

::: warning
`ConfigNatsStream.Storage` and `ConfigNatsStream.Retention` are parsed but currently **not applied** by `InitByConfig()`; streams keep the builder defaults (file storage, limits retention). Use `RegisterNatsStream()` with the builder when you need a different storage or retention policy.
:::
