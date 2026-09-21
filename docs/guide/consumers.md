---
description: "FluxaORM consumers: declare a ConsumerDef, generate a typed consumer with per-entity and per-task handlers, run the fetch loop and replay events."
---

# Consumers

A consumer is a named, durable JetStream subscription that FluxaORM drives for you. You declare it once in the registry (`ConsumerDef`), the code generator emits a typed builder for it, and your application registers handlers and owns the fetch loop. There are two kinds, sharing one declaration and one runtime:

- **Entity consumers** read [entity change events](/guide/entity_events.html) for the entities they declare. A failing handler leaves the message unacked so JetStream redelivers it - a projection refresh should retry until fixed.
- **Task consumers** drain [task queues](/guide/tasks.html). A failing handler retries with backoff up to the task's attempt cap, then the task is dead-lettered and its run row marked failed.

## Declaring a Consumer

```go
registry.RegisterConsumer(fluxaorm.ConsumerDef{
    Name:     "user-indexer",
    Entities: []any{UserEntity{}, OrderEntity{}},
    AckWait:  time.Minute,
})
registry.RegisterConsumer(fluxaorm.ConsumerDef{
    Name:   "emails",
    Queues: []fluxaorm.Queue{"emails"},
})
```

```go
type ConsumerDef struct {
    Name          ConsumerName
    Entities      []any
    Queues        []Queue
    AckWait       time.Duration
    MaxAckPending int
    MaxDeliver    int
    NatsPool      string
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `Name` | required | Durable name on JetStream and metrics label. Must match `^[a-z][a-z0-9-]*$`. |
| `Entities` | | Entity structs (the same values you pass to `RegisterEntity`), each tagged `orm:"cdc"`. Mutually exclusive with `Queues`. |
| `Queues` | | Task queues this consumer drains. Exactly one consumer may drain a queue. Mutually exclusive with `Entities`. |
| `AckWait` | `30s` | How long JetStream waits for an ack before redelivering. Must exceed your slowest handler. |
| `MaxAckPending` | `256` | Maximum unacked messages in flight. |
| `MaxDeliver` | `-1` (unlimited) | Redelivery cap enforced by JetStream. Task consumers cap attempts themselves through `TaskOptions.MaxAttempts`, so leave this unlimited. |
| `NatsPool` | `"default"` | NATS pool code. Must be the pool the entity/task stream lives on. |

An entity consumer subscribes to `fluxa.entity.<table>` for every declared entity plus its private replay wildcard `fluxa.replay.<name>.>`. A task consumer subscribes to `fluxa.task.<queue>.>` for every declared queue. The durable itself is created by [`GetNatsAlters`](/guide/nats.html#topology-alters).

### Validate rules

`registry.Validate()` rejects any declaration whose runtime symptom would be silence (a handler that never fires, an event nobody reads):

| Error | Meaning |
|-------|---------|
| `consumer '%s' must match ^[a-z][a-z0-9-]*$; the name becomes a JetStream durable and a metrics label` | Bad name. |
| `consumer '%s' is declared twice; two consumers sharing a durable would split its messages` | Duplicate `Name`. |
| `consumer '%s' declares both entities and queues, but a JetStream consumer belongs to one stream; split it in two` | `Entities` and `Queues` set together. |
| `consumer '%s' declares neither entities nor queues, so it would drain nothing` | Both empty. |
| `consumer '%s' declares %T, which is not an entity struct` | A non-struct value in `Entities`. |
| `consumer '%s' declares entity '%s' which is not registered; add registry.RegisterEntity(%s{})` | Entity missing from `RegisterEntity`. |
| `consumer '%s' declares entity '%s' which is not tagged `orm:"cdc"`, so it never publishes` | Entity has no `cdc` tag. |
| `consumer '%s' declares entity '%s' twice; JetStream rejects a consumer whose filter subjects overlap` | Same entity listed twice. |
| `consumer '%s' declares queue '%s' twice; JetStream rejects a consumer whose filter subjects overlap` | Same queue listed twice. |
| `queue '%s' is drained by both '%s' and '%s'; exactly one consumer may drain a queue` | Two consumers on one queue. |
| `consumer '%s' declares queue '%s' but no task is assigned to it; check the Queue() on your task structs` | Queue with no registered task. |
| `queue %s (task '%s') has no consumer draining it, so its tasks would queue forever; declare a fluxaorm.ConsumerDef with that queue` | A registered task's queue (often `default`) has no consumer. |
| `entity '%s' is tagged `orm:"cdc"` but no consumer declares it, so its events would be published and never read; add it to a ConsumerDef or drop the tag` | Orphan `cdc` entity. |

Several consumers may declare the same entity; the write still publishes one message and each durable receives it once.

## Generated Code

With at least one consumer declared, [code generation](/guide/code_generation.html) writes `consumers.go` plus one `<consumer-name>_consumer.go` per consumer into the `entities` package. The Go identifier is the consumer name with `-`/`_` removed and each part capitalised: `user-indexer` becomes `UserIndexer`.

```go
// consumers.go
var (
    ConsumerEmails = fluxaorm.NewConsumerRef[EmailsBuilder]("emails", []fluxaorm.Subject{
        "fluxa.task.emails.>",
    }, newEmailsBuilder)
    ConsumerUserIndexer = fluxaorm.NewConsumerRef[UserIndexerBuilder]("user-indexer", []fluxaorm.Subject{
        "fluxa.entity.UserEntity",
        "fluxa.replay.user-indexer.>",
    }, newUserIndexerBuilder)
)

// AllConsumers lists every generated consumer so apps can assert that exactly
// one job drains each one.
var AllConsumers = []fluxaorm.ConsumerHandle{
    ConsumerEmails,
    ConsumerUserIndexer,
}

// ConsumerEntities lists the entity providers each entity consumer declared.
// Task consumers are absent: they declare queues, not entities.
var ConsumerEntities = map[fluxaorm.ConsumerName][]fluxaorm.EntityProvider{
    ConsumerUserIndexer.Name(): {&UserEntityProvider},
}
```

```go
// user-indexer_consumer.go
type UserIndexerBuilder struct {
    *fluxaorm.ConsumerBuilder
}

func (b *UserIndexerBuilder) OnUserEntity(
    handler func(ctx fluxaorm.Context, ev *UserEntityDirtyEvent) error,
    opts ...fluxaorm.HandlerOption,
) *UserIndexerBuilder

func (b *UserIndexerBuilder) OnUserEntityBatch(
    handler func(ctx fluxaorm.Context, evs []*UserEntityDirtyEvent) error,
    opts ...fluxaorm.HandlerOption,
) *UserIndexerBuilder
```

```go
// emails_consumer.go
type EmailsBuilder struct {
    *fluxaorm.ConsumerBuilder
}

func (b *EmailsBuilder) OnSendWelcomeEmail(
    handler func(ctx fluxaorm.Context, task *tasks.SendWelcomeEmail) error,
) *EmailsBuilder
```

Only the entities and tasks a consumer declared get `On*` methods, so subscribing to something the consumer never declared is a compile error. Entity consumers get an `On<Entity>` / `On<Entity>Batch` pair; task consumers get one `On<Task>` per task on their queues (no batch variant).

The untyped view of a generated ref is `fluxaorm.ConsumerHandle`:

```go
type ConsumerHandle interface {
    Name() ConsumerName
    Subjects() []Subject
    Enqueue(orm Context, entities []Entity) error
}
```

## Building a Consumer

```go
func NewConsumer[B any](engine Engine, ref ConsumerRef[B]) *B
```

`NewConsumer` returns the generated builder; chain handler registrations and finish with `Build()`, which returns a `fluxaorm.StreamConsumer`:

```go
indexer := fluxaorm.NewConsumer(engine, entities.ConsumerUserIndexer).
    OnUserEntity(func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error {
        return search.Index(ctx, ev)
    }).
    Build()
```

Wiring mistakes panic rather than fail silently:

- `NewConsumer`: `consumer '%s' is not declared; add a fluxaorm.ConsumerDef for it` - the generated code and the registry disagree.
- `Build()`: `consumer '%s': entity '%s' has both a per-message and a batch handler registered; keep one`.
- `Build()`: `consumer '%s': no handler registered for task '%s'` - a task consumer must handle every task on its queues.

## Handling Entity Events

```go
// One call per message. nil acks the message; an error leaves it unacked and
// JetStream redelivers it after AckWait.
OnUserEntity(func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error { ... })

// One call per fetched batch, with every UserEntity message in it. nil acks
// them all; an error leaves them ALL unacked, so the handler must be idempotent.
OnUserEntityBatch(func(ctx fluxaorm.Context, evs []*entities.UserEntityDirtyEvent) error { ... })
```

The `ctx` passed to handlers is a fresh `fluxaorm.Context` created for the `Consume` call, so handlers can load and save entities. `ev.Before`/`ev.After` are `map[string]any` snapshots - see [the event envelope](/guide/entity_events.html#the-event-envelope) for the shape and the `json.Number` caveat.

### WatchFields

```go
func WatchFields(fields ...Field) HandlerOption
```

`WatchFields` skips Update events where none of the listed columns differ between `Before` and `After` (the skipped message is acked). Insert and Delete always pass. The fields are the typed descriptors on the generated provider:

```go
OnUserEntity(func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error {
    return mailer.ConfirmNewAddress(ctx, ev.ID)
}, fluxaorm.WatchFields(entities.UserEntityProvider.Fields.Email))
```

In a batch handler the filter is applied per message; if nothing survives, the handler is skipped and the group is acked. A decode failure of any message fails the whole batch.

### What happens to a message

| Situation | Result |
|-----------|--------|
| Handler returns `nil` | `Ack()` |
| Handler returns an error | Left unacked, redelivered after `AckWait` (unlimited times with the default `MaxDeliver`). The error is written to the NATS query log as operation `CDC_HANDLE`. |
| No handler registered for the entity | Acked and dropped. An entity added to a `ConsumerDef` before the code handling it is deployed does not spin forever. |
| Replay message (`fluxa.replay.<this consumer>.<table>`) | Dispatched to the same `On<Entity>` handler as a real change. |

Handler errors never return from `Consume`; only transport errors do.

## Running the Loop

FluxaORM deliberately does **not** provide a blocking `Run()`. The application owns the loop, the retry policy and the shutdown semantics:

```go
type StreamConsumer interface {
    Consume(ctx context.Context, batch int, timeout time.Duration) error
}
```

`Consume` fetches up to `batch` messages (`<= 0` becomes `1`), waiting at most `timeout` (`<= 0` becomes `5s`), groups them by entity/task and dispatches each group. It returns only transport-level errors (connection lost, stream gone, durable missing). An idle poll returns `nil`.

```go
func runConsumer(ctx context.Context, name string, consumer fluxaorm.StreamConsumer, batch int) {
    for ctx.Err() == nil {
        err := consumer.Consume(ctx, batch, time.Second)
        if err != nil && ctx.Err() == nil {
            log.Printf("consumer %s: %v", name, err)
            select {
            case <-ctx.Done():
            case <-time.After(time.Second): // back off before retrying the transport
            }
        }
    }
}
```

```go
appCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
defer stop()

var wg sync.WaitGroup
wg.Add(2)
go func() { defer wg.Done(); runConsumer(appCtx, "user-indexer", indexer, 32) }()
go func() { defer wg.Done(); runConsumer(appCtx, "emails", emails, 10) }()

<-appCtx.Done() // SIGINT/SIGTERM
wg.Wait()       // both loops return once their in-flight Consume finishes
```

Cancelling the context ends the loop; messages that were fetched but not acked are redelivered by JetStream after `AckWait`, so a graceful shutdown loses nothing.

::: tip
Use `entities.AllConsumers` to assert at startup that your process (or fleet) runs exactly one loop per declared consumer - a consumer nobody drains accumulates messages silently.
:::

## Replaying Entities

`Enqueue` publishes a synthetic `DirtyUpdate` event for each entity onto the consumer's **private** replay subject `fluxa.replay.<consumer>.<table>`, without touching the database. It re-drives one consumer over rows that have not changed - typically to rebuild a search index:

```go
func (r ConsumerRef[B]) Enqueue(orm Context, entities []Entity) error
```

```go
users, err := entities.UserEntityProvider.SearchMany(ctx, fluxaorm.NewQuery().Pager(fluxaorm.NewPager(1, 500)))
if err != nil {
    return err
}
rows := make([]fluxaorm.Entity, 0, len(users))
for _, u := range users {
    rows = append(rows, u)
}
if err := entities.ConsumerUserIndexer.Enqueue(ctx, rows); err != nil {
    return err
}
```

- Replay is per-consumer by construction: republishing onto `fluxa.entity.UserEntity` would reach every consumer of the entity, so a reindex would also re-fire every notification handler. The private subject prevents that.
- The event carries the entity's currently loaded state as both `Before` and `After`, so a handler using `WatchFields` sees no change and skips it. Only unfiltered handlers (full reindexers) act on replays.
- Each message gets a unique `Nats-Msg-Id` (`replay:<consumer>:<Entity>:<id>:<unix nanos>`), so asking for the same row twice replays it twice.
- The whole slice is published in one `PublishBatch`. An empty slice is a no-op; a `nil` entity returns `enqueue: entity is nil`.
- Errors: `consumer '%s' is not declared`, `no dirty publisher registered for entity %s` (the entity is not `cdc`/generated), `consumer '%s' does not declare entity %s`.

## Operations

### Backlog

```go
func ConsumerPending(ctx Context, consumer ConsumerName) (uint64, error)
```

Returns JetStream's `NumPending` for the durable - how many messages the consumer still has to deliver. This is the "is work piling up" signal:

```go
pending, err := fluxaorm.ConsumerPending(ctx, entities.ConsumerUserIndexer.Name())
```

### Changing a consumer

Adding an entity to (or removing one from) a `ConsumerDef` changes the durable's filter subjects. Run [`GetNatsAlters`](/guide/nats.html#topology-alters) on deploy: the `ENSURE nats consumer '<name>'` alter updates the durable in place and it keeps its position in the stream. Regenerate code so the builder gains or loses the matching `On<Entity>` methods.

### Metrics and logging

Per fetched message a declared consumer records `fluxaorm_cdc_messages_total{consumer,entity,op}` and `fluxaorm_stream_consume_lag_seconds{consumer}`; the fetch itself is `fluxaorm_nats_operations_seconds{operation="fetch",consumer="<name>"}` (see [Metrics](/guide/metrics.html)). Handler errors are visible only through the NATS query log (`CDC_HANDLE` for entity handlers, `TASK_HANDLE` when a task's run row cannot be updated), so register one in production:

```go
ctx.RegisterQueryLogger(myHandler, fluxaorm.QueryLoggerOptions{Nats: true})
```

Task handlers additionally tag their own MySQL/Redis/NATS metrics with `source=<TaskName>`.

## Complete Example

```go
package main

import (
    "context"
    "log"
    "os/signal"
    "sync"
    "syscall"
    "time"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
    "myapp/tasks"
)

type UserEntity struct {
    ID    uint64 `orm:"cdc"`
    Email string `orm:"required;length=255"`
    Name  string `orm:"required;length=100"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{}, fluxaorm.JobRunEntity{})
    registry.RegisterTask(tasks.SendWelcomeEmail{}, fluxaorm.TaskOptions{})
    registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "user-indexer", Entities: []any{UserEntity{}}})
    registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "emails", Queues: []fluxaorm.Queue{"emails"}, AckWait: time.Minute})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    defer engine.Nats(fluxaorm.DefaultPoolCode).Close()

    appCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()
    ctx := engine.NewContext(appCtx)

    natsAlters, err := fluxaorm.GetNatsAlters(ctx) // after GetAlters for the tables
    if err != nil {
        panic(err)
    }
    for _, alter := range natsAlters {
        if err := alter.Exec(ctx); err != nil {
            panic(err)
        }
    }

    indexer := fluxaorm.NewConsumer(engine, entities.ConsumerUserIndexer).
        OnUserEntityBatch(func(ctx fluxaorm.Context, evs []*entities.UserEntityDirtyEvent) error {
            for _, ev := range evs {
                log.Printf("index user %d (%s)", ev.ID, ev.Op)
            }
            return nil
        }).
        Build()

    emails := fluxaorm.NewConsumer(engine, entities.ConsumerEmails).
        OnSendWelcomeEmail(func(ctx fluxaorm.Context, task *tasks.SendWelcomeEmail) error {
            u, found, err := entities.UserEntityProvider.GetByID(ctx, task.UserID)
            if err != nil || !found {
                return err
            }
            log.Printf("welcome %s (%s)", u.GetEmail(), task.Locale)
            return nil
        }).
        Build()

    var wg sync.WaitGroup
    wg.Add(2)
    go func() { defer wg.Done(); runConsumer(appCtx, "user-indexer", indexer, 32) }()
    go func() { defer wg.Done(); runConsumer(appCtx, "emails", emails, 10) }()

    // A write publishes one event; a dispatch publishes one task.
    u := entities.UserEntityProvider.New(ctx)
    u.SetEmail("ann@example.com").SetName("Ann")
    if err := ctx.Save(u); err != nil {
        log.Printf("save: %v", err)
    }
    if _, err := entities.DispatchSendWelcomeEmail(ctx, &tasks.SendWelcomeEmail{UserID: u.GetID(), Locale: "en"}); err != nil {
        log.Printf("dispatch: %v", err)
    }

    <-appCtx.Done()
    wg.Wait()
}

func runConsumer(ctx context.Context, name string, consumer fluxaorm.StreamConsumer, batch int) {
    for ctx.Err() == nil {
        err := consumer.Consume(ctx, batch, time.Second)
        if err != nil && ctx.Err() == nil {
            log.Printf("consumer %s: %v", name, err)
            select {
            case <-ctx.Done():
            case <-time.After(time.Second):
            }
        }
    }
}
```
