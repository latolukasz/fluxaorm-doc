# Queries Log

You can log all MySQL, Redis, and local cache queries by registering a log handler on a `fluxaorm.Context`:

```go
import "github.com/latolukasz/fluxaorm/v2"

type MyLogger struct{}

func (l *MyLogger) Handle(ctx fluxaorm.Context, log map[string]any) {
    fmt.Printf("QUERY %s in %s\n", log["query"], log["source"])
}

ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true, Local: true, Clickhouse: true})
```

This method requires an implementation of the `fluxaorm.LogHandler` interface:

```go
type LogHandler interface {
    Handle(ctx Context, log map[string]any)
}
```

Note that the `Handle` method receives the current `fluxaorm.Context` as its first argument, which gives you access to request metadata and other contextual information.

## Log Entry Fields

The `log` map provides the following fields:

| Key | Value Type | Description |
|:-------------|:-------------|:------|
| `source` | `string` | `mysql`, `redis`, `local_cache`, or `clickhouse` |
| `pool` | `string` | [Data pool](/guide/data_pools.html) name |
| `query` | `string` | Full query string |
| `operation` | `string` | Short label describing the operation |
| `microseconds` | `int64` | Query execution time in microseconds |
| `started` | `int64` | Unix timestamp (nanoseconds) when the query started |
| `finished` | `int64` | Unix timestamp (nanoseconds) when the query finished |
| `error` | `string` | Query error message, present only if the query returned an error |
| `miss` | `string` | Set to `"TRUE"` when a cache miss occurred |
| `meta` | `Meta` | Request metadata set via `ctx.SetMetaData()`, present only if metadata exists |

Queries to the [local cache](/guide/local_cache.html) are very fast, which is why the log entries for local cache queries do not include the `microseconds`, `started`, and `finished` fields.

## Filtering by Source

You can specify which queries should be logged by setting the respective boolean arguments in `RegisterQueryLogger()`:

```go
// Log only MySQL queries
ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{MySQL: true})

// Log only Redis queries
ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{Redis: true})

// Log only local cache queries
ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{Local: true})

// Log only ClickHouse queries
ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{Clickhouse: true})

// Log MySQL and Redis queries
ctx.RegisterQueryLogger(&MyLogger{}, fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true})
```

## Built-in Debug Logger

FluxaORM includes a built-in colored console logger that you can enable for quick debugging:

```go
// Enable debug logging for all sources (MySQL, Redis, local cache, ClickHouse)
ctx.EnableQueryDebug()

// Enable debug logging for specific sources
ctx.EnableQueryDebugCustom(fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true})
```

The debug logger prints each query to `stderr` with color-coded output showing the source, pool, operation, timing, and query text.
