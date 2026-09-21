---
description: "Background tasks in FluxaORM: dispatch plain Go structs onto JetStream queues with a retry ladder, idempotency keys and a job_runs audit table."
---

# Tasks and Job Runs

A task is a unit of background work: a plain Go struct (the payload) that is dispatched onto a **queue**, stored on the `FLUXA_TASK` JetStream stream, and handled by the one [consumer](/guide/consumers.html) that drains that queue. Every dispatch also writes a row to the `job_runs` table, so each task's attempts and outcome are queryable from the database - the run history is the reason to use tasks instead of publishing raw NATS messages.

## Declaring a Task

A task is an exported struct with at least one exported field. Its **type name is its wire name** (`fluxaorm.TaskName`) and its payload is `json.Marshal(task)`.

```go
// package tasks - a leaf package that imports fluxaorm and nothing generated.
package tasks

import "github.com/latolukasz/fluxaorm/v2"

type SendWelcomeEmail struct {
    UserID uint64
    Locale string
}

// Optional: pick the queue. Without Queue() the task lands on fluxaorm.DefaultQueue ("default").
func (SendWelcomeEmail) Queue() fluxaorm.Queue { return "emails" }
```

```go
type Queued interface {
    Queue() Queue
}

type Subjected interface {
    Subject() Subject
}
```

`Queue()` and `Subject()` are probed on both value and pointer receivers. `Subjected` is a full override of the task's wire subject; its one real use is pinning the old subject across a Go rename, because messages already on the stream carry the old name. The override must stay under `fluxa.task.`.

```go
func TaskNameFor[T any]() TaskName // TaskNameFor[tasks.SendWelcomeEmail]() == "SendWelcomeEmail"
```

`TaskNameFor` derives the wire name from the type (pointer types are dereferenced) exactly as registration does, so code that is generic over a task never has to repeat the name as a string.

### Registration

```go
registry.RegisterTask(tasks.SendWelcomeEmail{}, fluxaorm.TaskOptions{})
registry.RegisterTask(tasks.TranscodeClip{}, fluxaorm.TaskOptions{MaxAttempts: 3, BaseBackoff: 30 * time.Second})
registry.RegisterEntity(fluxaorm.JobRunEntity{}) // required as soon as one task is registered
```

```go
type TaskOptions struct {
    MaxAttempts int
    BaseBackoff time.Duration
    MaxBackoff  time.Duration
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `MaxAttempts` | `5` | Deliveries after which a still-failing task is terminated and its run marked `failed`. |
| `BaseBackoff` | `5s` | Delay before the second attempt; doubles on every further attempt. |
| `MaxBackoff` | `10m` | Cap on the doubled delay. Must not be below `BaseBackoff`. |

Every field has a default, so `TaskOptions{}` is a valid registration. Identity is deliberately absent from the options: the queue comes from `Queued`, the name from the type.

`registry.Validate()` rules:

| Error | Meaning |
|-------|---------|
| `task must be a struct, got %T` / `task must be a named struct type, got %s` | Not a named struct. |
| `task '%s' must be an exported struct name matching ^[A-Z][A-Za-z0-9_]*$; generated code has to name it from another package` | Unexported or oddly named type. |
| `task '%s' has no exported fields, so its payload would always be empty` | Nothing to marshal. |
| `queue '%s' for task '%s' must match ^[a-z0-9_]+$` | Bad queue name. |
| `task '%s' overrides Subject() with '%s', which is outside 'fluxa.task.'; the task stream would not capture it` | Bad `Subjected` override. |
| `task '%s' has MaxBackoff (%s) below BaseBackoff (%s)` | Inconsistent backoff. |
| `task '%s' is registered twice (as '%s' and '%s'); two tasks sharing a name would share a subject` | Two types with the same name. |
| `task '%s' is registered but fluxaorm.JobRunEntity is not; add registry.RegisterEntity(fluxaorm.JobRunEntity{})` | Missing run table. |
| `queue %s (task '%s') has no consumer draining it, so its tasks would queue forever; declare a fluxaorm.ConsumerDef with that queue` | No consumer for the queue (checked in the consumer resolution). |

### The task stream

Dispatched tasks go to the single stream `FLUXA_TASK` (`fluxaorm.TaskStreamName`, subjects `fluxa.task.>`), created by [`GetNatsAlters`](/guide/nats.html#topology-alters) when at least one task is registered. A task's subject is `fluxa.task.<queue>.<TaskName>`, e.g. `fluxa.task.emails.SendWelcomeEmail` (`fluxaorm.TaskSubject(queue, task)`). The stream is separate from the entity stream so a task backlog cannot evict a change nobody has consumed yet.

```go
registry.RegisterTaskStream(fluxaorm.TaskStreamOptions{NatsPool: "events", MaxBytes: 1 << 30})
```

`TaskStreamOptions` has the same fields and defaults as `EntityStreamOptions`: `NatsPool` (`"default"`), `Storage` (file), `Replicas` (`1`), `MaxAge` (`7d`), `MaxBytes` (unbounded), `DuplicateWindow` (`10m`). Registering it is optional.

## Queues and Consumers

A queue is the unit of consumption: **exactly one** `ConsumerDef` drains it, listing it in `Queues`. Tasks on a queue are handled by that consumer's handlers.

```go
registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "emails", Queues: []fluxaorm.Queue{"emails"}})
registry.RegisterConsumer(fluxaorm.ConsumerDef{Name: "default-worker", Queues: []fluxaorm.Queue{fluxaorm.DefaultQueue}})
```

::: warning The default queue
A task without `Queue()` falls through to `fluxaorm.DefaultQueue`. If nothing drains `default`, `Validate()` fails with the `has no consumer draining it` error above - declare a consumer for it or give every task a queue.
:::

::: danger Import cycle
The generated `entities` package imports your task packages (to name the task types in `Dispatch<Task>` and `On<Task>`). A task package must therefore **never import the generated package** - keep tasks in small leaf packages containing the structs and, at most, their `Queue()`. Two task packages with the same base name are fine: the generator aliases the second one (`jobtasks2`, `jobtasks3`, ...). The package identifier is taken from the type itself, not from the import path, so `/v2`-style module paths work.
:::

## Generated Code

For every registered task, `consumers.go` contains a typed dispatch function; the builder of the consumer draining its queue gets an `On<Task>` method:

```go
// DispatchSendWelcomeEmail publishes a SendWelcomeEmail task onto the "emails" queue
// and returns the ID of its job_runs row.
func DispatchSendWelcomeEmail(
    orm fluxaorm.Context,
    task *tasks.SendWelcomeEmail,
    opts ...fluxaorm.DispatchOption,
) (uint64, error)

func (b *EmailsBuilder) OnSendWelcomeEmail(
    handler func(ctx fluxaorm.Context, task *tasks.SendWelcomeEmail) error,
) *EmailsBuilder
```

Application code names the task struct and never a subject or a string. `entities.ConsumerEmails` is the generated handle for `fluxaorm.NewConsumer` (see [Consumers](/guide/consumers.html#generated-code)).

## Dispatching

```go
func DispatchTask[T any](ctx Context, task *T, opts ...DispatchOption) (uint64, error)
func WithIdempotencyKey(key string) DispatchOption

var ErrDispatchInTransaction = errors.New(
    "task dispatch inside a transaction: the publish cannot roll back with it, so dispatch after commit")
```

`Dispatch<Task>` is a typed wrapper around `DispatchTask`. It:

1. Refuses to run inside a transaction (`ErrDispatchInTransaction`) - the publish cannot roll back with it, so the task would run against data that never existed.
2. Fails with `task dispatch: '%s' is not registered; add registry.RegisterTask(%s{}, ...)` for an unregistered type.
3. Marshals the payload and **inserts the `job_runs` row first** (status `pending`, ID from the engine's ID generator), so the row ID can travel on the message as header `Fluxa-Job-Run-ID` (`fluxaorm.HeaderJobRunID`).
4. Publishes with `PublishWithAck` to the task stream's pool. If the publish fails the row **stays `pending`** - it is the only evidence the dispatch was attempted - and the run ID is returned together with the error.
5. If the stream reports the message as a duplicate, the row is closed as `deduplicated` with `LastError` = `collapsed by the task stream's dedup window`.

```go
u := entities.UserEntityProvider.New(ctx)
u.SetEmail("ann@example.com").SetName("Ann")
if err := ctx.Transaction(func(tx fluxaorm.Context) error { return tx.Save(u) }); err != nil {
    return err
}

// After the commit, never inside it.
runID, err := entities.DispatchSendWelcomeEmail(ctx,
    &tasks.SendWelcomeEmail{UserID: u.GetID(), Locale: "en"},
    fluxaorm.WithIdempotencyKey(fmt.Sprintf("welcome:%d", u.GetID())),
)
```

`WithIdempotencyKey` sets the key verbatim as the message's `Nats-Msg-Id`, so repeat dispatches of the same logical work inside the task stream's `DuplicateWindow` (10 minutes by default) collapse into one delivery. Without it a task message carries no `Nats-Msg-Id`.

## Handling Tasks

```go
emails := fluxaorm.NewConsumer(engine, entities.ConsumerEmails).
    OnSendWelcomeEmail(func(ctx fluxaorm.Context, task *tasks.SendWelcomeEmail) error {
        return mailer.SendWelcome(ctx, task.UserID, task.Locale)
    }).
    Build() // panics if any task on "emails" has no handler
```

The loop is the same as for entity consumers - the application calls `Consume(ctx, batch, timeout)` in a goroutine (see [Running the loop](/guide/consumers.html#running-the-loop)). Before each handler call the consumer parses the run ID, tags the context's metrics with `source=<TaskName>` (`MetricsMetaKey`) and marks the run `running` with `Attempts = min(deliveries, MaxAttempts)`. What happens next depends on the handler's result:

| Handler result | Message | Run row |
|----------------|---------|---------|
| `nil` | `Ack()` | `succeeded`, `DurationMs` set |
| `errors.Is(err, context.Canceled)` | left untouched - redelivered after `AckWait` without burning an attempt (shutdown, not failure) | stays `running` |
| `errors.Is(err, fluxaorm.ErrPayloadUndecodable)` | `Term()` on the first attempt - the bytes will never improve | `failed` |
| error and `Deliveries >= MaxAttempts` | `Term()` | `failed`, `LastError` set |
| any other error | `NakWithDelay(backoff)` | `pending`, `LastError` set |
| task unknown or no handler (rolled-back deploy) | `Term()` | `failed`, `LastError` = `no handler for task <name>` |

The backoff is `BaseBackoff << (deliveries-1)`, capped at `MaxBackoff`, plus a random jitter of up to a quarter of the delay so tasks that failed together do not come back in lockstep. With the defaults: 5s, 10s, 20s, 40s, then terminated after the 5th attempt.

`fluxaorm.ErrPayloadUndecodable` (`task payload cannot be decoded`) is what the generated handler wrapper returns when `json.Unmarshal` fails; you can return it yourself for a payload your handler considers permanently invalid.

::: tip
Keep `ConsumerDef.MaxDeliver` at its default (unlimited). The attempt cap belongs to `TaskOptions.MaxAttempts`, which also closes the run row; a JetStream-side cap would drop the message with the row left `running`.
:::

## Job Runs

`fluxaorm.JobRunEntity` records one dispatch of one task. Register it like any entity; it gets its table, its generated provider and its status enum like any other:

```go
type JobRunEntity struct {
    ID         uint64     `orm:"table=job_runs"`
    Task       string     `orm:"required;length=100"`
    Queue      string     `orm:"required;length=50"`
    Status     string     `orm:"enum=pending,running,succeeded,failed,deduplicated;enumName=JobRunStatus;required"`
    Payload    string     `orm:"length=max;required"`
    Attempts   uint8      `orm:"required"`
    LastError  string     `orm:"length=max;required"`
    DurationMs uint32     `orm:"required"`
    StartedAt  *time.Time `orm:"time"`
    FinishedAt *time.Time `orm:"time"`
    CreatedAt  time.Time  `orm:"time"`
}
// Indexes: {Status, CreatedAt} and {Task, CreatedAt}
```

Status constants: `JobRunPending` (`"pending"`), `JobRunRunning` (`"running"`), `JobRunSucceeded` (`"succeeded"`), `JobRunFailed` (`"failed"`), `JobRunDeduplicated` (`"deduplicated"`). The last three are terminal.

Generated read side (table `job_runs` becomes entity `JobRuns`):

```go
run, err := entities.JobRunsProvider.MustGetByID(ctx, runID)
run.GetTask()       // string
run.GetQueue()      // string
run.GetStatus()     // enums.JobRunStatus, compare with enums.JobRunStatusList.Succeeded etc.
run.GetPayload()    // string
run.GetAttempts()   // uint64
run.GetLastError()  // string
run.GetDurationMs() // uint64
run.GetStartedAt()  // *time.Time
run.GetFinishedAt() // *time.Time
run.GetCreatedAt()  // time.Time

failed, err := entities.JobRunsProvider.SearchMany(ctx, fluxaorm.NewQuery().
    Filter(entities.JobRunsProvider.Fields.Status.Is(enums.JobRunStatusList.Failed)).
    SortByDESC(entities.JobRunsProvider.Fields.CreatedAt).
    Pager(fluxaorm.NewPager(1, 50)))
```

::: warning Treat the table as read-only
FluxaORM writes and updates run rows with its own SQL. Use the generated provider for admin screens and dashboards, and the functions below to change state - saving a `JobRuns` entity yourself bypasses the consumer's state machine.
:::

### Functions

```go
func LoadJobRun(ctx Context, id uint64) (task, queue, status, payload string, err error)
func MarkJobRunStarted(ctx Context, id uint64, attempt uint8) error
func MarkJobRunFinished(ctx Context, id uint64, res JobRunResult) error
func RedispatchJobRun(ctx Context, runID uint64) (uint64, error)
func PurgeJobRuns(ctx Context, status string, olderThan time.Duration, limit int) (int, error)
func JobRunBacklog(ctx Context) (depth int, oldest time.Duration, err error)

type JobRunResult struct {
    Status   string        // a terminal status, or JobRunPending to hand the run back
    Err      string
    Duration time.Duration
}
```

- `MarkJobRunStarted` / `MarkJobRunFinished` are what the consumer calls; they are exported for custom runners. `MarkJobRunFinished` accepts only `pending` (leaves `FinishedAt` unset) or a terminal status, otherwise `mark job run finished: status %q is not pending or terminal`. Both fail with `... <id>: no such row` when nothing matched.
- `RedispatchJobRun` is the operator's retry button. It loads the row, refuses unless the run is terminal (`task redispatch: run %d is %s, so it is still in flight`), refuses inside a transaction (`ErrDispatchInTransaction`) and if the task is no longer registered (`task redispatch: task '%s' is no longer registered`), then creates a **new** run row with the same payload (queue taken from the current registry, not the old row) and publishes it without a `Nats-Msg-Id`, so the dedup window never swallows an explicit retry. The original row is left untouched.
- `PurgeJobRuns` deletes up to `limit` rows of **one terminal status** older than `olderThan`; a non-terminal status returns `purge job runs: status %q is not terminal`. Pending and running rows can never be purged.
- `JobRunBacklog` returns how many runs are `pending` and the age of the oldest. A row pending longer than its task's whole backoff ladder means its message was never delivered - nothing else in the system will say so. It is **not** queue depth; `ConsumerPending` is (see below).

Every function returns `fluxaorm.ErrJobRunEntityNotRegistered` (`fluxaorm.JobRunEntity is not registered; add registry.RegisterEntity(fluxaorm.JobRunEntity{})`) if the entity is absent.

## Operations

```go
// Cron, e.g. every minute.
depth, oldest, err := fluxaorm.JobRunBacklog(ctx)
if err == nil && depth > 0 && oldest > 15*time.Minute {
    alert("job runs stranded", depth, oldest)
}
pending, err := fluxaorm.ConsumerPending(ctx, entities.ConsumerEmails.Name()) // queue depth on JetStream

// Cron, e.g. hourly: keep the table bounded, one terminal status at a time.
for _, status := range []string{fluxaorm.JobRunSucceeded, fluxaorm.JobRunDeduplicated} {
    if _, err := fluxaorm.PurgeJobRuns(ctx, status, 7*24*time.Hour, 5000); err != nil {
        log.Printf("purge %s: %v", status, err)
    }
}
if _, err := fluxaorm.PurgeJobRuns(ctx, fluxaorm.JobRunFailed, 30*24*time.Hour, 5000); err != nil {
    log.Printf("purge failed: %v", err)
}
```

Metrics (see [Metrics](/guide/metrics.html)): the dispatch is a `fluxaorm_nats_operations_seconds{operation="publish"}` observation; the consumer's fetches are `operation="fetch",consumer="emails"`; `fluxaorm_cdc_messages_total{consumer="emails",entity="SendWelcomeEmail",op="unknown"}` counts fetched task messages (task messages carry no `Dirty-Op` header, hence `unknown`); `fluxaorm_stream_consume_lag_seconds{consumer="emails"}` is dispatch-to-handle latency. Inside a handler, every MySQL/Redis/NATS metric is tagged `source=<TaskName>`.

Logging: handler errors and terminations are written to the NATS query log as `CDC_HANDLE`; a failure to update the run row as `TASK_HANDLE`. Register a logger with `fluxaorm.QueryLoggerOptions{Nats: true}` (see [Queries log](/guide/queries_log.html)).

::: tip Deployment
`JobRunEntity` is registered like any entity: `GetAlters` creates the `job_runs` table ([Schema update](/guide/schema_update.html)) and `Generate` emits `JobRunsProvider` and `enums.JobRunStatus` ([Code generation](/guide/code_generation.html)). `GetNatsAlters` creates `FLUXA_TASK` and the `emails` durable ([NATS](/guide/nats.html#topology-alters)).
:::

## Complete Example

```go
package main

import (
    "context"
    "fmt"
    "log"
    "os/signal"
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
    registry.RegisterTask(tasks.SendWelcomeEmail{}, fluxaorm.TaskOptions{MaxAttempts: 3})
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

    // Tables (job_runs included), then streams and durables.
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

    emails := fluxaorm.NewConsumer(engine, entities.ConsumerEmails).
        OnSendWelcomeEmail(func(ctx fluxaorm.Context, task *tasks.SendWelcomeEmail) error {
            u, found, err := entities.UserEntityProvider.GetByID(ctx, task.UserID)
            if err != nil {
                return err // retried with backoff, up to MaxAttempts
            }
            if !found {
                return nil // nothing to do; ack
            }
            log.Printf("sending welcome email to %s in %s", u.GetEmail(), task.Locale)
            return nil
        }).
        Build()

    go func() {
        for appCtx.Err() == nil {
            if err := emails.Consume(appCtx, 10, time.Second); err != nil && appCtx.Err() == nil {
                log.Printf("emails consumer: %v", err)
                time.Sleep(time.Second)
            }
        }
    }()

    // Write in a transaction, dispatch after the commit.
    u := entities.UserEntityProvider.New(ctx)
    u.SetEmail("ann@example.com").SetName("Ann")
    if err := ctx.Transaction(func(tx fluxaorm.Context) error { return tx.Save(u) }); err != nil {
        panic(err)
    }
    runID, err := entities.DispatchSendWelcomeEmail(ctx,
        &tasks.SendWelcomeEmail{UserID: u.GetID(), Locale: "en"},
        fluxaorm.WithIdempotencyKey(fmt.Sprintf("welcome:%d", u.GetID())))
    if err != nil {
        log.Printf("dispatch failed, run %d stays pending: %v", runID, err)
    }

    // Maintenance cron.
    go func() {
        ticker := time.NewTicker(time.Minute)
        defer ticker.Stop()
        for {
            select {
            case <-appCtx.Done():
                return
            case <-ticker.C:
                cronCtx := engine.NewContext(appCtx)
                if depth, oldest, err := fluxaorm.JobRunBacklog(cronCtx); err == nil && depth > 0 {
                    log.Printf("job run backlog: %d pending, oldest %s", depth, oldest)
                }
                if _, err := fluxaorm.PurgeJobRuns(cronCtx, fluxaorm.JobRunSucceeded, 7*24*time.Hour, 5000); err != nil {
                    log.Printf("purge job runs: %v", err)
                }
            }
        }
    }()

    <-appCtx.Done()
}
```
