---
description: "Running raw SQL against ClickHouse pools registered in FluxaORM: Exec, QueryRow, Query, options, logging and metrics."
---

# ClickHouse Queries

FluxaORM can hold ClickHouse connection pools next to MySQL and Redis and run raw SQL on them. ClickHouse is a query-only integration: there are no ClickHouse entities, and `Save`, `Transaction` and the pipelines never touch it. Table definitions and alters are covered in [ClickHouse Schema](/guide/clickhouse_schema.html).

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", &fluxaorm.ClickhouseOptions{})
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

`RegisterClickhouse(dataSourceName string, poolCode string, poolOptions *ClickhouseOptions)` accepts these options:

| Field | Type | Description |
|-------|------|-------------|
| `ConnMaxLifetime` | `time.Duration` | Maximum lifetime of a pooled connection |
| `MaxOpenConnections` | `int` | Maximum number of open connections |
| `MaxIdleConnections` | `int` | Maximum number of idle connections |
| `IgnoredTables` | `[]string` | Tables the ClickHouse schema alters must leave alone |

## The Clickhouse Handle

The pool is available only from the engine: `engine.Clickhouse(code string) fluxaorm.Clickhouse`. There is no `ctx.Clickhouse`; the `Context` is passed to each call for logging and metrics. All registered pools can be listed with `engine.Registry().ClickhousePools()`.

```go
type Clickhouse interface {
    GetConfig() ClickhouseConfig
    GetDBClient() DBClient
    SetMockDBClient(mock DBClient)
    Exec(ctx Context, query string, args ...any) (ExecResult, error)
    QueryRow(ctx Context, query Where, toFill ...any) (found bool, err error)
    Query(ctx Context, query string, args ...any) (rows Rows, close func(), err error)
}
```

`ExecResult`, `Rows`, `Where` and `DBClient` are the same types used by [MySQL Queries](/guide/mysql_queries.html). There is no `Begin`: ClickHouse queries never run inside a transaction.

```go
ch := engine.Clickhouse("analytics")
config := ch.GetConfig()
config.GetCode()          // "analytics"
config.GetDatabaseName()  // "analytics"
config.GetDataSourceURI() // "clickhouse://localhost:9000/analytics"
config.GetOptions()       // *fluxaorm.ClickhouseOptions
```

## Exec

```go
ch := engine.Clickhouse("analytics")

_, err := ch.Exec(ctx, "CREATE TABLE IF NOT EXISTS events (id UInt64, name String, ts DateTime) ENGINE = MergeTree() ORDER BY id")
if err != nil {
    return err
}
_, err = ch.Exec(ctx, "INSERT INTO events (id, name, ts) VALUES (1, 'page_view', now()), (2, 'click', now())")
```

`args` are handed to the ClickHouse driver unchanged. The returned `ExecResult` (`LastInsertId()`, `RowsAffected()`) exists for interface compatibility; ClickHouse does not report meaningful values for either.

## QueryRow

`QueryRow` takes a `fluxaorm.Where` (see [Search](/guide/search.html#the-where-object)) and scans the first row into `toFill`:

```go
var count uint64
found, err := ch.QueryRow(ctx,
    fluxaorm.NewWhere("SELECT count() FROM events WHERE name = ?", "page_view"),
    &count)
if err != nil {
    return err
}
if found {
    fmt.Printf("page views: %d\n", count)
}
```

`found` is `false` with a `nil` error when the query returns no rows.

## Query

```go
rows, close, err := ch.Query(ctx, "SELECT id, name FROM events ORDER BY id LIMIT 100")
if err != nil {
    return err
}
defer close()
for rows.Next() {
    var id uint64
    var name string
    if err = rows.Scan(&id, &name); err != nil {
        return err
    }
}
```

`Rows` provides `Next() bool`, `Scan(dest ...any) error` and `Columns() ([]string, error)`. When `Next()` returns `false` the underlying rows are closed automatically.

::: warning
On error `Query` returns `nil, nil, err`, so check `err` before deferring `close`. When it succeeds, always `defer close()` to release the connection even if you stop iterating early.
:::

## Mocking the Client

`GetDBClient() DBClient` returns the underlying client and `SetMockDBClient(mock DBClient)` replaces it for unit tests that must not reach ClickHouse. See [Testing](/guide/testing.html).

## Logging and Metrics

ClickHouse queries are reported to loggers registered with `ctx.RegisterQueryLogger(handler, fluxaorm.QueryLoggerOptions{Clickhouse: true})` (see [Queries Log](/guide/queries_log.html)) and, when a metrics registry is configured, to the ClickHouse query histograms and error counters described in [Metrics](/guide/metrics.html).
