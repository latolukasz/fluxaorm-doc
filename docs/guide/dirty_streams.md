# Dirty Streams

FluxaORM provides a mechanism to track entity changes (inserts, updates, and deletes) using Redis Streams. When an entity is modified and flushed, events are automatically published to registered Redis Streams. Consumers can then process these events asynchronously.

## Registering Redis Streams

Before dirty streams can be used, the underlying Redis Stream must be registered using `registry.RegisterRedisStream()`:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
registry.RegisterRedisStream("dirty_AllChanges", fluxaorm.DefaultPoolCode)
```

The first argument is the stream name, and the second is the Redis pool code where the stream will be stored.

::: tip
When you define `dirty` tags on entities, FluxaORM automatically registers the corresponding `dirty_` prefixed streams during `registry.Validate()`. You only need to call `RegisterRedisStream()` manually for custom (non-dirty) streams.
:::

## Defining Dirty Streams on Entities

Use the `dirty` struct tag on entity fields to declare which streams receive events when the entity changes. The tag is placed on the `ID` field (for insert/update/delete triggers) or on specific fields (for update-only triggers when that field changes).

```go
type UserEntity struct {
    ID    uint64 `orm:"dirty=AllChanges,NewUsers:add,DeletedUsers:delete,EmailChanged:add"`
    Name  string
    Email string `orm:"dirty=EmailChanged"`
}

type ProductEntity struct {
    ID    uint32 `orm:"dirty=AllChanges,ProductAddedDeleted:add|delete"`
    Name  string
    Price float64
}
```

This example creates five dirty Redis Streams (all automatically prefixed with `dirty_`):

- `dirty_AllChanges` -- triggered when `UserEntity` or `ProductEntity` is inserted, updated, or deleted
- `dirty_NewUsers` -- triggered when `UserEntity` is inserted
- `dirty_DeletedUsers` -- triggered when `UserEntity` is deleted
- `dirty_EmailChanged` -- triggered when `UserEntity` is inserted or when `Email` is changed
- `dirty_ProductAddedDeleted` -- triggered when `ProductEntity` is inserted or deleted

### Tag Syntax

On the `ID` field, the syntax is:

```
dirty=StreamName              // triggers on add, edit, delete
dirty=StreamName:add          // triggers only on add
dirty=StreamName:delete       // triggers only on delete
dirty=StreamName:add|delete   // triggers on add and delete
```

On other fields, the syntax is:

```
dirty=StreamName              // triggers on edit (when this field changes)
```

You can specify multiple streams separated by commas:

```
dirty=Stream1,Stream2:add,Stream3:delete
```

## Publishing Events

When entities are flushed (via `ctx.Flush()`), FluxaORM automatically publishes dirty events to the appropriate Redis Streams based on the entity's `dirty` tag configuration. This happens transparently as part of the flush pipeline.

## The Event Broker

The `EventBroker` is the central interface for working with Redis Streams. You can access it from the context:

```go
broker := ctx.GetEventBroker()
```

The `EventBroker` interface provides the following methods:

```go
type EventBroker interface {
    Publish(stream string, body interface{}, meta ...string) (id string, err error)
    ConsumerSingle(ctx fluxaorm.Context, stream string) (EventsConsumer, error)
    ConsumerMany(ctx fluxaorm.Context, stream string) (EventsConsumer, error)
    NewFlusher() EventFlusher
    GetStreamsStatistics(stream ...string) ([]*RedisStreamStatistics, error)
    GetStreamStatistics(stream string) (*RedisStreamStatistics, error)
}
```

### Publishing Custom Events

You can also publish events manually to any registered stream:

```go
broker := ctx.GetEventBroker()

type OrderEvent struct {
    OrderID uint64
    Status  string
}

id, err := broker.Publish("my-stream", OrderEvent{OrderID: 123, Status: "completed"})
```

The `body` is serialized using MessagePack. You can also pass optional key-value metadata as additional string arguments:

```go
id, err := broker.Publish("my-stream", body, "key1", "value1", "key2", "value2")
```

### Batch Publishing with EventFlusher

For better performance when publishing many events, use `EventFlusher` to batch events and send them in a single Redis pipeline:

```go
flusher := broker.NewFlusher()

for i := 0; i < 100; i++ {
    err := flusher.Publish("my-stream", MyEvent{ID: i})
    if err != nil {
        panic(err)
    }
}

err := flusher.Flush() // sends all 100 events in one pipeline call
```

## Consuming Events

FluxaORM provides two consumer types:

- `ConsumerSingle` -- creates a single consumer named `consumer-single`. Only one instance should run at a time for a given stream.
- `ConsumerMany` -- creates a consumer with a unique, randomly generated name. Multiple instances can run in parallel to scale consumption.

### Single Consumer

```go
broker := ctx.GetEventBroker()

consumer, err := broker.ConsumerSingle(ctx, "test-stream")
if err != nil {
    panic(err)
}
defer consumer.Cleanup()

err = consumer.Consume(100, 5*time.Second, func(events []fluxaorm.Event) error {
    for _, event := range events {
        event.ID()                     // Redis stream message ID
        event.Tag("key1")             // read a metadata tag
        var data MyStruct
        err := event.Unserialize(&data) // deserialize the body
        if err != nil {
            return err
        }
    }
    return nil
})
```

The `Consume` method accepts:
1. `count` -- maximum number of events to process per batch
2. `blockTime` -- how long to block waiting for new events
3. `handler` -- callback function that receives a slice of events

### Multiple Consumers

When a single consumer cannot keep up, use `ConsumerMany` to run multiple consumers in parallel. Each consumer receives a different subset of events from the same stream:

```go
broker := ctx.GetEventBroker()

consumer1, err := broker.ConsumerMany(ctx, "my-stream")
if err != nil {
    panic(err)
}
defer consumer1.Cleanup()

consumer2, err := broker.ConsumerMany(ctx, "my-stream")
if err != nil {
    panic(err)
}
defer consumer2.Cleanup()

go func() {
    err := consumer1.Consume(100, 5*time.Second, func(events []fluxaorm.Event) error {
        // process events...
        return nil
    })
    if err != nil {
        panic(err)
    }
}()

go func() {
    err := consumer2.Consume(100, 5*time.Second, func(events []fluxaorm.Event) error {
        // process events...
        return nil
    })
    if err != nil {
        panic(err)
    }
}()
```

## Event Interface

Each event passed to the handler implements the `Event` interface:

```go
type Event interface {
    Ack() error
    ID() string
    Tag(key string) (value string)
    Unserialize(val interface{}) error
}
```

| Method | Description |
|--------|-------------|
| `ID()` | Returns the Redis stream message ID |
| `Tag(key)` | Returns the value of a metadata tag set during publishing |
| `Unserialize(val)` | Deserializes the MessagePack-encoded body into the provided value |
| `Ack()` | Manually acknowledges the event (removes it from the pending list) |

### Automatic Acknowledgment

By default, all events passed to the handler function are automatically acknowledged (and deleted from the stream) when the handler returns without error. If you want to acknowledge an event earlier, call `event.Ack()` inside the handler:

```go
err = consumer.Consume(100, 5*time.Second, func(events []fluxaorm.Event) error {
    for _, event := range events {
        // process event...
        err := event.Ack() // acknowledge immediately
        if err != nil {
            return err
        }
    }
    return nil
})
```

## Auto-Claiming Pending Events

If a consumer crashes or fails to process events, those events remain in the pending list. Use `AutoClaim` to reclaim and reprocess pending events that have been idle for longer than a specified duration:

```go
consumer, err := broker.ConsumerMany(ctx, "my-stream")
if err != nil {
    panic(err)
}
defer consumer.Cleanup()

err = consumer.AutoClaim(1000, 5*time.Second, func(events []fluxaorm.Event) error {
    // reprocess claimed events...
    return nil
})
```

`AutoClaim` accepts:
1. `count` -- maximum number of pending events to claim per batch
2. `minIdle` -- minimum idle time before an event can be claimed
3. `handler` -- callback function to process the claimed events

## Stream Statistics

Use the `EventBroker` to retrieve statistics about registered streams:

```go
broker := ctx.GetEventBroker()

// Single stream
stat, err := broker.GetStreamStatistics("dirty_AllChanges")
if stat != nil {
    stat.Stream             // stream name
    stat.RedisPool          // Redis pool code
    stat.Len                // number of messages in the stream
    stat.OldestEventSeconds // seconds since the oldest pending event
    if stat.Group != nil {
        stat.Group.Group                 // consumer group name
        stat.Group.Lag                   // group lag
        stat.Group.Pending               // total pending messages
        stat.Group.LastDeliveredID       // last delivered message ID
        stat.Group.LastDeliveredDuration // time since last delivered message
        stat.Group.LowerID               // lowest pending message ID
        stat.Group.LowerDuration         // time since lowest pending message
        for _, c := range stat.Group.Consumers {
            c.Name    // consumer name
            c.Pending // pending messages for this consumer
        }
    }
}

// Multiple streams
stats, err := broker.GetStreamsStatistics("dirty_AllChanges", "dirty_NewUsers")
```
