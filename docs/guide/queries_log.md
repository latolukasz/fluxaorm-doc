---
description: "Logging every MySQL, Redis, ClickHouse and NATS operation executed through a FluxaORM Context with per-context log handlers and query debug output."
---

# Queries Log

Every MySQL query, Redis command, ClickHouse query and NATS operation executed through a `fluxaorm.Context` can be delivered to a log handler. Logging is configured **per context**: register a handler on the context you want to observe, and every context created from it with `Clone()` / `CloneWithContext()` inherits the same handlers. Contexts created directly from the engine are not affected.

```go
import (
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

type MyLogger struct{}

func (l *MyLogger) Handle(ctx fluxaorm.Context, log map[string]any) {
    fmt.Printf("[%s/%s] %s %s\n", log["source"], log["pool"], log["operation"], log["query"])
}

ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true, Clickhouse: true, Nats: true})
```

## LogHandler

A handler implements the `fluxaorm.LogHandler` interface:

```go
type LogHandler interface {
    Handle(ctx Context, log map[string]any)
}
```

`Handle` receives the context that executed the query, so you have access to `ctx.GetMetaData()`, the engine and the underlying `context.Context`. Handlers are called synchronously, right after the query finishes.

## RegisterQueryLogger

```go
RegisterQueryLogger(handler LogHandler, options QueryLoggerOptions)

type QueryLoggerOptions struct {
    MySQL      bool
    Redis      bool
    Clickhouse bool
    Nats       bool
}
```

Each `true` flag subscribes the handler to that source. Registering the same handler instance twice for the same source is a no-op, so calling `RegisterQueryLogger` again with more flags simply extends the subscription:

```go
logger := &MyLogger{}
ctx.RegisterQueryLogger(logger, fluxaorm.QueryLoggerOptions{MySQL: true})        // MySQL only
ctx.RegisterQueryLogger(logger, fluxaorm.QueryLoggerOptions{Redis: true, Nats: true}) // now MySQL + Redis + NATS
```

## Built-in Debug Logger

FluxaORM ships a coloured console logger that writes to `stderr`, useful during development and in tests:

```go
// all four sources
ctx.EnableQueryDebug()

// selected sources only
ctx.EnableQueryDebugCustom(fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true})
```

`EnableQueryDebug()` is equivalent to `EnableQueryDebugCustom(QueryLoggerOptions{MySQL: true, Redis: true, Clickhouse: true, Nats: true})`. Each entry is printed on its own line as:

```
FluxaORM <source logo> <pool> <operation> <duration in ms> <query>
<error, in red, only when present>
```

The source logo is `MySQL`, `redis`, `CH` or `NATS`; the pool column is padded to the longest registered pool code; the operation column is 14 characters wide; the time cell's background darkens as the query gets slower.

## Log Entry Fields

The `log` map passed to `Handle` always contains `source`, `pool`, `operation` and `query`. The remaining keys are present only when applicable:

| Key | Type | Present | Description |
|-----|------|---------|-------------|
| `source` | `string` | always | `mysql`, `redis`, `clickhouse` or `nats` |
| `pool` | `string` | always | [Data pool](/guide/data_pools.html) code. For NATS consumer fetches it is `"<pool>/<consumer name>"`, for consumer handler errors it is the consumer name |
| `operation` | `string` | always | Operation label, see the per-source tables below |
| `query` | `string` | always | Query / command text, see below |
| `microseconds` | `int64` | timed entries | Duration in microseconds |
| `started` | `int64` | timed entries | Unix time in nanoseconds when the query started |
| `finished` | `int64` | timed entries | Unix time in nanoseconds when the query finished |
| `error` | `string` | on error | Error message |
| `miss` | `string` | on cache miss | Always the string `"TRUE"` |
| `meta` | `fluxaorm.Meta` | when metadata is set | `ctx.GetMetaData()` -- `Meta` is `map[string]string` with a `Get(key string) string` helper |

All entries are timed except the two NATS consumer handler entries (`CDC_HANDLE`, `TASK_HANDLE`), which have no `microseconds` / `started` / `finished`.

### MySQL (`source="mysql"`)

| `operation` | `query` |
|-------------|---------|
| `TRANSACTION` | `START TRANSACTION`, `COMMIT` or `ROLLBACK` |
| `EXEC` | SQL text followed by the arguments formatted with `%v`, e.g. `INSERT INTO ... VALUES(?,?) [1 Alice]` |
| `SELECT` | SQL text from `DB.QueryRow` / `DB.Query` (and all generated reads), arguments appended the same way |

Newlines in SQL are replaced with spaces.

### Redis (`source="redis"`)

| `operation` | `query` |
|-------------|---------|
| lowercase Redis command name, e.g. `get`, `set`, `hset`, `lrange`, `ft.search`, `flushdb` | full command with arguments, e.g. `get user:1` |
| `PIPELINE EXEC` | every command of the pipeline on its own line; a failing command has its error appended |
| `LOCK OBTAIN` | `LOCK OBTAIN <key> TTL <ttl> WAIT <waitTimeout>`; `miss="TRUE"` when the lock was not obtained |
| `LOCK RELEASE` | `LOCK RELEASE <key>`; `miss="TRUE"` when the lock was no longer held |
| `LOCK TTL` | `LOCK TTL <key>` |
| `LOCK REFRESH` | `LOCK REFRESH <key> <ttl>` where `<ttl>` is the TTL passed to `Obtain`, not the new one; `miss="TRUE"` when the lock was lost |

`miss="TRUE"` is also set on `get` when the key is absent, on `hget` when the field is absent, on `mget` / `hmget` when any value is `nil`, and on `ft.info` when the index does not exist. `GetSet` logs its underlying `get` and (on a miss) `set`; `IncrWithExpire` logs a single `incr`. `XReadGroup` is never logged.

### ClickHouse (`source="clickhouse"`)

| `operation` | `query` |
|-------------|---------|
| `EXEC` | SQL text with arguments appended as `%v` |
| `SELECT` | SQL text from `QueryRow` / `Query` |

Newlines are replaced with spaces.

### NATS (`source="nats"`)

| `operation` | `pool` | `query` |
|-------------|--------|---------|
| `PUBLISH` | pool code | `subject: <subject>` (`Publish`, `PublishWithAck`) |
| `PUBLISH_BATCH` | pool code | `messages: <count>` |
| `PUBLISH_ASYNC` | pool code | `subject: <subject>`, logged when the ack (or error) arrives |
| `FETCH` | `<pool>/<consumer>` | `resolve consumer` (consumer lookup failed), `0 messages fetched` (fetch error) or `<n> messages fetched` |
| `CDC_HANDLE` | consumer name | `subject: <subject>`; only on handler or ack error, always with `error`, not timed |
| `TASK_HANDLE` | consumer name | empty string; only when recording the job run result fails, always with `error`, not timed |

See [NATS](/guide/nats.html), [Consumers](/guide/consumers.html) and [Tasks](/guide/tasks.html).

## Capturing Logs in Tests

`fluxaorm.MockLogHandler` is a ready-made handler that stores every entry:

```go
logs := &fluxaorm.MockLogHandler{}
ctx.RegisterQueryLogger(logs, fluxaorm.QueryLoggerOptions{MySQL: true})

_, _, err := entities.UserEntityProvider.GetByID(ctx, 1)

selects := 0
for _, entry := range logs.Logs {
    if entry["operation"] == "SELECT" {
        selects++
    }
}
logs.Clear() // resets Logs to nil
```

See [Testing](/guide/testing.html) for the full test tool set.
