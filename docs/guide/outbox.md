---
description: "The FluxaORM transactional outbox: orm:\"cdc;outbox\" writes the change event in the same MySQL transaction as the row, with a relay that republishes missed events."
---

# Transactional Outbox

An entity tagged `orm:"cdc"` publishes its [change event](/guide/entity_events.html) **after** the database commit. If NATS is unreachable in that moment the rows are durable but the event is gone: `Save` returns a `*PostCommitError` and nothing will publish the event later. The outbox closes that gap. With `orm:"cdc;outbox"` every write also inserts a row into the `cdc_outbox` table **inside the write's own transaction**; a relay you run on a schedule republishes any row whose event never made it onto the stream, and JetStream deduplication makes the republish a no-op for consumers that already got it.

## Enabling the Outbox

```go
type UserEntity struct {
    ID    uint64 `orm:"cdc;outbox"`
    Email string `orm:"required;length=255"`
    Name  string `orm:"required;length=100"`
}

registry.RegisterEntity(UserEntity{}, fluxaorm.CDCOutboxEntity{})
```

`fluxaorm.CDCOutboxEntity` is the outbox table. FluxaORM owns the struct so the column set is a compile-time fact on both sides: the library writes it with its own SQL, your application reads it through the generated provider. Register it like any entity and it gets its table, provider and enum like any other.

`registry.Validate()` rules:

| Error | Meaning |
|-------|---------|
| `entity '%s' is tagged `orm:"outbox"` but fluxaorm.CDCOutboxEntity is not registered; add registry.RegisterEntity(fluxaorm.CDCOutboxEntity{})` | Missing table. |
| `entity '%s' is tagged `orm:"outbox"` on mysql pool '%s' but the outbox table is on pool '%s'; the outbox row would not be in the same transaction` | The outbox must live on the same MySQL pool as every entity that writes to it - otherwise the row is not in the source write's transaction, which is the entire guarantee. |

### The two tags

| Tag on `ID` | Outbox row | Published to NATS |
|-------------|------------|-------------------|
| `cdc` | none | yes, post-commit (lost if the publish fails) |
| `cdc;outbox` | `pending` inside the transaction, `dispatched` post-commit once the publish succeeded | yes, and the relay republishes rows still `pending` |
| `outbox` | `stored` (born terminal) | no - there is no subject to publish to; the table is a transactional change log |

## The Outbox Table

```go
type CDCOutboxEntity struct {
    ID           uint64     `orm:"table=cdc_outbox"`
    Status       string     `orm:"enum=pending,dispatched,stored;enumName=CDCOutboxStatus;required"`
    EntityName   string     `orm:"required;length=100"` // generated entity struct name, e.g. "UserEntity"
    EntityID     uint64     `orm:"required"`
    Op           uint8      `orm:"required"`            // fluxaorm.DirtyOp: 1 insert, 2 update, 3 delete
    Payload      string     `orm:"length=max;required"` // the exact JSON that goes on the wire
    DispatchedAt *time.Time `orm:"time"`
    CreatedAt    time.Time  `orm:"time"`
}
// Indexes: {Status, CreatedAt}
```

Status constants: `CDCOutboxPending` (`"pending"`), `CDCOutboxDispatched` (`"dispatched"`), `CDCOutboxStored` (`"stored"`).

Generated read side (table `cdc_outbox` becomes entity `CdcOutbox`):

```go
rows, err := entities.CdcOutboxProvider.SearchMany(ctx, fluxaorm.NewQuery().
    Filter(entities.CdcOutboxProvider.Fields.Status.Is(enums.CDCOutboxStatusList.Pending)).
    SortByASC(entities.CdcOutboxProvider.Fields.CreatedAt).
    Pager(fluxaorm.NewPager(1, 100)))

for _, row := range rows {
    row.GetStatus()       // enums.CDCOutboxStatus
    row.GetEntityName()   // string
    row.GetEntityID()     // uint64
    row.GetOp()           // uint64
    row.GetPayload()      // string
    row.GetDispatchedAt() // *time.Time
    row.GetCreatedAt()    // time.Time
}
```

::: warning Treat the table as read-only
FluxaORM inserts and updates outbox rows with its own SQL. Use the provider for dashboards and admin screens; use `RelayCDCOutbox` / `PurgeCDCOutbox` to change state.
:::

## Row Lifecycle

For each written `outbox` entity, `ctx.Save()`:

1. Serialises the change event **once** and queues an `INSERT` into `cdc_outbox` on the same database pipeline as the entity statement. A bare single-entity `Save` therefore opens a transaction for the two statements; inside `ctx.Transaction(...)` the row rolls back with the entity. The row is `pending` for a `cdc;outbox` entity and `stored` for an `outbox`-only entity.
2. After the commit, publishes the event using the **same bytes** stored in the row, so the message and the row are byte-identical and share the deterministic `Nats-Msg-Id` (`<subject>:<hash of payload>`).
3. Flips the published rows to `dispatched` (one `UPDATE ... WHERE ID IN (...)` per `Save`) and sets `DispatchedAt`.

Failure modes:

- **Publish fails**: the row stays `pending`; `Save` returns `*fluxaorm.PostCommitError`. The relay republishes it later.
- **Mark fails** after a successful publish: `Save` returns a `*PostCommitError` wrapping `fluxaorm.ErrOutboxDispatchMark` (`cdc outbox dispatch mark failed`). The row stays `pending`, the relay republishes it, and JetStream's duplicate window absorbs the second copy. The two cases are distinguishable with `errors.Is(err, fluxaorm.ErrOutboxDispatchMark)` - "not delivered" versus "delivered twice".

## Relaying Pending Rows

```go
func RelayCDCOutbox(ctx Context, minAge time.Duration, limit int) (CDCOutboxRelayResult, error)

type CDCOutboxRelayResult struct {
    Fetched    int            // rows read
    Dispatched int            // rows actually published and marked - loop on this
    Published  map[string]int // messages per NATS pool
}
```

`RelayCDCOutbox` selects up to `limit` rows with `Status = 'pending'` and `CreatedAt <= now - minAge`, ordered by ID, rebuilds each message from `EntityName`, `Op` and `Payload`, publishes them in one `PublishBatch` to the entity stream's pool, and then marks them `dispatched`. It lives in the library rather than in your code because the write side lives there: the relay must produce exactly the subject and `Nats-Msg-Id` the inline publish would have, or every recovery becomes a duplicate delivery instead of a no-op.

```go
for {
    res, err := fluxaorm.RelayCDCOutbox(ctx, 30*time.Second, 500)
    if err != nil {
        log.Printf("outbox relay: %v", err) // rows in a failed batch stay pending
    }
    if res.Dispatched == 0 {
        break
    }
}
```

- `minAge` skips rows still racing the ORM's own post-commit mark. Keep it **well below** the entity stream's `DuplicateWindow` (10 minutes by default) so the republish is still deduplicated. 30 seconds is a reasonable value.
- Page on `Dispatched`, not `Fetched`: a batch that fails to publish stays `pending`, so paging on `Fetched` would re-read the same rows forever.
- Delivery is at-least-once: the publish happens before the mark, so a row is never recorded as delivered before it is.
- A row whose `EntityName` has no registered publisher (entity renamed or untagged since the row was written) is reported as `outbox relay: entity '%s' has no registered publisher` rather than published to a subject nothing filters.
- Without a registered `CDCOutboxEntity` the function returns a zero result and no error.

## Purging and Backlog

```go
func PurgeCDCOutbox(ctx Context, olderThan time.Duration, limit int) (int, error)
func CDCOutboxBacklog(ctx Context) (depth int, oldest time.Duration, err error)
```

- `PurgeCDCOutbox` deletes up to `limit` rows in a terminal status (`dispatched` or `stored`) older than `olderThan` and returns how many went. **Pending rows are never deleted** however old they get: one of those is an undelivered event, and dropping it is exactly the silent loss the outbox exists to prevent. A stuck relay therefore shows up as a growing backlog, not as vanished events.
- `CDCOutboxBacklog` returns the number of `pending` rows and the age of the oldest. Both are alertable: a stalled relay is otherwise completely silent, because the rows are safe and nothing errors.

Both are no-ops (zero, `nil`) when `CDCOutboxEntity` is not registered.

## Operations

A typical maintenance job:

```go
func outboxMaintenance(ctx fluxaorm.Context) {
    // Every 30-60 seconds.
    for {
        res, err := fluxaorm.RelayCDCOutbox(ctx, 30*time.Second, 500)
        if err != nil {
            log.Printf("outbox relay: %v", err)
        }
        if res.Dispatched == 0 {
            break
        }
    }

    depth, oldest, err := fluxaorm.CDCOutboxBacklog(ctx)
    if err == nil && depth > 0 && oldest > 5*time.Minute {
        alert("cdc outbox backlog", depth, oldest)
    }

    // Hourly is enough for the purge; keep the table bounded.
    if _, err := fluxaorm.PurgeCDCOutbox(ctx, 7*24*time.Hour, 5000); err != nil {
        log.Printf("outbox purge: %v", err)
    }
}
```

The relay's publishes show up as `fluxaorm_nats_operations_seconds{operation="publish"}` and `fluxaorm_nats_publish_batch_size` on the entity stream's pool, and as `PUBLISH_BATCH` in the NATS query log (`fluxaorm.QueryLoggerOptions{Nats: true}`). Consumers count relayed messages like any other in `fluxaorm_cdc_messages_total`; duplicates absorbed by the stream are never delivered and never counted. See [NATS and JetStream](/guide/nats.html#logging-and-metrics).

::: tip Deployment
`CDCOutboxEntity` is registered like any entity: `GetAlters` creates the `cdc_outbox` table and its index ([Schema update](/guide/schema_update.html)), and `Generate` emits `CdcOutboxProvider` and `enums.CDCOutboxStatus` ([Code generation](/guide/code_generation.html)). The outbox needs no additional NATS topology beyond the entity stream.
:::

## Complete Example

```go
package main

import (
    "context"
    "errors"
    "log"
    "os/signal"
    "syscall"
    "time"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
)

type UserEntity struct {
    ID    uint64 `orm:"cdc;outbox"`
    Email string `orm:"required;length=255"`
    Name  string `orm:"required;length=100"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{}, fluxaorm.CDCOutboxEntity{})
    registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "user-indexer", Entities: []any{UserEntity{}}})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    defer engine.Nats(fluxaorm.DefaultPoolCode).Close()

    appCtx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()
    ctx := engine.NewContext(appCtx)

    // Tables (cdc_outbox included), then streams and durables.
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

    // The write: entity row + outbox row in one transaction, then publish, then mark.
    u := entities.UserEntityProvider.New(ctx)
    u.SetEmail("ann@example.com").SetName("Ann")
    if err := ctx.Save(u); err != nil {
        var postCommit *fluxaorm.PostCommitError
        switch {
        case errors.Is(err, fluxaorm.ErrOutboxDispatchMark):
            log.Printf("published but not marked; relay will republish, stream dedups: %v", err)
        case errors.As(err, &postCommit):
            log.Printf("committed but not published; relay will publish: %v", err)
        default:
            panic(err)
        }
    }

    // Consumer for the events (real and relayed alike).
    indexer := fluxaorm.NewConsumer(engine, entities.ConsumerUserIndexer).
        OnUserEntity(func(ctx fluxaorm.Context, ev *entities.UserEntityDirtyEvent) error {
            log.Printf("user %d %s", ev.ID, ev.Op)
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

    // Relay + purge cron.
    go func() {
        ticker := time.NewTicker(30 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-appCtx.Done():
                return
            case <-ticker.C:
                cronCtx := engine.NewContext(appCtx)
                for {
                    res, err := fluxaorm.RelayCDCOutbox(cronCtx, 30*time.Second, 500)
                    if err != nil {
                        log.Printf("outbox relay: %v", err)
                    }
                    if res.Dispatched == 0 {
                        break
                    }
                }
                if depth, oldest, err := fluxaorm.CDCOutboxBacklog(cronCtx); err == nil && depth > 0 {
                    log.Printf("outbox backlog: %d pending, oldest %s", depth, oldest)
                }
                if _, err := fluxaorm.PurgeCDCOutbox(cronCtx, 7*24*time.Hour, 5000); err != nil {
                    log.Printf("outbox purge: %v", err)
                }
            }
        }
    }()

    <-appCtx.Done()
}
```
