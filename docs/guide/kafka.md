# Kafka

FluxaORM provides first-class support for Apache Kafka as a data pool type. Under the hood it uses [franz-go](https://github.com/twmb/franz-go), a high-performance pure-Go Kafka client.

## Pool Registration

Register a Kafka pool using the `RegisterKafka` method:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// Kafka pool named "events" with default options:
registry.RegisterKafka([]string{"localhost:9092"}, "events", nil)

// Pool with custom options:
registry.RegisterKafka([]string{"localhost:9092", "localhost:9093"}, "events", &fluxaorm.KafkaOptions{
    ClientID:      "my-service",
    ConsumerGroup: "my-group",
    ConsumeTopics: []string{"orders", "payments"},
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
    consumerGroup: my-group
    consumeTopics:
      - orders
      - payments
```

## KafkaOptions

The `KafkaOptions` struct lets you configure the Kafka client:

```go
type KafkaOptions struct {
    ClientID           string
    ConsumerGroup      string
    ConsumeTopics      []string
    RequiredAcks       int
    ProducerLinger     time.Duration
    MaxBufferedRecords int
    SessionTimeout     time.Duration
    RebalanceTimeout   time.Duration
    FetchMaxBytes      int32
    AutoCommitInterval time.Duration
    SASL               *KafkaSASLConfig
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ClientID` | `string` | `""` | Client identifier sent to the broker |
| `ConsumerGroup` | `string` | `""` | Consumer group ID for group consumption |
| `ConsumeTopics` | `[]string` | `nil` | Topics to consume from |
| `RequiredAcks` | `int` | `-1` | Broker acknowledgment level: `0` = none, `1` = leader only, `-1` = all in-sync replicas |
| `ProducerLinger` | `time.Duration` | `0` | How long to wait before flushing a produce batch |
| `MaxBufferedRecords` | `int` | `0` | Maximum number of records buffered in the producer |
| `SessionTimeout` | `time.Duration` | `0` | Consumer group session timeout |
| `RebalanceTimeout` | `time.Duration` | `0` | Consumer group rebalance timeout |
| `FetchMaxBytes` | `int32` | `0` | Maximum bytes per fetch response |
| `AutoCommitInterval` | `time.Duration` | `0` | Interval for automatic offset commits; `0` means manual commit |
| `SASL` | `*KafkaSASLConfig` | `nil` | SASL authentication configuration |

## Config Struct

When loading configuration from a file, FluxaORM uses the `ConfigKafka` struct:

```go
type ConfigKafka struct {
    Brokers            []string
    ClientID           string
    ConsumerGroup      string
    ConsumeTopics      []string
    RequiredAcks       int
    ProducerLinger     time.Duration
    MaxBufferedRecords int
    SessionTimeout     time.Duration
    RebalanceTimeout   time.Duration
    FetchMaxBytes      int32
    AutoCommitInterval time.Duration
    SASL               *KafkaSASLConfig
}
```

## Engine Accessor

Once the engine is created, access a Kafka pool via:

```go
kafka := engine.Kafka("events")
```

This returns a `Kafka` interface that exposes the methods described below.

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

### Synchronous Produce

`ProduceSync` sends one or more records to Kafka and blocks until the broker acknowledges them:

```go
kafka := engine.Kafka("events")

record := &fluxaorm.KafkaRecord{
    Topic: "orders",
    Key:   []byte("order-123"),
    Value: []byte(`{"status":"created"}`),
    Headers: []fluxaorm.KafkaRecordHeader{
        {Key: "source", Value: []byte("api")},
    },
}

err := kafka.ProduceSync(ctx, record)
if err != nil {
    // handle error
}
```

### Asynchronous Produce

`Produce` sends a record asynchronously. The call returns immediately and the record is buffered for delivery:

```go
kafka := engine.Kafka("events")

record := &fluxaorm.KafkaRecord{
    Topic: "orders",
    Key:   []byte("order-456"),
    Value: []byte(`{"status":"shipped"}`),
}

kafka.Produce(ctx, record)
```

## Consuming Records

### PollFetches

`PollFetches` polls the broker for new records. It returns a `KafkaFetches` value:

```go
kafka := engine.Kafka("events")

fetches := kafka.PollFetches(ctx)
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
err := kafka.CommitUncommittedOffsets(ctx)
if err != nil {
    // handle error
}
```

::: tip
When `AutoCommitInterval` is set to `0` (the default), you must call `CommitUncommittedOffsets` manually after processing each batch. Set a positive `AutoCommitInterval` to enable automatic periodic commits.
:::

## Advanced Usage

If you need direct access to the underlying `*kgo.Client` from franz-go, use `GetKgoClient`:

```go
client := kafka.GetKgoClient()
// use the franz-go client directly for advanced operations
```

## SASL Authentication

To connect to a Kafka cluster that requires SASL authentication, configure the `SASL` field in `KafkaOptions`:

```go
registry.RegisterKafka([]string{"kafka-broker:9093"}, "secure-events", &fluxaorm.KafkaOptions{
    ClientID:      "my-service",
    ConsumerGroup: "my-group",
    ConsumeTopics: []string{"orders"},
    SASL: &fluxaorm.KafkaSASLConfig{
        Mechanism: "SCRAM-SHA-256",
        User:      "kafka-user",
        Password:  "kafka-password",
    },
})
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
    consumerGroup: my-group
    consumeTopics:
      - orders
    sasl:
      mechanism: SCRAM-SHA-256
      user: kafka-user
      password: kafka-password
```

## Closing the Client

When you are done using a Kafka pool, call `Close` to release all resources (connections, goroutines, buffers):

```go
kafka.Close()
```

::: tip
If you are using FluxaORM's engine lifecycle, the engine will close all Kafka clients when it shuts down. You only need to call `Close` manually if you are managing the Kafka client outside of the engine lifecycle.
:::
