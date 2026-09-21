---
description: "Configuring FluxaORM connection pools for MySQL, Redis, ClickHouse and NATS: options, DSN parsing, defaults, Sentinel and NATS authentication."
---

# Data Pools

This page describes how the four kinds of connection pools - MySQL, Redis, ClickHouse and NATS - are configured, what their options mean and what defaults apply.

Every pool has a unique **code** that identifies it throughout your application. Use `fluxaorm.DefaultPoolCode` (the string `"default"`) for your primary pools; entities and consumers fall back to it whenever no pool is named explicitly. Each pool kind has its own namespace, so a MySQL pool and a Redis pool may both be called `default`.

Pools are registered on the [Registry](/guide/registry.html) and retrieved from the [Engine](/guide/engine.html) with `engine.DB(code)`, `engine.Redis(code)`, `engine.Clickhouse(code)` and `engine.Nats(code)`.

## MySQL Pool

Register a MySQL pool with `RegisterMySQL`. The first argument is a standard Go MySQL driver [data source name](https://github.com/go-sql-driver/mysql#dsn-data-source-name):

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// Pool "default" with default options
registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})

// Pool "logs" with custom options
registry.RegisterMySQL("user:password@tcp(localhost:3306)/logs", "logs", &fluxaorm.MySQLOptions{
    MaxOpenConnections: 100,
})
```

::: danger
The options pointer must not be `nil` - `Validate()` dereferences it and panics. Pass `&fluxaorm.MySQLOptions{}` when you have nothing to configure.
:::

### DSN handling

- The DSN **must** contain a database name: the text after the last `/` (up to `?`) is used as the schema name for table introspection and [schema updates](/guide/schema_update.html).
- `parseTime=true&loc=UTC` is always appended to the DSN during `Validate()` (with `&` if the DSN already has a query string, `?` otherwise). Do not add these parameters yourself, they would be duplicated.

### MySQL Options

```go
type MySQLOptions struct {
    ConnMaxLifetime    time.Duration
    MaxOpenConnections int
    MaxIdleConnections int
    DefaultEncoding    string
    DefaultCollate     string
    IgnoredTables      []string
}
```

| Field | Default | Description |
|---|---|---|
| `MaxOpenConnections` | `100` | Upper bound of open connections. The effective value is always capped by the server's `max_connections`. |
| `MaxIdleConnections` | same as the effective `MaxOpenConnections` | Idle connections kept in the pool; capped by the effective `MaxOpenConnections`. |
| `ConnMaxLifetime` | `5 * time.Minute` | Maximum lifetime of one connection; capped by the server's `wait_timeout` (seconds). |
| `DefaultEncoding` | `"utf8mb4"` | Character set used when FluxaORM creates tables. |
| `DefaultCollate` | `"0900_ai_ci"` | Collation suffix used when FluxaORM creates tables (combined with the encoding, e.g. `utf8mb4_0900_ai_ci`). |
| `IgnoredTables` | none | Tables in this schema that [schema update](/guide/schema_update.html) must never drop. |

During `Validate()` FluxaORM runs `SHOW VARIABLES LIKE 'max_connections'` and `SHOW VARIABLES LIKE 'wait_timeout'` on every MySQL pool and clamps the values above to what the server allows. This is why MySQL must be reachable at validation time. The empty `DefaultEncoding`/`DefaultCollate` are written back into your `MySQLOptions` struct with the defaults.

::: tip
Leave the connection limits empty unless you have a reason not to. The defaults are derived from the server settings and work well for most deployments.
:::

Full example:

```go
import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{
    MaxOpenConnections: 30,
    MaxIdleConnections: 20,
    ConnMaxLifetime:    3 * time.Minute,
    DefaultEncoding:    "utf8mb4",
    DefaultCollate:     "0900_ai_ci",
    IgnoredTables:      []string{"legacy_table", "temp_imports"},
})
```

Equivalent YAML (`connMaxLifetime` is in seconds):

```yml
default:
  mysql:
    uri: user:password@tcp(localhost:3306)/app
    maxOpenConnections: 30
    maxIdleConnections: 20
    connMaxLifetime: 180
    defaultEncoding: utf8mb4
    defaultCollate: 0900_ai_ci
    ignoredTables:
      - legacy_table
      - temp_imports
```

Equivalent `Config` entry:

```go
fluxaorm.ConfigMysql{
    Code:               "default",
    URI:                "user:password@tcp(localhost:3306)/app",
    MaxOpenConnections: 30,
    MaxIdleConnections: 20,
    ConnMaxLifetime:    180, // seconds
    DefaultEncoding:    "utf8mb4",
    DefaultCollate:     "0900_ai_ci",
    IgnoredTables:      []string{"legacy_table", "temp_imports"},
}
```

### Ignored Tables

[Schema update](/guide/schema_update.html) proposes dropping MySQL tables that do not belong to any registered entity. To keep external or legacy tables, list them in `IgnoredTables`.

## Redis Pool

::: warning Minimum Version
FluxaORM requires **Redis 8.2** or later. `Validate()` runs `INFO server` on every Redis pool and fails with `redis pool '<code>' version <v> is not supported, minimum required is 8.2` for older servers. Redis must therefore be reachable at validation time.
:::

Register a Redis pool with `RegisterRedis(address, db, poolCode, options)`:

```go
import "github.com/latolukasz/fluxaorm/v2"

// Pool "default", database 0, no authentication
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

// Pool "sessions", database 1, with ACL credentials
registry.RegisterRedis("localhost:6379", 1, "sessions", &fluxaorm.RedisOptions{
    User:     "app",
    Password: "secret",
})

// Unix socket
registry.RegisterRedis("/var/run/redis.sock", 0, "local", nil)
```

| Argument | Meaning |
|---|---|
| `address` | `host:port`, or a Unix socket path. An address ending in `.sock` switches the client to the `unix` network. Ignored for Sentinel pools. |
| `db` | Redis logical database number. Reported later by `GetConfig().GetDatabaseNumber()`. |
| `poolCode` | The pool code. |
| `options` | `*RedisOptions`, may be `nil`. |

The client is created with go-redis's `UnstableResp3` flag enabled, a 2 minute `ConnMaxIdleTime` and Redis maintenance notifications disabled. There is no key namespace or prefix option on a pool; key prefixes are derived per entity (see [Redis Cache](/guide/redis_cache.html)).

Equivalent YAML (`host:port:db` or `/path.sock:db`, optional `?user=&password=` - both must be present to take effect):

```yml
default:
  redis: localhost:6379:0
sessions:
  redis: localhost:6379:1?user=app&password=secret
local:
  redis: /var/run/redis.sock:0
```

Equivalent `Config` entries:

```go
fluxaorm.ConfigRedis{Code: "default", URI: "localhost:6379", Database: 0}
fluxaorm.ConfigRedis{Code: "sessions", URI: "localhost:6379", Database: 1, User: "app", Password: "secret"}
fluxaorm.ConfigRedis{Code: "local", URI: "/var/run/redis.sock", Database: 0}
```

### Redis Options

```go
type RedisOptions struct {
    User            string                 // ACL username
    Password        string                 // password
    Master          string                 // Sentinel master name
    Sentinels       []string               // Sentinel addresses; non-empty switches the pool to Sentinel mode
    SentinelOptions *redis.FailoverOptions // full go-redis failover configuration, used verbatim when set
}
```

### Redis Sentinel

A pool runs in Sentinel mode as soon as `Sentinels` is non-empty. Pass an empty address; the client discovers the master through the sentinels:

```go
registry.RegisterRedis("", 0, "cluster", &fluxaorm.RedisOptions{
    Master:    "mymaster",
    Sentinels: []string{":26379", "192.168.1.2:26379", "192.168.1.3:26379"},
    User:      "app",
    Password:  "secret",
})
```

Without `SentinelOptions`, FluxaORM builds a `redis.FailoverOptions` from `Master`, `Sentinels`, the `db` argument, `User` and `Password` (again with a 2 minute `ConnMaxIdleTime`). When you provide `SentinelOptions`, it is passed to go-redis **verbatim** and `Master`, `Sentinels`, `User`, `Password` and the `db` argument are not injected into it - set `FailoverOptions.DB` yourself. `GetConfig().GetAddress()` of a Sentinel pool returns the formatted sentinel list.

Equivalent YAML (key format `master[:db][?user=&password=]`):

```yml
cluster:
  sentinel:
    mymaster:0?user=app&password=secret:
      - :26379
      - 192.168.1.2:26379
      - 192.168.1.3:26379
```

Equivalent `Config` entry:

```go
fluxaorm.ConfigRedisSentinel{
    Code:       "cluster",
    MasterName: "mymaster",
    Database:   0,
    Sentinels:  []string{":26379", "192.168.1.2:26379", "192.168.1.3:26379"},
    User:       "app",
    Password:   "secret",
}
```

::: tip
Use Sentinel pools rather than a single server in production.
:::

## ClickHouse Pool

Register a ClickHouse pool with `RegisterClickhouse`. The first argument is a [clickhouse-go](https://github.com/ClickHouse/clickhouse-go#dsn) DSN of the form `clickhouse://host:port/database?params`; the database name is parsed from the path:

```go
import "github.com/latolukasz/fluxaorm/v2"

// Pool "analytics" with default options (nil is allowed here)
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", nil)

// Pool with custom options
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", &fluxaorm.ClickhouseOptions{
    MaxOpenConnections: 20,
    MaxIdleConnections: 10,
    IgnoredTables:      []string{"raw_imports"},
})
```

`Validate()` opens the pool and applies the limits but sends no query, so an unreachable ClickHouse server is only detected on first use.

### ClickHouse Options

```go
type ClickhouseOptions struct {
    ConnMaxLifetime    time.Duration
    MaxOpenConnections int
    MaxIdleConnections int
    IgnoredTables      []string
}
```

| Field | Default | Description |
|---|---|---|
| `MaxOpenConnections` | `100` | Upper bound of open connections (no server-side capping). |
| `MaxIdleConnections` | same as `MaxOpenConnections` | Idle connections kept in the pool. |
| `ConnMaxLifetime` | `5 * time.Minute` | Maximum lifetime of one connection. |
| `IgnoredTables` | none | Tables that [ClickHouse schema](/guide/clickhouse_schema.html) management must never drop. |

Equivalent YAML (`connMaxLifetime` in seconds):

```yml
analytics:
  clickhouse:
    uri: clickhouse://localhost:9000/analytics
    maxOpenConnections: 20
    maxIdleConnections: 10
    ignoredTables:
      - raw_imports
```

Equivalent `Config` entry:

```go
fluxaorm.ConfigClickhouse{
    Code:               "analytics",
    URI:                "clickhouse://localhost:9000/analytics",
    MaxOpenConnections: 20,
    MaxIdleConnections: 10,
    IgnoredTables:      []string{"raw_imports"},
}
```

Table definitions are registered separately with `RegisterClickhouseTable()`; see [ClickHouse Schema](/guide/clickhouse_schema.html) and [ClickHouse Queries](/guide/clickhouse_queries.html).

## NATS Pool

A NATS pool is a connection to a NATS cluster with JetStream enabled. It carries FluxaORM's own streams (entity events, tasks) as well as any streams and consumers you register yourself. Register it with `RegisterNats(urls, poolCode, options)`:

```go
import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

registry.RegisterNats([]string{"nats://localhost:4222", "nats://localhost:4223"}, fluxaorm.DefaultPoolCode, &fluxaorm.NatsPoolOptions{
    ClientID:       "my-service",
    ConnectTimeout: 5 * time.Second,
    Auth: &fluxaorm.NatsAuthConfig{
        User:     "app",
        Password: "secret",
    },
})
```

URLs are trimmed, empty entries dropped and the rest joined with `,` for the NATS client. `nil` options are replaced with `&NatsPoolOptions{}`.

### Lazy connection

`Validate()` does **not** connect to NATS. The connection and the JetStream context are created on the first call that needs them (`Publish*`, `Consumer`, `GetJetStream`, `GetConn`, `Ping`) and re-established automatically when the previous connection is no longer `CONNECTED`. Use `engine.Nats(code).Ping()` to force a connection at startup, and `engine.Nats(code).Close()` on shutdown. An empty URL list is reported at first use as `nats pool '<code>': no urls configured`.

### NATS Options

```go
type NatsPoolOptions struct {
    ClientID             string
    MaxReconnects        int
    ReconnectWait        time.Duration
    ReconnectBufSize     int
    PingInterval         time.Duration
    ConnectTimeout       time.Duration
    RetryOnFailedConnect bool
    Auth                 *NatsAuthConfig
    IgnoredSubjects      []string
    IgnoredConsumers     []string
}

type NatsAuthConfig struct {
    Token     string
    User      string
    Password  string
    CredsFile string
    NKeySeed  string
}
```

| Field | Default | Description |
|---|---|---|
| `ClientID` | `""` | Connection name shown by the NATS server (`nats.Name`). |
| `MaxReconnects` | `-1` (unlimited) | Reconnect attempts; applied when non-zero. |
| `ReconnectWait` | `1s` | Delay between reconnect attempts; applied when `> 0`. |
| `ReconnectBufSize` | client default | Bytes buffered while disconnected; applied when `> 0`. |
| `PingInterval` | client default | Client ping interval; applied when `> 0`. |
| `ConnectTimeout` | client default | Dial timeout (`nats.Timeout`); applied when `> 0`. |
| `RetryOnFailedConnect` | `false` | Keep retrying in the background if the initial connect fails. |
| `Auth` | `nil` | Credentials; exactly one method is used, in this order of precedence: `CredsFile`, `NKeySeed`, `Token`, `User`/`Password`. |
| `IgnoredSubjects` | none | Existing `FLUXA_*`/`fluxa_*` streams carrying any of these subjects are never deleted by [NATS schema](/guide/nats.html) reconciliation. |
| `IgnoredConsumers` | none | Reserved for consumer reconciliation; currently stored but not used. |

Equivalent YAML:

```yml
default:
  nats:
    urls:
      - nats://localhost:4222
      - nats://localhost:4223
    clientID: my-service
    maxReconnects: -1
    reconnectWaitMs: 1000
    reconnectBufSize: 8388608
    authUser: app
    authPassword: secret
    ignoredSubjects:
      - legacy.>
    ignoredConsumers:
      - legacy-consumer
```

The pool-style YAML also accepts `authToken`, `authCredsFile`, `streams` and `consumers` (see [Registry](/guide/registry.html#yaml-format)). It does **not** accept `connectTimeoutMs`, `retryOnFailedConnect`, `authNKeySeed` or a ping interval; use the `Config` struct or `RegisterNats()` for those.

Equivalent `Config` entry:

```go
fluxaorm.ConfigNats{
    Code:                 "default",
    URLs:                 []string{"nats://localhost:4222", "nats://localhost:4223"},
    ClientID:             "my-service",
    MaxReconnects:        -1,
    ReconnectWaitMs:      1000,
    ConnectTimeoutMs:     5000,
    RetryOnFailedConnect: true,
    AuthUser:             "app",
    AuthPassword:         "secret",
    IgnoredSubjects:      []string{"legacy.>"},
}
```

`ConfigNats` builds a `NatsAuthConfig` when any of `AuthToken`, `AuthUser`, `AuthCredsFile` or `AuthNKeySeed` is set. `PingInterval` has no `Config` field.

Streams, consumers, publishing and fetching are covered in [NATS](/guide/nats.html); FluxaORM's own use of the pool for entity events and tasks in [Entity Events](/guide/entity_events.html), [Consumers](/guide/consumers.html) and [Tasks](/guide/tasks.html).
