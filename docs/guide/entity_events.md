# Entity Change Events (CDC)

An entity tagged `orm:"cdc"` publishes a change event to [NATS JetStream](/guide/nats.html) every time a row is inserted, updated or deleted through FluxaORM. The event carries the operation, the entity ID and a `before`/`after` snapshot of the columns. [Consumers](/guide/consumers.html) read those events to refresh search indexes, send notifications, keep projections in sync - anything that must react to a change without slowing down the write path.

The direction matters: the **entity** publishes its own subject and knows nothing about who reads it; each **consumer** declares which entities it wants. Adding a reader is a change in one place (a `ConsumerDef`), not an edit to the entity. One write produces exactly one message however many consumers read it - fan-out happens on the subscribe side.

## Enabling Events

Put `cdc` in the `orm` tag of the `ID` field:

```go
type UserEntity struct {
    ID    uint64 `orm:"cdc"`
    Email string `orm:"required;length=255"`
    Name  string `orm:"required;length=100"`
}
```

Three more things are required:

1. A NATS pool. By default the entity stream lives on the pool registered as `fluxaorm.DefaultPoolCode`; pick another with `RegisterEntityStream`. `Validate()` does not check it exists - a missing pool surfaces at the first `Save` as `nats pool '<code>' for the entity stream not configured`.
2. At least one `ConsumerDef` that declares the entity. An event nobody reads is pure cost, so `Validate()` fails with:
   `entity 'UserEntity' is tagged `orm:"cdc"` but no consumer declares it, so its events would be published and never read; add it to a ConsumerDef or drop the tag`
3. Generated code (see [Code generation](/guide/code_generation.html)). The generator emits the per-entity publisher that builds the payload; until it has run once, nothing is published (this is what lets the very first `Generate` succeed).

```go
registry := fluxaorm.NewRegistry()
registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, nil)
registry.RegisterEntity(UserEntity{})
registry.RegisterConsumer(fluxaorm.ConsumerDef{
    Name:     "user-indexer",
    Entities: []any{UserEntity{}},
})
engine, err := registry.Validate()
```

::: warning Removed tag
The old `orm:"dirty=stream1,stream2"` form no longer exists and is rejected at `Validate()`:
`entity 'UserEntity' uses `orm:"dirty=..."`, which no longer exists; tag it `orm:"cdc"` and declare the entity on a fluxaorm.ConsumerDef instead`
:::

## The Entity Stream

All entity events and all [replays](/guide/consumers.html#replaying-entities) go through **one** JetStream stream, `FLUXA_ENTITY` (`fluxaorm.EntityStreamName`), capturing subjects `fluxa.entity.>` and `fluxa.replay.>`. Each entity publishes on its own subject:

```
fluxa.entity.<table name>        e.g. fluxa.entity.UserEntity
```

The token is the **table name**, not the Go type name, so renaming the struct without changing `orm:"table=..."` does not move the subject. `fluxaorm.EntitySubject(table)` builds it.

The stream is created and kept in sync by [`GetNatsAlters`](/guide/nats.html#topology-alters). It is tuned with `RegisterEntityStream` (optional - the stream exists with defaults either way):

```go
registry.RegisterEntityStream(fluxaorm.EntityStreamOptions{
    NatsPool: "events",
    MaxBytes: 4 << 30,
})
```

| Field | Type | Default |
|-------|------|---------|
| `NatsPool` | `string` | `fluxaorm.DefaultPoolCode` (`"default"`) |
| `Storage` | `jetstream.StorageType` | file storage |
| `Replicas` | `int` | `1` |
| `MaxAge` | `time.Duration` | `7 * 24 * time.Hour` |
| `MaxBytes` | `int64` | unbounded |
| `DuplicateWindow` | `time.Duration` | `10 * time.Minute` |

::: tip
Set `MaxBytes` explicitly in production. Replay shares this stream, so a large reindex on an unbounded stream either evicts live events or fills the disk.
:::

## The Event Envelope

```go
type DirtyOp uint8

const (
    DirtyInsert DirtyOp = 1
    DirtyUpdate DirtyOp = 2
    DirtyDelete DirtyOp = 3
)
// (DirtyOp).String() returns "insert", "update", "delete" or "unknown"

type DirtyEvent[T any] struct {
    Op     DirtyOp `json:"op"`
    ID     uint64  `json:"id"`
    Before *T      `json:"before,omitempty"` // nil for Insert
    After  *T      `json:"after,omitempty"`  // nil for Delete
    TsMs   int64   `json:"ts_ms"`
}
```

For every `cdc` (or `outbox`) entity the generator emits a type alias in the `entities` package:

```go
type UserEntityDirtyEvent = fluxaorm.DirtyEvent[map[string]any]
```

`Before` and `After` are `map[string]any` keyed by **column name**, with `"ID"` always present. Insert sets only `After`, Delete only `Before`, Update both. The wire payload for an update of `UserEntity` looks like this (`op` is numeric):

```json
{
  "op": 2,
  "id": 323046535625160701,
  "before": {"ID": 323046535625160701, "Email": "old@example.com", "Name": "Ann"},
  "after":  {"ID": 323046535625160701, "Email": "new@example.com", "Name": "Ann"},
  "ts_ms": 1757600000000
}
```

Every message also carries the header `Dirty-Op` (`fluxaorm.HeaderDirtyOp`) with the decimal `DirtyOp` value, and a `Nats-Msg-Id` (see [Deduplication](#deduplication)).

::: warning Numbers decode as json.Number
Snapshots are decoded with `UseNumber`, so numeric columns arrive as `json.Number`, not `float64` - a `float64` would silently round uint64 IDs and references above 2^53. Read them with type assertions:
:::

```go
func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error {
    if ev.Op == fluxaorm.DirtyDelete {
        return search.Remove(ev.ID) // ev.ID is a typed uint64
    }
    after := *ev.After
    email, _ := after["Email"].(string)
    return search.Index(ev.ID, email)
}
```

## When Events Are Published

Publishing is part of `ctx.Save()` (see [CRUD](/guide/crud.html)) and happens **after the database changes are durable**:

1. Entity statements (and [outbox](/guide/outbox.html) rows, if any) are executed on the database pipeline.
2. Outside a transaction the post-commit step runs immediately; inside `ctx.Transaction(...)` it is queued and runs after the commit (see [Transactions](/guide/transactions.html)).
3. Post-commit order: evict handles that remain deleted from the context cache, cache invalidation, Redis pipelines, **entity event publish**, outbox mark, after-handlers.

Each write captures its own column snapshot. If a new entity is saved with `Name="first"`, changed to `"second"` and saved again in one transaction, commit publishes an Insert with `After.Name="first"`, then an Update with `Before.Name="first"` and `After.Name="second"`. Later edits to the live entity cannot change these payloads. An unchanged `Save` produces no event, and rollback publishes none.

All events of one `Save` call are published with a single `PublishBatch` per NATS pool, and the post-commit phase waits for the JetStream acks. Outside a transaction, `Save` returning `nil` means the event is durably stored on the stream. Inside a transaction, that guarantee applies only when the outermost `Transaction` returns `nil`; an individual `tx.Save` returns before publication.

If the publish fails after the rows were committed, `Save` (or `Transaction`) returns a `*fluxaorm.PostCommitError` whose message starts with `post-commit failure (database changes are committed): ` and wraps `publish <n> entity events to pool <pool>: <cause>`:

```go
u := entities.UserEntityProvider.New(ctx)
u.SetEmail("ann@example.com").SetName("Ann")
if err := ctx.Save(u); err != nil {
    var postCommit *fluxaorm.PostCommitError
    if errors.As(err, &postCommit) {
        // The row IS in the database; only the event did not reach NATS.
        // Saving this unchanged entity again does not retry publication.
        // See the outbox page for durable event delivery.
    }
    return err
}
```

::: tip Guaranteed delivery
`cdc` alone is "publish after commit": a NATS outage in that window loses the event. Add `outbox` to the tag (`orm:"cdc;outbox"`) to store the event in the database inside the write's own transaction and have a relay republish it - see [Transactional outbox](/guide/outbox.html).
:::

## Deduplication

Every entity message carries `Nats-Msg-Id` = `<subject>:<FNV-1a 64 hash of the payload>`. JetStream drops a second message with the same id inside the stream's `DuplicateWindow` (10 minutes by default). The id contains no consumer or stream name, which is what makes one write one message however many consumers read it. The [outbox relay](/guide/outbox.html) rebuilds the exact same id from the stored payload, so a republish after a failure is a no-op for consumers that already got the message. Replays use a different, unique id on purpose.

## Generated Code

For each `cdc`/`outbox` entity the generated entity file contains the `<Entity>DirtyEvent` alias, two unexported snapshot helpers and an `init()` that registers the publisher under the table name:

```go
func init() {
    fluxaorm.RegisterEntityPublisher[UserEntity]("UserEntity", buildUserEntityDirtyEvent)
}
```

```go
func RegisterEntityPublisher[E any](
    table string,
    buildEvent func(entity *E, op DirtyOp, beforeOrigin map[string]any) ([]byte, error),
)
```

You never call this yourself. At `Validate()` FluxaORM matches each `cdc`/`outbox` schema to its publisher by the generated entity name; a missing publisher is tolerated so that the first code generation can run. The generated code never spells out a subject - the format belongs to FluxaORM.

## Monitoring

On the publish side use the NATS metrics and logs described in [NATS and JetStream](/guide/nats.html#logging-and-metrics) (`fluxaorm_nats_operations_seconds{operation="publish"}`, `fluxaorm_nats_publish_batch_size`, log operation `PUBLISH_BATCH`). On the consume side every declared consumer increments `fluxaorm_cdc_messages_total{consumer,entity,op}` (`op` is `insert`, `update`, `delete` or `unknown`) and observes `fluxaorm_stream_consume_lag_seconds{consumer}` - the time from the broker timestamp to the fetch. Register a query logger with `fluxaorm.QueryLoggerOptions{Nats: true}` to see every publish.

## Complete Example

```go
package main

import (
    "context"
    "errors"
    "fmt"
    "log"
    "os/signal"
    "syscall"
    "time"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
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
    registry.RegisterEntityStream(fluxaorm.EntityStreamOptions{MaxBytes: 4 << 30})
    registry.RegisterEntity(UserEntity{})
    registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "user-indexer", Entities: []any{UserEntity{}}})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    defer engine.Nats(fluxaorm.DefaultPoolCode).Close()

    appCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()
    ctx := engine.NewContext(appCtx)

    // Tables, then JetStream streams and durable consumers.
    alters, err := fluxaorm.GetAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        if err := alter.Exec(ctx); err != nil {
            panic(err)
        }
    }
    natsAlters, err := fluxaorm.GetNatsAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range natsAlters {
        if err := alter.Exec(ctx); err != nil {
            panic(err)
        }
    }

    // Consumer: every UserEntity change lands here (see the Consumers page).
    indexer := fluxaorm.NewConsumer(engine, entities.ConsumerUserIndexer).
        OnUserEntity(func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error {
            fmt.Printf("user %d: %s\n", ev.ID, ev.Op)
            return nil
        }).
        Build()
    go func() {
        for appCtx.Err() == nil {
            if err := indexer.Consume(appCtx, 32, time.Second); err != nil && appCtx.Err() == nil {
                log.Printf("user-indexer: %v", err)
                time.Sleep(time.Second)
            }
        }
    }()

    // One Save = one row + one published event.
    u := entities.UserEntityProvider.New(ctx)
    u.SetEmail("ann@example.com").SetName("Ann")
    if err := ctx.Save(u); err != nil {
        var postCommit *fluxaorm.PostCommitError
        if errors.As(err, &postCommit) {
            log.Printf("row committed but event not published: %v", err)
        } else {
            panic(err)
        }
    }

    <-appCtx.Done()
}
```
