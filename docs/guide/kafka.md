# Kafka

FluxaORM provides first-class support for Apache Kafka as a data pool type. Under the hood it uses [franz-go](https://github.com/twmb/franz-go), a high-performance pure-Go Kafka client.

A Kafka pool represents a connection to a set of brokers and can contain **multiple consumer groups**, each with its own set of topics and configuration.

## Pool Registration

Register a Kafka pool using the `RegisterKafka` method. The pool accepts pool-level options and one or more consumer group definitions:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// Kafka pool named "events" with one consumer group:
registry.RegisterKafka([]string{"localhost:9092"}, "events", &fluxaorm.KafkaPoolOptions{
    ClientID: "my-service",
}, fluxaorm.KafkaConsumerGroupSettings{Name: "my-group", Topics: []string{"orders", "payments"}})

// Pool with multiple consumer groups:
registry.RegisterKafka([]string{"localhost:9092", "localhost:9093"}, "events", &fluxaorm.KafkaPoolOptions{
    ClientID: "my-service",
},
    fluxaorm.KafkaConsumerGroupSettings{Name: "order-group", Topics: []string{"orders"}},
    fluxaorm.KafkaConsumerGroupSettings{Name: "payment-group", Topics: []string{"payments"}},
)

// Pool with no consumer groups (producer-only):
registry.RegisterKafka([]string{"localhost:9092"}, "events", &fluxaorm.KafkaPoolOptions{
    ClientID: "my-service",
})
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

## KafkaPoolOptions

The `KafkaPoolOptions` struct configures pool-level settings shared by all consumer groups:

```go
type KafkaPoolOptions struct {
    ClientID           string
    RequiredAcks       int
    ProducerLinger     time.Duration
    MaxBufferedRecords int
    SASL               *KafkaSASLConfig
    IgnoredTopics      []string
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ClientID` | `string` | `""` | Client identifier sent to the broker |
| `RequiredAcks` | `int` | `-1` | Broker acknowledgment level: `0` = none, `1` = leader only, `-1` = all in-sync replicas |
| `ProducerLinger` | `time.Duration` | `0` | How long to wait before flushing a produce batch |
| `MaxBufferedRecords` | `int` | `0` | Maximum number of records buffered in the producer |
| `SASL` | `*KafkaSASLConfig` | `nil` | SASL authentication configuration |
| `IgnoredTopics` | `[]string` | `nil` | Topics to exclude from schema management (see [Topic Registration](#topic-registration)) |

## KafkaConsumerGroupSettings

The `KafkaConsumerGroupSettings` struct configures an individual consumer group within the pool:

```go
type KafkaConsumerGroupSettings struct {
    Name               string
    Topics             []string
    SessionTimeout     time.Duration
    RebalanceTimeout   time.Duration
    FetchMaxBytes      int32
    AutoCommitInterval time.Duration
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `Name` | `string` | **required** | Consumer group ID |
| `Topics` | `[]string` | **required** | Topics to consume from |
| `SessionTimeout` | `time.Duration` | `0` | Consumer group session timeout |
| `RebalanceTimeout` | `time.Duration` | `0` | Consumer group rebalance timeout |
| `FetchMaxBytes` | `int32` | `0` | Maximum bytes per fetch response |
| `AutoCommitInterval` | `time.Duration` | `0` | Interval for automatic offset commits; `0` means manual commit |

## Config Structs

When loading configuration from a file, FluxaORM uses the `ConfigKafka`, `ConfigKafkaConsumerGroup`, and `ConfigKafkaTopic` structs:

```go
type ConfigKafkaConsumerGroup struct {
    Name                 string   `yaml:"name"`
    Topics               []string `yaml:"topics"`
    SessionTimeoutMs     int      `yaml:"sessionTimeoutMs"`
    RebalanceTimeoutMs   int      `yaml:"rebalanceTimeoutMs"`
    FetchMaxBytes        int      `yaml:"fetchMaxBytes"`
    AutoCommitIntervalMs int      `yaml:"autoCommitIntervalMs"`
}

type ConfigKafkaTopic struct {
    Name              string            `yaml:"name"`
    Partitions        int32             `yaml:"partitions"`
    ReplicationFactor int16             `yaml:"replicationFactor"`
    Configs           map[string]string `yaml:"configs"`
}

type ConfigKafka struct {
    Code               string                     `yaml:"code"`
    Brokers            []string                   `yaml:"brokers"`
    ClientID           string                     `yaml:"clientID"`
    RequiredAcks       int                        `yaml:"requiredAcks"`
    ProducerLingerMs   int                        `yaml:"producerLingerMs"`
    MaxBufferedRecords int                        `yaml:"maxBufferedRecords"`
    SASLMechanism      string                     `yaml:"saslMechanism"`
    SASLUser           string                     `yaml:"saslUser"`
    SASLPassword       string                     `yaml:"saslPassword"`
    ConsumerGroups     []ConfigKafkaConsumerGroup `yaml:"consumerGroups"`
    IgnoredTopics      []string                   `yaml:"ignoredTopics"`
    Topics             []ConfigKafkaTopic         `yaml:"topics"`
}
```

## Engine Accessor

Once the engine is created, access a Kafka pool via:

```go
pool := engine.Kafka("events")
```

This returns a `Kafka` interface representing the pool. You can produce records directly via the pool, and obtain consumer groups from the pool for consuming records.

## Consumer Groups

Each Kafka pool can have one or more consumer groups. Use the pool-level methods to access them:

### ConsumerGroup

`ConsumerGroup` returns a `KafkaConsumerGroup` and an error. Each call creates a **new `kgo.Client`** connected to the brokers — it is a factory method, not a lookup. The caller is responsible for calling `Close()` on the returned consumer group when done:

```go
cg, err := pool.ConsumerGroup("my-group")
if err != nil {
    // name not registered or connection failed
}
defer cg.Close()
```

### MustConsumerGroup

`MustConsumerGroup` returns a `KafkaConsumerGroup` for the given name and panics if the group is not registered or if the connection fails. Use this when you are certain the group was registered and you want to fail fast on errors:

```go
cg := pool.MustConsumerGroup("my-group")
defer cg.Close()
```

### ConsumerGroupNames

`ConsumerGroupNames` returns the list of registered consumer group names in the pool:

```go
for _, name := range pool.ConsumerGroupNames() {
    fmt.Println(name)
}
```

### Kafka (Pool) Interface

The `Kafka` interface exposes pool-level methods:

| Method | Description |
|--------|-------------|
| `GetCode() string` | Returns the pool code (e.g. `"events"`) |
| `GetBrokers() []string` | Returns the list of broker addresses |
| `GetPoolOptions() *KafkaPoolOptions` | Returns the pool-level options |
| `ProduceSync(ctx Context, records ...*KafkaRecord) error` | Produces records synchronously and blocks until acknowledged |
| `Produce(ctx Context, record *KafkaRecord, callback func(*KafkaRecord, error))` | Produces a record asynchronously with an optional callback |
| `ConsumerGroup(name string) (KafkaConsumerGroup, error)` | Creates a new consumer group client by name; returns error if not registered or connection fails |
| `MustConsumerGroup(name string) KafkaConsumerGroup` | Creates a new consumer group client by name; panics if not registered or connection fails |
| `ConsumerGroupNames() []string` | Returns the list of registered consumer group names |
| `Close()` | Closes the pool-level producer client; consumer groups must be closed individually |

### KafkaConsumerGroup Interface

The `KafkaConsumerGroup` interface exposes per-group methods:

| Method | Description |
|--------|-------------|
| `GetName() string` | Returns the consumer group name |
| `GetSettings() *KafkaConsumerGroupSettings` | Returns the consumer group settings |
| `GetKgoClient() *kgo.Client` | Returns the underlying franz-go client |
| `PollFetches(ctx Context) KafkaFetches` | Polls for new records |
| `CommitUncommittedOffsets(ctx Context) error` | Commits offsets for consumed records |
| `Close()` | Closes this consumer group's client |

## KafkaRecord

`KafkaRecord` represents a single Kafka record (message):

```go
type KafkaRecord struct {
    Topic     string
    Key       []byte
    Value     []byte
    Headers   []KafkaRecordHeader
    Partition int32
    Offset    int64
    Timestamp time.Time
}
```

## KafkaRecordHeader

`KafkaRecordHeader` represents a key-value header attached to a record:

```go
type KafkaRecordHeader struct {
    Key   string
    Value []byte
}
```

## KafkaFetches

`KafkaFetches` is returned by `PollFetches` and provides helper methods for iterating over fetched records:

| Method | Description |
|--------|-------------|
| `Records() []*KafkaRecord` | Returns all records from the fetch as a flat slice |
| `EachRecord(func(*KafkaRecord))` | Iterates over each record, calling the provided function |
| `EachError(func(string, int32, error))` | Iterates over per-partition errors (topic, partition, error) |
| `IsEmpty() bool` | Returns `true` if the fetch contains no records |

## Producing Records

All produce operations are performed through the pool directly. You do not need a consumer group to produce records.

### Synchronous Produce

`ProduceSync` sends one or more records to Kafka and blocks until the broker acknowledges them:

```go
pool := engine.Kafka("events")

record := &fluxaorm.KafkaRecord{
    Topic: "orders",
    Key:   []byte("order-123"),
    Value: []byte(`{"status":"created"}`),
    Headers: []fluxaorm.KafkaRecordHeader{
        {Key: "source", Value: []byte("api")},
    },
}

err := pool.ProduceSync(ctx, record)
if err != nil {
    // handle error
}
```

### Asynchronous Produce

`Produce` sends a record asynchronously. The call returns immediately and the record is buffered for delivery. An optional callback is invoked when the broker acknowledges or rejects the record:

```go
pool := engine.Kafka("events")

record := &fluxaorm.KafkaRecord{
    Topic: "orders",
    Key:   []byte("order-456"),
    Value: []byte(`{"status":"shipped"}`),
}

pool.Produce(ctx, record, func(r *fluxaorm.KafkaRecord, err error) {
    if err != nil {
        log.Printf("produce failed: %v", err)
    }
})
```

## Consuming Records

### PollFetches

`PollFetches` polls the broker for new records. It returns a `KafkaFetches` value:

```go
pool := engine.Kafka("events")
cg := pool.MustConsumerGroup("my-group")
defer cg.Close()

fetches := cg.PollFetches(ctx)
if fetches.IsEmpty() {
    return
}

fetches.EachError(func(topic string, partition int32, err error) {
    log.Printf("fetch error topic=%s partition=%d: %v", topic, partition, err)
})

fetches.EachRecord(func(record *fluxaorm.KafkaRecord) {
    fmt.Printf("topic=%s key=%s value=%s\n", record.Topic, record.Key, record.Value)
})
```

### CommitUncommittedOffsets

After processing records, commit the offsets so they are not re-delivered:

```go
err := cg.CommitUncommittedOffsets(ctx)
if err != nil {
    // handle error
}
```

::: tip
When `AutoCommitInterval` is set to `0` (the default), you must call `CommitUncommittedOffsets` manually after processing each batch. Set a positive `AutoCommitInterval` in `KafkaConsumerGroupSettings` to enable automatic periodic commits.
:::

## Advanced Usage

If you need direct access to the underlying `*kgo.Client` from franz-go, use `GetKgoClient` on a consumer group:

```go
cg := pool.MustConsumerGroup("my-group")
defer cg.Close()
client := cg.GetKgoClient()
// use the franz-go client directly for advanced operations
```

## SASL Authentication

To connect to a Kafka cluster that requires SASL authentication, configure the `SASL` field in `KafkaPoolOptions`. SASL is a pool-level setting shared by all consumer groups:

```go
registry.RegisterKafka([]string{"kafka-broker:9093"}, "secure-events", &fluxaorm.KafkaPoolOptions{
    ClientID: "my-service",
    SASL: &fluxaorm.KafkaSASLConfig{
        Mechanism: "SCRAM-SHA-256",
        User:      "kafka-user",
        Password:  "kafka-password",
    },
}, fluxaorm.KafkaConsumerGroupSettings{Name: "my-group", Topics: []string{"orders"}})
```

`KafkaSASLConfig` supports the following mechanisms:

| Mechanism | Description |
|-----------|-------------|
| `PLAIN` | Simple username/password authentication (not recommended for production without TLS) |
| `SCRAM-SHA-256` | Challenge-response authentication using SHA-256 |
| `SCRAM-SHA-512` | Challenge-response authentication using SHA-512 |

Equivalent YAML:

```yml
secure-events:
  kafka:
    brokers:
      - kafka-broker:9093
    clientID: my-service
    saslMechanism: SCRAM-SHA-256
    saslUser: kafka-user
    saslPassword: kafka-password
    consumerGroups:
      - name: my-group
        topics:
          - orders
```

## Topic Registration

FluxaORM provides schema management for Kafka topics, similar to the [ClickHouse schema management](/guide/clickhouse_schema.html) feature. Define your Kafka topics using a fluent builder API, register them with the registry, and use `GetKafkaAlters()` to compare them with the broker state and apply changes.

### Defining a Kafka Topic

Use `NewKafkaTopic()` to create a topic definition with a fluent builder:

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

topic := fluxaorm.NewKafkaTopic("orders", "default").
    Partitions(6).
    ReplicationFactor(3).
    RetentionMs(86400000).
    CleanupPolicy("delete").
    MinInsyncReplicas(2)
```

### Registering Topics

Register Kafka topic definitions with the registry before calling `Validate()`:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterKafka([]string{"localhost:9092"}, "default", nil)

registry.RegisterKafkaTopic(
    fluxaorm.NewKafkaTopic("orders", "default").
        Partitions(6).
        ReplicationFactor(3).
        RetentionMs(86400000).
        CleanupPolicy("delete").
        MinInsyncReplicas(2),
)

registry.RegisterKafkaTopic(
    fluxaorm.NewKafkaTopic("payments", "default").
        Partitions(3).
        ReplicationFactor(3).
        RetentionBytes(1073741824).
        MaxMessageBytes(1048576),
)

engine, err := registry.Validate()
```

### Builder API Reference

All builder methods return `*KafkaTopicBuilder` for fluent chaining:

| Method | Description |
|--------|-------------|
| `Partitions(n int32)` | Number of partitions for the topic |
| `ReplicationFactor(n int16)` | Replication factor for the topic |
| `RetentionMs(ms int64)` | Message retention time in milliseconds (`retention.ms`) |
| `RetentionBytes(bytes int64)` | Maximum retained bytes per partition (`retention.bytes`) |
| `MaxMessageBytes(bytes int32)` | Maximum message size in bytes (`max.message.bytes`) |
| `CleanupPolicy(policy string)` | Cleanup policy: `"delete"`, `"compact"`, or `"delete,compact"` (`cleanup.policy`) |
| `MinInsyncReplicas(n int)` | Minimum number of in-sync replicas (`min.insync.replicas`) |
| `CompressionType(ct string)` | Compression type: `"none"`, `"gzip"`, `"snappy"`, `"lz4"`, `"zstd"` (`compression.type`) |
| `Config(key, value string)` | Set any arbitrary topic configuration key-value pair |

The convenience methods (`RetentionMs`, `CleanupPolicy`, etc.) are shorthand for common `Config()` calls.

### Getting Topic Alters

Use `GetKafkaAlters()` to compare registered topic definitions with the actual Kafka broker state and get the pending operations:

```go
ctx := engine.NewContext(context.Background())

alters, err := fluxaorm.GetKafkaAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    fmt.Println(alter.Description) // e.g. "Create topic 'orders' with 6 partitions"
    fmt.Println(alter.Pool)        // e.g. "default"
}
```

Each `fluxaorm.KafkaAlter` has the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `Description` | `string` | Human-readable description of the pending operation |
| `Pool` | `string` | The Kafka pool code this alter belongs to |

To execute all alters:

```go
for _, alter := range alters {
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

### What Gets Compared

`GetKafkaAlters()` generates the following types of operations:

| Scenario | Operation |
|----------|-----------|
| Topic not on broker | Create topic with registered partitions, replication factor, and configs |
| Registered partitions > current partitions | Increase partition count |
| Registered partitions < current partitions | Warning (partitions cannot be decreased) |
| Replication factor differs | Warning (replication factor cannot be changed via admin API) |
| Topic config differs from registered values | Alter topic configuration |
| Topic on broker but not registered | Delete topic |

::: warning
Kafka does **not** support decreasing the number of partitions or changing the replication factor of an existing topic. If these differ, `GetKafkaAlters()` returns a warning description but no executable operation for these changes.
:::

::: warning
FluxaORM deletes all topics on the broker that are not registered, excluding internal topics (those starting with `__`) and topics listed in `IgnoredTopics`. See [Ignored Topics](#ignored-topics) for how to protect topics from deletion.
:::

### Ignored Topics

By default, `GetKafkaAlters()` will attempt to delete topics on the broker that are not registered via `RegisterKafkaTopic()`. Internal Kafka topics (those starting with `__`, such as `__consumer_offsets`) are always excluded automatically.

To protect additional topics from deletion, list them in the `IgnoredTopics` field of `KafkaPoolOptions`:

```go
registry.RegisterKafka([]string{"localhost:9092"}, "default", &fluxaorm.KafkaPoolOptions{
    IgnoredTopics: []string{"legacy-topic", "external-service-topic"},
})
```

Equivalent YAML:

```yml
default:
  kafka:
    brokers:
      - localhost:9092
    ignoredTopics:
      - legacy-topic
      - external-service-topic
```

### Backward Compatibility

Topic schema management is **opt-in** and fully backward compatible:

- If no topics are registered for a Kafka pool via `RegisterKafkaTopic()`, auto-topic creation remains enabled and `GetKafkaAlters()` will not manage topics for that pool.
- Once you register at least one topic for a pool, `GetKafkaAlters()` takes over topic management for that pool, including deleting unregistered topics.
- Pools with no registered topics will have all non-internal, non-ignored topics flagged for deletion by `GetKafkaAlters()`.

### YAML Configuration

Topics can also be defined in YAML configuration under the `topics` key within a Kafka pool:

```yml
default:
  kafka:
    brokers:
      - "localhost:9092"
    ignoredTopics:
      - "legacy-topic"
    topics:
      - name: "orders"
        partitions: 6
        replicationFactor: 3
        configs:
          retention.ms: "86400000"
          cleanup.policy: "delete"
          min.insync.replicas: "2"
      - name: "payments"
        partitions: 3
        replicationFactor: 3
        configs:
          retention.bytes: "1073741824"
```

### Struct Configuration

Topics can be defined using the `ConfigKafkaTopic` struct within `ConfigKafka`:

```go
config := &fluxaorm.Config{
    KafkaPools: []fluxaorm.ConfigKafka{
        {
            Code:    "default",
            Brokers: []string{"localhost:9092"},
            IgnoredTopics: []string{"legacy-topic"},
            Topics: []fluxaorm.ConfigKafkaTopic{
                {
                    Name:              "orders",
                    Partitions:        6,
                    ReplicationFactor: 3,
                    Configs: map[string]string{
                        "retention.ms":         "86400000",
                        "cleanup.policy":       "delete",
                        "min.insync.replicas":  "2",
                    },
                },
            },
        },
    },
}

err := registry.InitByConfig(config)
```

### Full Example

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterKafka([]string{"localhost:9092"}, "default", &fluxaorm.KafkaPoolOptions{
        IgnoredTopics: []string{"legacy-topic"},
    })

    // Define topics
    registry.RegisterKafkaTopic(
        fluxaorm.NewKafkaTopic("orders", "default").
            Partitions(6).
            ReplicationFactor(3).
            RetentionMs(86400000).
            CleanupPolicy("delete").
            MinInsyncReplicas(2),
    )

    registry.RegisterKafkaTopic(
        fluxaorm.NewKafkaTopic("payments", "default").
            Partitions(3).
            ReplicationFactor(3).
            RetentionBytes(1073741824).
            CompressionType("snappy"),
    )

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    ctx := engine.NewContext(context.Background())

    // Get and apply alters
    alters, err := fluxaorm.GetKafkaAlters(ctx)
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
}
```

::: tip
Call `GetKafkaAlters()` alongside `GetAlters()`, `GetRedisSearchAlters()`, and `GetClickhouseAlters()` in your migration flow to keep all data stores in sync.
:::

## Closing

The pool and consumer groups have separate lifecycles and must be closed independently.

### Closing Consumer Groups

Each call to `ConsumerGroup` or `MustConsumerGroup` creates a new `kgo.Client`. The caller is responsible for closing it when done:

```go
cg := pool.MustConsumerGroup("my-group")
defer cg.Close()
// ... consume records ...
```

### Closing the Pool

Calling `Close` on the pool closes only the pool-level producer client. It does **not** close any consumer groups — those must be closed individually by the caller:

```go
pool.Close()
```

::: tip
If you are using FluxaORM's engine lifecycle, the engine will close all Kafka pools when it shuts down. However, consumer groups you created must still be closed by your own code.
:::
