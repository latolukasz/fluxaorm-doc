---
description: "NATS JetStream in FluxaORM: pool configuration, authentication, stream and consumer builders, publishing, fetching and stream alters."
---

# NATS and JetStream

FluxaORM uses [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) as its messaging transport. Three features are built on top of it:

- [Entity change events](/guide/entity_events.html) - every write to an entity tagged `orm:"cdc"` is published as a message.
- [Consumers](/guide/consumers.html) - typed, generated handlers that read entity events and tasks.
- [Tasks](/guide/tasks.html) - background jobs dispatched onto queues, with a run history table.

A **NATS pool** is a connection to one or more NATS servers. This page covers the pool itself, the low-level publish and fetch API, hand-registered streams and consumers, and the topology reconciliation (`GetNatsAlters`) that creates and updates streams and durable consumers on the broker.

## Pool Registration

Register a pool with `RegisterNats`:

```go
import "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()

// Pool with default options (nil is allowed and becomes an empty NatsPoolOptions):
registry.RegisterNats([]string{"nats://localhost:4222"}, fluxaorm.DefaultPoolCode, nil)

// Pool with several servers and options:
registry.RegisterNats([]string{"nats://nats-1:4222", "nats://nats-2:4222"}, "events", &fluxaorm.NatsPoolOptions{
    ClientID:             "my-service",
    RetryOnFailedConnect: true,
    Auth: &fluxaorm.NatsAuthConfig{
        User:     "app",
        Password: "secret",
    },
})
```

```go
RegisterNats(urls []string, poolCode string, options *NatsPoolOptions)
```

The pool is available from the engine as `engine.Nats(code)` (returns `nil` for an unknown code) and all pools as `engine.Registry().NatsPools()`.

::: tip Lazy connection
`registry.Validate()` only builds the pool object; **nothing connects to NATS until the first operation** that needs a connection (`Publish*`, `Consumer`, `GetJetStream`, `GetConn`, `Ping`). If a previous connection is no longer in the `CONNECTED` state the next operation re-dials. `Ping()` forces a connection attempt and is the way to fail fast at startup.
:::

The features built on NATS pick their pool with the `NatsPool` field of `EntityStreamOptions`, `TaskStreamOptions` and `ConsumerDef`. All three default to `fluxaorm.DefaultPoolCode` (`"default"`), so registering the pool under the default code needs no further wiring.

### NatsPoolOptions

| Field | Type | Behaviour |
|-------|------|-----------|
| `ClientID` | `string` | Passed as the connection name (`nats.Name`). |
| `MaxReconnects` | `int` | Default `-1` (reconnect forever). Applied only when not `0`. |
| `ReconnectWait` | `time.Duration` | Default `1s`. Applied when `> 0`. |
| `ReconnectBufSize` | `int` | Applied when `> 0`. |
| `PingInterval` | `time.Duration` | Applied when `> 0`. |
| `ConnectTimeout` | `time.Duration` | Applied when `> 0` (`nats.Timeout`). |
| `RetryOnFailedConnect` | `bool` | When `true` the client keeps retrying if the initial connect fails. |
| `Auth` | `*NatsAuthConfig` | Authentication, see below. |
| `IgnoredSubjects` | `[]string` | Existing `FLUXA_*`/`fluxa_*` streams carrying any of these subjects are never deleted by `GetNatsAlters`. The list is only taken into account when at least one stream is registered with `RegisterNatsStream`. |
| `IgnoredConsumers` | `[]string` | Parsed and stored, but **not read anywhere** - `GetNatsAlters` never deletes consumers, so there is nothing to exempt. Setting it has no effect today. |

### NatsAuthConfig

Exactly one method is used, in this order of precedence:

| Field | Method |
|-------|--------|
| `CredsFile` | `nats.UserCredentials(CredsFile)` |
| `NKeySeed` | `nats.NkeyOptionFromSeed(NKeySeed)` - an invalid seed is silently ignored and the connection proceeds unauthenticated |
| `Token` | `nats.Token(Token)` |
| `User` + `Password` | `nats.UserInfo(User, Password)` |

## YAML Configuration

Pools can also come from a configuration file. The list-based shape below is the `fluxaorm.Config` struct (`yaml` tags) consumed by `registry.InitByConfig` - see [Registry](/guide/registry.html#loading-configuration-from-a-config-struct). The top-level key is `natsPools`:

```yaml
natsPools:
  - code: default
    urls: ["nats://localhost:4222"]
    clientID: my-service
    maxReconnects: -1
    reconnectWaitMs: 1000
    reconnectBufSize: 8388608
    connectTimeoutMs: 5000
    retryOnFailedConnect: true
    authUser: app
    authPassword: secret
    ignoredSubjects: ["legacy.>"]
    streams:
      - name: ORDERS_RAW
        subjects: ["orders.>"]
        maxAgeMs: 604800000
        maxBytes: 1073741824
        maxMsgSize: 1048576
        replicas: 1
        duplicateWindowMs: 600000
    consumers:
      - name: orders-audit
        filterSubjects: ["orders.>"]
        ackWaitMs: 30000
        maxAckPending: 16
        maxDeliver: -1
```

Per-pool keys: `code` (required), `urls` (required), `clientID`, `maxReconnects`, `reconnectWaitMs`, `reconnectBufSize`, `connectTimeoutMs`, `retryOnFailedConnect`, `authToken`, `authUser`, `authPassword`, `authCredsFile`, `authNKeySeed`, `ignoredSubjects`, `ignoredConsumers`, `streams`, `consumers`.

`streams` entries: `name` (required), `subjects` (required), `maxAgeMs`, `maxBytes`, `maxMsgSize`, `replicas`, `duplicateWindowMs`, `storage`, `retention`. Each becomes a `NewNatsStream(name, code)` builder registered with `RegisterNatsStream`.

`consumers` entries: `name` (required), `filterSubjects`, `ackWaitMs`, `maxAckPending`, `maxDeliver`. Each becomes a `NewNatsConsumer(name, code)` builder registered with `RegisterNatsConsumer`.

::: warning What the YAML loader does not do
- `storage` and `retention` are parsed into the config struct but **never applied** to the stream builder. Streams from YAML always use the builder defaults (`FileStorage`, `LimitsPolicy`). Use the Go builder if you need another value.
- There is no YAML key for `PingInterval`.
- The nested `<pool code>: nats:` shape read by `InitByYaml` supports fewer keys (no `connectTimeoutMs`, `retryOnFailedConnect`, `authNKeySeed`, `storage`, `retention`, and streams there need an explicit `poolCode`) - see [Registry](/guide/registry.html#yaml-format).
- `ignoredConsumers` is stored but unused (see the options table above).
:::

## Publishing

The `Nats` interface is what `engine.Nats(code)` returns:

```go
type Nats interface {
    GetCode() string
    GetURLs() []string
    GetPoolOptions() *NatsPoolOptions
    Ping() error
    Publish(ctx Context, msg *NatsMessage) error
    PublishWithAck(ctx Context, msg *NatsMessage) (NatsPubAck, error)
    PublishBatch(ctx Context, msgs []*NatsMessage) error
    PublishAsync(ctx Context, msg *NatsMessage, callback func(*NatsMessage, error))
    Consumer(name string) (NatsConsumer, error)
    MustConsumer(name string) NatsConsumer
    ConsumerNames() []string
    GetJetStream() (jetstream.JetStream, error)
    GetConn() (*nats.Conn, error)
    Close()
}
```

Messages are `NatsMessage` values:

```go
type NatsMessage struct {
    Subject    string
    Data       []byte
    Headers    nats.Header
    Sequence   uint64    // stream sequence, set on fetched messages
    Timestamp  time.Time // broker timestamp, set on fetched messages
    Deliveries uint64    // how many times JetStream delivered it (starts at 1); 0 on a message you build
}

func NewNatsMessage(subject string) *NatsMessage // Headers is pre-initialised
```

| Method | Behaviour |
|--------|-----------|
| `Publish(ctx, msg)` | `PublishMsg` and waits for the JetStream ack. |
| `PublishWithAck(ctx, msg)` | Same, and returns `NatsPubAck{Stream string, Sequence uint64, Duplicate bool}`. `Duplicate` is `true` when the stream had already seen the message's `Nats-Msg-Id` header inside its duplicate window and collapsed it - the message will never be delivered. |
| `PublishBatch(ctx, msgs)` | Publishes every message asynchronously, then waits once for all acks. Wire order is preserved, so stream sequences match a `Publish` loop. Returns the first error. An empty slice is a no-op. |
| `PublishAsync(ctx, msg, callback)` | Returns immediately. `callback` (may be `nil`) runs in a goroutine with `(msg, ackErr)`, or with `(nil, err)` if the publish could not even be started. |

```go
ctx := engine.NewContext(context.Background())
pool := engine.Nats("events")

msg := fluxaorm.NewNatsMessage("orders.created")
msg.Data = []byte(`{"id":1}`)
msg.Headers.Set("Nats-Msg-Id", "order-created-1") // optional JetStream deduplication

ack, err := pool.PublishWithAck(ctx, msg)
if err != nil {
    panic(err)
}
if ack.Duplicate {
    fmt.Println("collapsed by the stream's duplicate window")
}
```

::: warning
A message published to a subject that no stream captures is dropped by the server without an error at the publisher. Make sure a stream covering the subject exists (see [Topology alters](#topology-alters)).
:::

## Streams and Consumers

FluxaORM manages two streams of its own (`FLUXA_ENTITY` and `FLUXA_TASK`, see [below](#streams-managed-by-fluxaorm)). Any other stream or durable consumer you need is declared with the builders and reconciled onto the broker by `GetNatsAlters`.

### NatsStreamBuilder

```go
registry.RegisterNatsStream(
    fluxaorm.NewNatsStream("ORDERS_RAW", "events").
        Subjects("orders.>").
        MaxAge(7 * 24 * time.Hour).
        Duplicates(10 * time.Minute),
)
```

| Method | Default | Description |
|--------|---------|-------------|
| `NewNatsStream(streamName, poolCode string)` | | Constructor. |
| `Subjects(subjects ...string)` | required | Subjects the stream captures. |
| `Retention(r jetstream.RetentionPolicy)` | `jetstream.LimitsPolicy` | |
| `Storage(s jetstream.StorageType)` | `jetstream.FileStorage` | |
| `MaxAge(d time.Duration)` | unlimited | Applied when `> 0`. |
| `MaxBytes(n int64)` | unlimited (`-1`) | Applied when `> 0`. |
| `MaxMsgSize(n int32)` | unlimited (`-1`) | Applied when `> 0`. |
| `Replicas(n int)` | `1` | |
| `Duplicates(d time.Duration)` | server default | Deduplication window for `Nats-Msg-Id`. Applied when `> 0`. |

`Validate()` fails with `nats stream name is required`, `nats pool code is required for stream '%s'`, `nats stream '%s' must have at least one subject`, `nats pool '%s' not registered for stream '%s'` or `duplicate nats stream '%s' in pool '%s' (already registered in pool '%s')`.

### NatsConsumerBuilder

```go
registry.RegisterNatsConsumer(
    fluxaorm.NewNatsConsumer("orders-audit", "events").
        Stream("ORDERS_RAW").
        FilterSubjects("orders.>").
        AckWait(time.Minute).
        MaxAckPending(16),
)
```

| Method | Default | Description |
|--------|---------|-------------|
| `NewNatsConsumer(name, poolCode string)` | | `name` is the durable name. |
| `Stream(name string)` | guessed | Pins the stream. Without it the reconciler picks the first existing stream whose subjects cover the first filter subject (exact match or a `.>` prefix match). Always set it when filtering more than one subject. |
| `FilterSubjects(subjects ...string)` | none | One subject becomes `FilterSubject`, several become `FilterSubjects`. |
| `AckWait(d time.Duration)` | `30s` | |
| `MaxAckPending(n int)` | `1` | |
| `MaxDeliver(n int)` | `-1` (unlimited) | Applied when not `0`. |
| `DeliverPolicy(p jetstream.DeliverPolicy)` | `jetstream.DeliverAllPolicy` | |

The ack policy is always `AckExplicitPolicy`. `Validate()` fails with `nats consumer name is required`, `nats pool code is required for consumer '%s'`, `nats pool '%s' not registered for consumer '%s'` or `duplicate nats consumer '%s' in pool '%s' (already registered in pool '%s')`.

### Fetching messages

A registered consumer is obtained from the pool by name and drained with `Fetch`:

```go
type NatsConsumer interface {
    GetName() string
    GetSettings() *NatsConsumerSettings
    Fetch(ctx Context, batch int, maxWait time.Duration) NatsBatch
    Close()
}
```

```go
consumer, err := engine.Nats("events").Consumer("orders-audit")
if err != nil {
    panic(err) // "nats pool 'events': consumer 'orders-audit' not registered"
}

for {
    batch := consumer.Fetch(ctx, 50, 2*time.Second)
    if err := batch.Error(); err != nil {
        log.Printf("fetch: %v", err)
        continue
    }
    for _, msg := range batch.Records() {
        if err := handle(msg); err != nil {
            _ = msg.NakWithDelay(10 * time.Second) // redeliver later
            continue
        }
        _ = msg.Ack()
    }
}
```

- `Consumer(name)` knows the durables registered with `RegisterNatsConsumer` and the ones declared through [`ConsumerDef`](/guide/consumers.html). `MustConsumer` panics instead of returning the error; `ConsumerNames()` lists them (unsorted).
- `GetSettings()` returns the registered definition: `Name`, `FilterSubjects []string`, `AckWait`, `MaxAckPending`, `MaxDeliver` and `DeliverPolicy` (a `ConsumerDef` durable leaves `DeliverPolicy` at its zero value, `DeliverAllPolicy`).
- On the first `Fetch` the durable is located by scanning every stream on the server; if none has it the batch error is `nats pool '%s': durable consumer '%s' not found in any stream`. Run `GetNatsAlters` first.
- A fetch that times out with no messages is an idle poll, not an error: `batch.Error()` is `nil` and `batch.IsEmpty()` is `true`.
- `NatsBatch` offers `Records() []*NatsMessage`, `EachRecord(func(*NatsMessage))`, `EachError(func(error))`, `Error() error` and `IsEmpty() bool`.
- Fetched messages carry `Sequence`, `Timestamp` and `Deliveries` from the JetStream metadata.
- `msg.Ack()`, `msg.Nak()`, `msg.NakWithDelay(d)` and `msg.Term()` act on the JetStream message. On a message that was not fetched (one you built yourself) they are no-ops returning `nil`.
- `NatsConsumer.Close()` is a no-op; close the pool instead.

::: tip
Plain `Nak()` redelivers immediately, which turns a permanently failing handler into a hot loop. Use `NakWithDelay` for a backoff.
:::

## Streams Managed by FluxaORM

When you use entity events or tasks, `GetNatsAlters` also manages two streams on the pool selected by `EntityStreamOptions.NatsPool` / `TaskStreamOptions.NatsPool`:

| Stream | Constant | Subjects | Created when |
|--------|----------|----------|--------------|
| `FLUXA_ENTITY` | `fluxaorm.EntityStreamName` | `fluxa.entity.>`, `fluxa.replay.>` | at least one `ConsumerDef` is registered |
| `FLUXA_TASK` | `fluxaorm.TaskStreamName` | `fluxa.task.>` | at least one task is registered |

Both streams are tuned with `EntityStreamOptions` / `TaskStreamOptions` (fields `Storage`, `Replicas`, `MaxAge`, `MaxBytes`, `DuplicateWindow`, `NatsPool`; defaults: pool `default`, `Replicas=1`, `MaxAge=7d`, `DuplicateWindow=10m`, `MaxBytes` unbounded, `Storage` file). See [Entity events](/guide/entity_events.html#the-entity-stream) and [Tasks](/guide/tasks.html#the-task-stream).

Subjects are typed as `fluxaorm.Subject` and built with:

| Function | Result |
|----------|--------|
| `EntitySubject(table string) Subject` | `fluxa.entity.<table>` |
| `ReplaySubject(consumer ConsumerName, table string) Subject` | `fluxa.replay.<consumer>.<table>` |
| `TaskSubject(queue Queue, task TaskName) Subject` | `fluxa.task.<queue>.<TaskName>` |

Related string types: `ConsumerName` (also the JetStream durable name), `Queue`, `TaskName`, and the constant `DefaultQueue Queue = "default"`.

## Topology Alters

`GetNatsAlters` compares the desired topology with the broker and returns the operations needed to synchronise them. It is the NATS counterpart of [`GetAlters`](/guide/schema_update.html) for MySQL - the two are separate, run both:

```go
func GetNatsAlters(ctx Context) ([]NatsAlter, error)

type NatsAlter struct {
    Description string      // e.g. "CREATE nats stream 'FLUXA_ENTITY'"
    PoolCode    string
    Kind        AlterKind   // AlterKindCreateTable, AlterKindModifyTable or AlterKindDropTable
    Safety      AlterSafety // AlterSafe or AlterDestructive
}

func (a NatsAlter) IsSafe() bool
func (a NatsAlter) Exec(ctx Context) error
```

```go
ctx := engine.NewContext(context.Background())

// MySQL schema first (tables), then the JetStream topology.
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
    if !alter.IsSafe() {
        // Stream deletions and subject-narrowing updates break the previous
        // code version if it is still running. Gate them behind a manual step.
        fmt.Printf("skipping destructive alter: %s (pool %s)\n", alter.Description, alter.PoolCode)
        continue
    }
    if err := alter.Exec(ctx); err != nil {
        panic(err)
    }
}
```

The desired state is: every `RegisterNatsStream` builder, plus `FLUXA_ENTITY` and `FLUXA_TASK` when applicable; every `RegisterNatsConsumer` builder, plus one durable per `ConsumerDef` (pinned to its stream, filtering all its subjects, with the `ConsumerDef`'s `AckWait`, `MaxAckPending`, `MaxDeliver`).

| Situation | Alter | Kind | Safety |
|-----------|-------|------|--------|
| Desired stream missing on the broker | `CREATE nats stream '<name>'` | `AlterKindCreateTable` | safe |
| Desired stream exists with a different config | `UPDATE nats stream '<name>'` - pushes the whole desired config | `AlterKindModifyTable` | safe if the desired subject list is a superset of the existing one, destructive otherwise |
| Stream exists, is not desired, and its name starts with `FLUXA_` or `fluxa_` | `DELETE nats stream '<name>'` | `AlterKindDropTable` | destructive |
| Every desired consumer | `ENSURE nats consumer '<name>'` - `CreateOrUpdateConsumer` | `AlterKindCreateTable` | safe |

Details worth knowing:

- Two stream configs are equal when `Retention`, `Storage`, `Replicas`, `MaxAge`, `MaxBytes`, `MaxMsgSize`, `Duplicates` and the (sorted) subject lists match.
- Streams whose names do not start with `FLUXA_`/`fluxa_` are **never deleted**, whatever else is on the broker. A managed stream that carries a subject listed in the pool's `IgnoredSubjects` is not deleted either.
- Consumers are never diffed or deleted. `ENSURE` is always reported as safe and updates the durable in place, so widening a consumer's filter list (for example adding an entity to a `ConsumerDef`) keeps its position in the stream. A change that *narrows* the filter is applied too and will stop deliveries the previous code version still expects - it is not flagged.
- `GetNatsAlters` connects to every pool that has at least one desired stream. A pool that has desired consumers but no desired streams is skipped entirely.
- The result is sorted by `Description`, which places `CREATE` before `ENSURE` before `UPDATE`.

::: tip Testing
`fluxaorm.PrepareTablesWithNats` and `fluxaorm.PrepareTablesWithConsumers` apply `GetNatsAlters` for you - see [Testing](/guide/testing.html).
:::

## Logging and Metrics

NATS operations are logged when a query logger is registered with `Nats: true` (see [Queries log](/guide/queries_log.html)):

```go
ctx.RegisterQueryLogger(myHandler, fluxaorm.QueryLoggerOptions{Nats: true})
// or, to stderr:
ctx.EnableQueryDebugCustom(fluxaorm.QueryLoggerOptions{Nats: true})
```

Log `source` is `nats`. Operations: `PUBLISH` (query `subject: <subject>`), `PUBLISH_BATCH` (`messages: <n>`), `PUBLISH_ASYNC`, `FETCH` (`<n> messages fetched`, pool label `<pool>/<consumer>`), and from the consumer runtime `CDC_HANDLE` / `TASK_HANDLE` (handler errors, pool label is the consumer name, no duration).

Prometheus metrics (see [Metrics](/guide/metrics.html)):

| Metric | Type | Labels |
|--------|------|--------|
| `fluxaorm_nats_operations_seconds` | histogram | `operation` (`publish`, `publish_async`, `fetch`), `pool`, `source`, `consumer` (empty for publishes, durable name for `fetch`) |
| `fluxaorm_nats_operations_errors` | counter | `pool`, `source`, `consumer` |
| `fluxaorm_nats_publish_batch_size` | histogram | `pool`, `source` - observed once per `PublishBatch` with the batch length |
| `fluxaorm_cdc_messages_total` | counter | `consumer`, `entity`, `op` - one per message fetched by a declared consumer |
| `fluxaorm_stream_consume_lag_seconds` | histogram | `consumer` - broker timestamp to consume time |

## Closing

`engine.Nats(code).Close()` closes the underlying connection. The next operation on the pool reconnects lazily, so call it on shutdown only:

```go
defer engine.Nats(fluxaorm.DefaultPoolCode).Close()
```
