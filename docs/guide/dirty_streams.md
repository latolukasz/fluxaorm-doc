# Dirty Streams

Dirty Streams automatically publish entity change events to Redis Streams whenever entities are inserted, updated, or deleted. This enables cross-service event-driven architectures built on the existing [Event Broker](/guide/event_broker).

## Tag Syntax

Dirty streams are configured with an entity-level tag on the `ID` field:

```
dirtyStream=<Name>/<redisPool>/<ops>
```

| Part | Description |
|:-----|:------------|
| `<Name>` | Stream name |
| `<redisPool>` | Redis pool code. Leave empty to use the entity's default Redis pool. |
| `<ops>` | Combination of `I` (insert), `U` (update), `D` (delete). Defaults to `IUD` if omitted. |

Multiple streams are separated by commas:

```go
ID uint64 `orm:"dirtyStream=UserStream,AuditStream//I"`
```

### Shorthand Examples

- `dirtyStream=MyStream` -- all ops (`IUD`), default pool
- `dirtyStream=MyStream//ID` -- insert + delete, default pool
- `dirtyStream=MyStream/cache1/U` -- update only, pool `cache1`

## Field-Level Triggers

Individual fields can specify which streams they trigger on UPDATE:

```go
Status string `orm:"required;enum=active,banned;dirtyStream=UserStatusStream"`
Age    uint32 `orm:"dirtyStream=UserStatusStream,AuditStream"`
```

When a field tagged with `dirtyStream` changes during an UPDATE, the listed streams will publish an event -- even if those streams do not have `U` in their entity-level ops.

::: warning
The stream must be declared on the `ID` field first. Field-level tags reference streams by name only.
:::

## Decision Logic

The following table summarizes when each stream publishes an event:

| Operation | Publishes when... |
|:----------|:------------------|
| INSERT | Stream has `I` in ops |
| DELETE | Stream has `D` in ops |
| UPDATE | Stream has `U` in ops (always publishes), OR any field tagged with this stream changed |

## Full Example

```go
type UserEntity struct {
    ID     uint64 `orm:"dirtyStream=UserStream,UserStatusStream//ID"`
    Name   string `orm:"required"`
    Status string `orm:"required;enum=active,banned;dirtyStream=UserStatusStream"`
    Age    uint8
}
```

- **UserStream** -- publishes on INSERT, UPDATE, and DELETE (default `IUD` ops).
- **UserStatusStream** -- publishes on INSERT and DELETE (from the `ID` ops), plus UPDATE only when `Status` changes (from the field-level tag).

## Stream Registration

Dirty streams are automatically registered with the Event Broker during `registry.Validate()`. No manual `RegisterRedisStream()` call is needed.

## Event Payload

Each dirty stream event is serialized using msgpack with the following structure:

```go
type DirtyStreamEvent struct {
    EntityType string                      `msgpack:"et"`           // table name
    EntityID   uint64                      `msgpack:"id"`
    FlushType  uint8                       `msgpack:"ft"`           // 1=insert, 2=update, 3=delete
    Changes    map[string]DirtyFieldChange `msgpack:"ch,omitempty"` // field -> old+new (update only)
}

type DirtyFieldChange struct {
    Old AsyncSQLParam `msgpack:"o"`
    New AsyncSQLParam `msgpack:"n"`
}
```

### FlushType Constants

```go
const (
    DirtyStreamInsert uint8 = 1  // fluxaorm.DirtyStreamInsert
    DirtyStreamUpdate uint8 = 2  // fluxaorm.DirtyStreamUpdate
    DirtyStreamDelete uint8 = 3  // fluxaorm.DirtyStreamDelete
)
```

### DirtyFieldChange Helpers

`DirtyFieldChange` provides two helper methods for extracting typed values:

| Method | Description |
|:-------|:------------|
| `OldValue() any` | Returns the old value as a Go type |
| `NewValue() any` | Returns the new value as a Go type |

## Consuming Events

Code generation creates a `DirtyStreams` variable with typed helpers for each stream:

```go
// Generated code
var DirtyStreams = dirtyStreamConsumers{
    UserStream:       dirtyStreamHelper{streamName: "UserStream"},
    UserStatusStream: dirtyStreamHelper{streamName: "UserStatusStream"},
}
```

Each helper provides:

| Method | Description |
|:-------|:------------|
| `ConsumeSingle(ctx) (EventsConsumer, error)` | Creates a single-instance consumer |
| `ConsumeMany(ctx) (EventsConsumer, error)` | Creates a multi-instance consumer |
| `Name() string` | Returns the stream name |

### Example Consumer

```go
consumer, err := entities.DirtyStreams.UserStatusStream.ConsumeSingle(ctx)
if err != nil {
    return err
}
err = consumer.Consume(100, 5*time.Second, func(events []fluxaorm.Event) error {
    for _, ev := range events {
        var dirty fluxaorm.DirtyStreamEvent
        ev.Unserialize(&dirty)
        fmt.Println(dirty.EntityType, dirty.EntityID, dirty.FlushType)
        for field, change := range dirty.Changes {
            fmt.Println(field, change.OldValue(), "->", change.NewValue())
        }
    }
    return nil
})
```

For more details on consumer behavior, acknowledgment, and auto-claiming, see the [Event Broker](/guide/event_broker) documentation.

## Async Flush Support

Dirty streams work with both `Flush()` (synchronous) and `FlushAsync()`. When using `FlushAsync()`, dirty stream events are serialized into the async SQL operation and published by the consumer after SQL execution succeeds. See [Async Flush](/guide/async_flush) for more details on async processing.
