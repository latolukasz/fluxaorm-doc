# Debezium CDC

FluxaORM supports [Debezium](https://debezium.io/) Change Data Capture (CDC) integration. This allows automatic streaming of MySQL row changes to Kafka topics via Debezium connectors, enabling real-time event-driven architectures without modifying application write paths.

Debezium captures row-level changes from MySQL's binary log and publishes them to Kafka topics. FluxaORM manages the Debezium connector configuration automatically based on your entity definitions.

## Prerequisites

Debezium CDC requires the following infrastructure:

- **MySQL** with binary logging enabled
- **Kafka** broker(s)
- **Debezium Connect** container (Kafka Connect with the Debezium MySQL connector)

### MySQL Configuration

MySQL must have binary logging enabled with row-level format. Add the following flags to your MySQL server:

```
--server-id=1 --log-bin=mysql-bin --binlog-format=ROW --binlog-row-image=FULL
```

### Docker Setup

A typical Docker Compose setup includes the Debezium Connect container alongside MySQL and Kafka:

```yml
services:
  mysql:
    image: mysql:8.0
    command: --server-id=1 --log-bin=mysql-bin --binlog-format=ROW --binlog-row-image=FULL
    ports:
      - "3306:3306"

  kafka:
    image: bitnami/kafka:latest
    ports:
      - "9092:9092"

  debezium-connect:
    image: debezium/connect:latest
    ports:
      - "8083:8083"
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: 1
      CONFIG_STORAGE_TOPIC: connect_configs
      OFFSET_STORAGE_TOPIC: connect_offsets
      STATUS_STORAGE_TOPIC: connect_statuses
```

## Enabling Debezium on an Entity

To enable Debezium CDC for an entity, add the `debezium` tag to the `ID` field:

```go
type UserEntity struct {
    ID    uint64 `orm:"debezium"`
    Name  string `orm:"required;length=255"`
    Email string `orm:"required;length=255"`
}
```

By default, the `debezium` tag uses the default Kafka pool. To specify a different Kafka pool, use `debezium=poolCode`:

```go
type OrderEntity struct {
    ID     uint64 `orm:"debezium=events"`
    Amount float64
}
```

::: tip
The `debezium` tag can be combined with other ID field tags like `redisCache`, `localCache`, and `mysql`:

```go
type UserEntity struct {
    ID uint64 `orm:"redisCache;debezium;mysql=users"`
}
```
:::

## Registry Configuration

Register the Debezium Connect REST API URL for a Kafka pool using `RegisterDebeziumConnectURL`:

```go
registry := fluxaorm.NewRegistry()

// Register MySQL and Kafka pools
registry.RegisterMySQL("user:pass@tcp(localhost:3306)/mydb", fluxaorm.DefaultPoolCode, nil)
registry.RegisterKafka([]string{"localhost:9092"}, "kafka", nil)

// Register the Debezium Connect URL for the Kafka pool
registry.RegisterDebeziumConnectURL("http://localhost:8083", "kafka")

// Register entities with debezium tag
registry.RegisterEntity(&UserEntity{})

engine, err := registry.Validate()
if err != nil {
    panic(err)
}
```

The `RegisterDebeziumConnectURL` method takes two arguments:

| Parameter | Type | Description |
|-----------|------|-------------|
| `url` | `string` | The Kafka Connect REST API base URL (e.g., `http://localhost:8083`) |
| `kafkaPool` | `string` | The Kafka pool code that Debezium topics will be published to |

## Connector Management

FluxaORM creates one Debezium connector per MySQL pool. The connector automatically manages all entities tagged with `debezium` in that pool.

### Connector Naming

Connectors are named using the pattern `fluxa_{mysqlPoolCode}`. For example, if your MySQL pool code is `default`, the connector name is `fluxa_default`.

### GetDebeziumAlters

Use `GetDebeziumAlters()` to compare the desired Debezium connector state (based on registered entities) with the actual state in Kafka Connect. It returns operations to create, update, or delete connectors:

```go
ctx := engine.NewContext(context.Background())

alters, err := fluxaorm.GetDebeziumAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    fmt.Println(alter.Description)
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

`GetDebeziumAlters()` generates the following types of operations:

| Scenario | Operation |
|----------|-----------|
| Connector does not exist | Create connector with configuration for all debezium-tagged tables |
| Connector exists but table list changed | Update connector configuration |
| Connector exists but no entities use debezium | Delete connector |

::: tip
Call `GetDebeziumAlters()` alongside `GetAlters()`, `GetKafkaAlters()`, `GetRedisSearchAlters()`, and `GetClickhouseAlters()` in your migration flow to keep all data stores in sync.
:::

## Topic Naming

Debezium publishes change events to Kafka topics using the naming pattern:

```
fluxa_{mysqlPoolCode}.{database}.{table}
```

For example, if your MySQL pool code is `default`, the database is `test`, and the entity struct is `UserEntity`, the topic name is:

```
fluxa_default.test.UserEntity
```

Use `DebeziumTopicName()` to get the topic name for a specific entity:

```go
topicName := fluxaorm.DebeziumTopicName(ctx, &UserEntity{})
// Returns e.g. "fluxa_default.test.UserEntity"
```

## Consuming CDC Events

FluxaORM provides helper functions to parse Debezium CDC events from Kafka records.

### ParseDebeziumEvent

`ParseDebeziumEvent` parses a Kafka record into a structured `DebeziumEvent`:

```go
event, err := fluxaorm.ParseDebeziumEvent(record)
if err != nil {
    // handle parse error
}
```

### ParseDebeziumKey

`ParseDebeziumKey` extracts the entity ID from a Debezium event key:

```go
entityID, err := fluxaorm.ParseDebeziumKey(record)
if err != nil {
    // handle parse error
}
```

### DebeziumEvent

The `DebeziumEvent` struct contains the full change event data:

| Field | Type | Description |
|-------|------|-------------|
| `Before` | `map[string]interface{}` | Field values before the change (nil for inserts) |
| `After` | `map[string]interface{}` | Field values after the change (nil for deletes) |
| `Op` | `string` | Operation type (see below) |
| `Source` | `DebeziumSource` | Event metadata (database, table, position, timestamp) |
| `TsMs` | `int64` | Event timestamp in milliseconds |

### Operation Types

The `Op` field indicates the type of change:

| Constant | Value | Description |
|----------|-------|-------------|
| `DebeziumCreate` | `"c"` | A new row was inserted |
| `DebeziumUpdate` | `"u"` | An existing row was updated |
| `DebeziumDelete` | `"d"` | A row was deleted |
| `DebeziumRead` | `"r"` | A snapshot read (initial load) |

## Full Example

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

type UserEntity struct {
    ID    uint64 `orm:"debezium"`
    Name  string `orm:"required;length=255"`
    Email string `orm:"required;length=255"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:pass@tcp(localhost:3306)/mydb", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterKafka([]string{"localhost:9092"}, "kafka", nil)
    registry.RegisterDebeziumConnectURL("http://localhost:8083", "kafka")
    registry.RegisterEntity(&UserEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    ctx := engine.NewContext(context.Background())

    // Sync Debezium connectors
    alters, err := fluxaorm.GetDebeziumAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        fmt.Println(alter.Description)
        err = alter.Exec(ctx)
        if err != nil {
            panic(err)
        }
    }

    // Consume CDC events
    kafka := engine.Kafka("kafka")
    cg := kafka.MustConsumerGroup("my_cdc_consumer")
    defer cg.Close()

    fetches := cg.PollFetches(ctx)
    fetches.EachRecord(func(record *fluxaorm.KafkaRecord) {
        event, err := fluxaorm.ParseDebeziumEvent(record)
        if err != nil {
            fmt.Printf("parse error: %v\n", err)
            return
        }
        entityID, err := fluxaorm.ParseDebeziumKey(record)
        if err != nil {
            fmt.Printf("key parse error: %v\n", err)
            return
        }

        switch event.Op {
        case fluxaorm.DebeziumCreate:
            fmt.Printf("New entity %d: %v\n", entityID, event.After)
        case fluxaorm.DebeziumUpdate:
            fmt.Printf("Updated entity %d: %v -> %v\n", entityID, event.Before, event.After)
        case fluxaorm.DebeziumDelete:
            fmt.Printf("Deleted entity %d\n", entityID)
        }
    })
}
```

::: warning
Debezium CDC events are delivered asynchronously. There may be a short delay between a MySQL write and the corresponding event appearing on the Kafka topic. Do not rely on CDC events for synchronous consistency checks.
:::

::: tip
For the consumer group used to consume Debezium events, register it with the appropriate topic name. Use `DebeziumTopicName()` to get the correct topic name for each entity.
:::
