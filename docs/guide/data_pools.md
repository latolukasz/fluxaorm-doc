# Data Pools

This page covers the details of configuring MySQL, Redis, Kafka, and local cache connection pools in FluxaORM.

Each connection pool requires a unique name (code) that identifies it throughout your application. Use `fluxaorm.DefaultPoolCode` (the string `"default"`) for your primary pools.

## MySQL Pool

Register a MySQL connection using the `RegisterMySQL` method. The first argument is a standard Go MySQL driver [data source name](https://github.com/go-sql-driver/mysql#dsn-data-source-name):

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// MySQL pool named "default" with default options:
registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, nil)

// Pool named "logs" with custom options:
registry.RegisterMySQL("user:password@tcp(localhost:3306)/logs", "logs", &fluxaorm.MySQLOptions{
    MaxOpenConnections: 100,
})
```

Equivalent YAML configuration:

```yml
default:
  mysql:
    uri: user:password@tcp(localhost:3306)/app
logs:
  mysql:
    uri: user:password@tcp(localhost:3306)/logs
    maxOpenConnections: 100
```

### MySQL Options

The `MySQLOptions` struct lets you configure connection pool behavior and schema defaults:

```go
type MySQLOptions struct {
    ConnMaxLifetime    time.Duration // max lifetime of a connection before it is closed
    MaxOpenConnections int           // max number of open connections to the database
    MaxIdleConnections int           // max number of idle connections in the pool
    DefaultEncoding    string        // default character set (default: "utf8mb4")
    DefaultCollate     string        // default collation (default: "0900_ai_ci")
    IgnoredTables      []string      // tables to skip during schema sync
    Beta               bool          // enable beta features (parseTime, UTC location)
}
```

Full example:

```go
import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

options := &fluxaorm.MySQLOptions{
    MaxOpenConnections: 30,
    MaxIdleConnections: 20,
    ConnMaxLifetime:    3 * time.Minute,
    DefaultEncoding:    "greek",
    DefaultCollate:     "greek_general_ci",
    IgnoredTables:      []string{"legacy_table", "temp_imports"},
}

registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, options)
```

Equivalent YAML:

```yml
default:
  mysql:
    uri: user:password@tcp(localhost:3306)/app
    maxOpenConnections: 30
    maxIdleConnections: 20
    connMaxLifetime: 180
    defaultEncoding: greek
    defaultCollate: greek_general_ci
    ignoredTables:
      - legacy_table
      - temp_imports
```

::: tip
You can configure MySQL connection settings such as `MaxOpenConnections` and `MaxIdleConnections`, but it is advisable to keep the default values (empty). During `Validate()`, FluxaORM queries your MySQL server's `max_connections` and `wait_timeout` variables and automatically calculates optimal pool settings.
:::

### Ignored Tables

By default, FluxaORM's [schema update](/guide/schema_update.html) will attempt to remove MySQL tables that are not defined as entities in your application. To keep external or legacy tables, list them in the `IgnoredTables` option.

## Local Cache Pool

FluxaORM provides a fast in-memory key-value cache using the [LRU](https://en.wikipedia.org/wiki/Cache_replacement_policies#Least_recently_used_(LRU)) eviction algorithm. When the cache reaches capacity, the least recently used entries are evicted automatically.

```go
// Default pool with max 100,000 entries
registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 100000)

// Pool for static lookups with no size limit
registry.RegisterLocalCache("static_data", 0)
```

Equivalent YAML:

```yml
default:
  local_cache: 100000
static_data:
  local_cache: 0
```

::: tip
Choose cache sizes carefully. A cache that is too small will have a low hit rate due to frequent evictions. A cache that is too large will consume unnecessary memory. Consider defining multiple pools with different sizes — keep frequently accessed data in larger pools and less critical data in smaller ones.
:::

## ClickHouse Pool

Register a ClickHouse connection using the `RegisterClickhouse` method. The first argument is a ClickHouse [DSN](https://github.com/ClickHouse/clickhouse-go#dsn) (data source name):

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// ClickHouse pool named "analytics" with default options:
registry.RegisterClickhouse("clickhouse://localhost:9000/default", "analytics", nil)

// Pool with custom options:
registry.RegisterClickhouse("clickhouse://localhost:9000/default", "analytics", &fluxaorm.ClickhouseOptions{
    MaxOpenConnections: 20,
    MaxIdleConnections: 10,
})
```

Equivalent YAML configuration:

```yml
analytics:
  clickhouse:
    uri: clickhouse://localhost:9000/default
    maxOpenConnections: 20
    maxIdleConnections: 10
```

### ClickHouse Options

The `ClickhouseOptions` struct lets you configure connection pool behavior:

```go
type ClickhouseOptions struct {
    ConnMaxLifetime    time.Duration // max lifetime of a connection before it is closed
    MaxOpenConnections int           // max number of open connections
    MaxIdleConnections int           // max number of idle connections in the pool
}
```

::: tip
ClickHouse support in FluxaORM includes both raw query execution and [schema management](/guide/clickhouse_schema.html). Use `RegisterClickhouseTable()` to define table schemas and `GetClickhouseAlters()` to generate DDL statements.
:::

### ClickHouse Ignored Tables

By default, FluxaORM's [schema update](/guide/schema_update.html#clickhouse-schema-alterations) will attempt to remove ClickHouse tables that are not registered via `RegisterClickhouseTable()`. To keep external or unmanaged tables, list them in the `IgnoredTables` option:

```go
registry.RegisterClickhouse("clickhouse://localhost:9000/default", "analytics", &fluxaorm.ClickhouseOptions{
    IgnoredTables: []string{"legacy_events", "temp_imports"},
})
```

Equivalent YAML:

```yml
analytics:
  clickhouse:
    uri: clickhouse://localhost:9000/default
    ignoredTables:
      - legacy_events
      - temp_imports
```

## Kafka Pool

FluxaORM supports Apache Kafka as a data pool type, powered by [franz-go](https://github.com/twmb/franz-go). A Kafka pool represents a connection to a set of brokers and can contain multiple consumer groups. Register a Kafka pool using the `RegisterKafka` method, and consumer groups separately using `RegisterKafkaConsumerGroup`:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

registry.RegisterKafka([]string{"localhost:9092", "localhost:9093"}, "events", &fluxaorm.KafkaPoolOptions{
    ClientID: "my-service",
})

registry.RegisterKafkaConsumerGroup(
    fluxaorm.NewKafkaConsumerGroup("order-group", "events").Topics("orders"),
)
registry.RegisterKafkaConsumerGroup(
    fluxaorm.NewKafkaConsumerGroup("payment-group", "events").Topics("payments"),
)
```

Equivalent YAML configuration:

```yml
events:
  kafka:
    brokers:
      - localhost:9092
      - localhost:9093
    clientID: my-service
    consumerGroups:
      - name: order-group
        topics:
          - orders
      - name: payment-group
        topics:
          - payments
```

For the full list of options, SASL authentication, producing and consuming records, see the dedicated [Kafka](/guide/kafka.html) page.

::: tip
Kafka support in FluxaORM includes both producing/consuming and [topic schema management](/guide/kafka.html#topic-registration). Use `RegisterKafkaTopic()` to define topic schemas and `GetKafkaAlters()` to synchronize topics with the broker.
:::

### Kafka Ignored Topics

By default, FluxaORM's [topic schema management](/guide/kafka.html#topic-registration) will attempt to delete Kafka topics that are not registered via `RegisterKafkaTopic()`. Internal Kafka topics (those starting with `__`) are always excluded automatically. To keep additional external or legacy topics, list them in the `IgnoredTopics` option:

```go
registry.RegisterKafka([]string{"localhost:9092"}, "events", &fluxaorm.KafkaPoolOptions{
    IgnoredTopics: []string{"legacy-topic", "external-service-topic"},
})
```

Equivalent YAML:

```yml
events:
  kafka:
    brokers:
      - localhost:9092
    ignoredTopics:
      - legacy-topic
      - external-service-topic
```

### Kafka Ignored Consumer Groups

Similarly, `GetKafkaAlters()` will attempt to delete consumer groups on the broker that are not registered via `RegisterKafkaConsumerGroup()`. Internal consumer groups (those starting with `__`) are always excluded. To protect additional consumer groups from deletion, list them in the `IgnoredConsumerGroups` option:

```go
registry.RegisterKafka([]string{"localhost:9092"}, "events", &fluxaorm.KafkaPoolOptions{
    IgnoredConsumerGroups: []string{"legacy-consumer", "external-service-consumer"},
})
```

Equivalent YAML:

```yml
events:
  kafka:
    brokers:
      - localhost:9092
    ignoredConsumerGroups:
      - legacy-consumer
      - external-service-consumer
```

## Redis Pool

::: warning Minimum Version
FluxaORM requires **Redis 8.2** or later. During `Validate()`, the ORM checks the version of every registered Redis server and returns an error if any server is below 8.2.
:::

Register a Redis connection using the `RegisterRedis` method. The address argument accepts `host:port` format or a Unix socket path:

```go
import "github.com/latolukasz/fluxaorm/v2"

// Pool named "default", database 0, no authentication:
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

// Pool named "sessions", database 1, with authentication:
registry.RegisterRedis("localhost:6379", 1, "sessions", &fluxaorm.RedisOptions{
    User:     "myuser",
    Password: "secret",
})

// Unix socket connection:
registry.RegisterRedis("/var/run/redis.sock", 0, "local", nil)
```

Equivalent YAML:

```yml
default:
  redis: localhost:6379:0
sessions:
  redis: localhost:6379:1?user=myuser&password=secret
local:
  redis: /var/run/redis.sock:0
```

### Redis Options

```go
type RedisOptions struct {
    User            string                    // Redis username (ACL)
    Password        string                    // Redis password
    Master          string                    // Sentinel master name
    Sentinels       []string                  // list of sentinel addresses
    SentinelOptions *redis.FailoverOptions    // advanced sentinel config (overrides all other fields)
}
```

### Redis Sentinel

For production environments, we strongly recommend using Redis Sentinel for high availability:

```go
import "github.com/latolukasz/fluxaorm/v2"

options := &fluxaorm.RedisOptions{
    Master:    "mymaster",
    Sentinels: []string{":26379", "192.168.1.2:26379", "192.168.1.3:26379"},
    User:      "user",
    Password:  "password",
}

registry.RegisterRedis("", 0, "cluster", options)
```

When using Sentinel, pass an empty string as the address — the client connects through the sentinel nodes instead.

Equivalent YAML:

```yml
cluster:
  sentinel:
    mymaster:0?user=user&password=password:
      - :26379
      - 192.168.1.2:26379
      - 192.168.1.3:26379
```

For advanced Sentinel configuration, you can provide a `*redis.FailoverOptions` struct directly via the `SentinelOptions` field. When set, it overrides all other options (Master, Sentinels, User, Password).

::: tip
We strongly recommend using Redis Sentinel pools instead of a single server pool in your production environment.
:::
