# Event Broker

FluxaORM provides an event broker built on top of [Redis Streams](https://redis.io/docs/data-types/streams/). It lets you publish events to named streams and consume them with single or multiple parallel consumers, all with built-in consumer groups, acknowledgment, and statistics.

## Registering a Redis Stream

Before you can publish or consume events, each stream must be registered with a Redis pool during registry setup:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterRedis("localhost:6379", 0, "default", nil)

// Register streams on the "default" Redis pool
registry.RegisterRedisStream("user-events", "default")
registry.RegisterRedisStream("order-events", "default")

engine, err := registry.Validate()
```

`RegisterRedisStream(name, redisPool)` associates the stream name with a Redis pool. Every stream you plan to publish to or consume from must be registered this way before calling `Validate()`.

## Publishing Events

There are two ways to publish events: directly through the `EventBroker`, or in batches through an `EventFlusher`.

### Direct Publish

Use `Publish` on the `EventBroker` when you need the stream message ID back immediately:

```go
ctx := engine.NewContext(context.Background())
broker := ctx.GetEventBroker()

type OrderEvent struct {
    UserID    uint64
    ProductID uint64
    Quantity  int
}

event := OrderEvent{UserID: 1, ProductID: 42, Quantity: 3}

// Publish a struct (serialized automatically via msgpack)
id, err := broker.Publish("order-events", event)

// Publish with additional metadata tags (key-value pairs)
id, err = broker.Publish("order-events", event, "action", "created", "priority", "high")
```

The `body` argument can be any value that is serializable with msgpack. It will be automatically serialized when published and can be deserialized on the consumer side with `event.Unserialize()`.

The optional `meta` variadic arguments are string key-value pairs added as extra fields on the Redis Stream message. They can be read on the consumer side using `event.Tag(key)`.

### Batch Publish with EventFlusher

Use `NewFlusher()` when you want to batch multiple events and send them all at once using a Redis pipeline, which is more efficient for high-throughput scenarios:

```go
broker := ctx.GetEventBroker()
flusher := broker.NewFlusher()

for i := 0; i < 100; i++ {
    err := flusher.Publish("user-events", UserEvent{Action: "login", UserID: uint64(i)})
    if err != nil {
        // serialization error
        log.Fatal(err)
    }
}

// Send all buffered events to Redis in one pipeline call
err := flusher.Flush()
```

`Flush()` groups events by their target Redis pool and sends each group via a Redis pipeline for optimal performance. After flushing, the internal buffer is cleared so the flusher can be reused.

## Consuming Events

Consumers read events from a stream using Redis consumer groups. FluxaORM automatically creates the consumer group (`consumer_group`) when the consumer first reads from the stream.

### Single Consumer

Use `ConsumerSingle` when you need exactly one consumer processing messages in order:

```go
broker := ctx.GetEventBroker()

consumer, err := broker.ConsumerSingle(ctx, "order-events")
if err != nil {
    log.Fatal(err)
}
defer consumer.Cleanup()

err = consumer.Consume(10, 5*time.Second, func(events []fluxaorm.Event) error {
    for _, event := range events {
        var order OrderEvent
        err := event.Unserialize(&order)
        if err != nil {
            return err
        }
        fmt.Printf("Order from user %d for product %d\n", order.UserID, order.ProductID)
    }
    return nil
})
```

`ConsumerSingle` creates a consumer with the fixed name `consumer-single`. This guarantees that only one consumer reads the stream, and events are processed from oldest to newest.

The `Consume` method takes three arguments:

| Parameter | Type | Description |
|:----------|:-----|:------------|
| `count` | `int` | Maximum number of messages to read per call |
| `blockTime` | `time.Duration` | How long to block waiting for new messages |
| `handler` | `func([]Event) error` | Callback that processes the batch of events |

### Multiple Consumers

Use `ConsumerMany` when you need parallel processing across several consumers:

```go
broker := ctx.GetEventBroker()

for i := 0; i < 3; i++ {
    go func() {
        consumer, err := broker.ConsumerMany(ctx, "user-events")
        if err != nil {
            log.Fatal(err)
        }
        defer consumer.Cleanup()

        err = consumer.Consume(5, 10*time.Second, func(events []fluxaorm.Event) error {
            for _, event := range events {
                var u UserEvent
                err := event.Unserialize(&u)
                if err != nil {
                    return err
                }
                fmt.Printf("[%s] processed user event: %+v\n", consumer.Name(), u)
            }
            return nil
        })
        if err != nil {
            log.Println(err)
        }
    }()
}
```

Each `ConsumerMany` consumer receives an auto-generated unique name that includes the current timestamp and a random number (e.g., `consumer-2026_02_28_14_30_00-8734529182374`). You can retrieve the name with `consumer.Name()`. Event order is **not** guaranteed across consumers.

### Acknowledgment

When your handler returns `nil`, all events that were **not** explicitly acknowledged inside the handler are automatically acknowledged and deleted from the stream after the handler completes.

You can also acknowledge events manually inside the handler using `event.Ack()`:

```go
err = consumer.Consume(10, 5*time.Second, func(events []fluxaorm.Event) error {
    for _, event := range events {
        err := processEvent(event)
        if err != nil {
            // Skip this event — it will still be auto-acked
            // when the handler returns nil
            continue
        }
        // Acknowledge immediately
        err = event.Ack()
        if err != nil {
            return err
        }
    }
    return nil
})
```

If the handler returns an error, no automatic acknowledgment happens. The unacknowledged events remain pending in the consumer group and can be reclaimed later.

### Auto-Claiming Pending Events

When running multiple consumers, some consumers may crash or disconnect before acknowledging their messages. Use `AutoClaim` to reclaim those pending messages:

```go
consumer, err := broker.ConsumerMany(ctx, "order-events")
if err != nil {
    log.Fatal(err)
}
defer consumer.Cleanup()

// Claim pending messages that have been idle for more than 10 minutes,
// up to 1000 messages per iteration
err = consumer.AutoClaim(1000, 10*time.Minute, func(events []fluxaorm.Event) error {
    for _, event := range events {
        var order OrderEvent
        err := event.Unserialize(&order)
        if err != nil {
            return err
        }
        // reprocess the event
    }
    return nil
})
```

`AutoClaim` iterates through all pending messages that have been unacknowledged for longer than `minIdle`. It processes them in batches and continues until there are no more eligible pending messages.

### Cleanup

Always call `consumer.Cleanup()` when a consumer is done (typically via `defer`). This removes the consumer from the Redis consumer group:

```go
consumer, err := broker.ConsumerSingle(ctx, "order-events")
if err != nil {
    log.Fatal(err)
}
defer consumer.Cleanup()
```

## Event Interface

Each event passed to the consumer handler implements the `Event` interface:

```go
type Event interface {
    Ack() error
    ID() string
    Tag(key string) (value string)
    Unserialize(val interface{}) error
}
```

| Method | Description |
|:-------|:------------|
| `Ack()` | Manually acknowledge and delete the event from the stream. Safe to call multiple times (no-op after first call). |
| `ID()` | Returns the Redis Stream message ID (e.g., `1709136000000-0`). |
| `Tag(key)` | Returns the value of a metadata tag set during publishing. Returns an empty string if the key does not exist. |
| `Unserialize(val)` | Deserializes the event body (msgpack) into the provided pointer. |

## Stream Statistics

The event broker provides methods to inspect stream health and consumer group status:

```go
broker := ctx.GetEventBroker()

// Get statistics for a single stream
stats, err := broker.GetStreamStatistics("order-events")
if stats != nil {
    fmt.Printf("Stream: %s\n", stats.Stream)
    fmt.Printf("Redis pool: %s\n", stats.RedisPool)
    fmt.Printf("Length: %d\n", stats.Len)
    fmt.Printf("Oldest pending event age: %d seconds\n", stats.OldestEventSeconds)
}

// Get statistics for multiple streams at once
allStats, err := broker.GetStreamsStatistics("order-events", "user-events")

// Get statistics for all registered streams (no arguments)
allStats, err = broker.GetStreamsStatistics()
```

### RedisStreamStatistics

| Field | Type | Description |
|:------|:-----|:------------|
| `Stream` | `string` | Stream name |
| `RedisPool` | `string` | Redis pool code the stream is registered on |
| `Len` | `uint64` | Total number of messages in the stream |
| `OldestEventSeconds` | `int` | Age in seconds of the oldest pending (unacknowledged) event |
| `Group` | `*RedisStreamGroupStatistics` | Consumer group statistics (nil if no group exists) |

### RedisStreamGroupStatistics

| Field | Type | Description |
|:------|:-----|:------------|
| `Group` | `string` | Consumer group name |
| `Lag` | `int64` | Number of entries in the stream that are yet to be delivered |
| `Pending` | `uint64` | Number of pending (delivered but unacknowledged) messages |
| `LastDeliveredID` | `string` | ID of the last message delivered to the group |
| `LastDeliveredDuration` | `time.Duration` | Time elapsed since the last delivered message |
| `LowerID` | `string` | ID of the oldest pending message |
| `LowerDuration` | `time.Duration` | Time elapsed since the oldest pending message |
| `Consumers` | `[]*RedisStreamConsumerStatistics` | Per-consumer statistics |

### RedisStreamConsumerStatistics

| Field | Type | Description |
|:------|:-----|:------------|
| `Name` | `string` | Consumer name |
| `Pending` | `uint64` | Number of pending messages for this consumer |
