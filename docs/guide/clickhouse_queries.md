# ClickHouse Queries

FluxaORM provides ClickHouse support for analytics, reporting, and direct SQL operations. For schema management, see [ClickHouse Schema Management](/guide/clickhouse_schema.html).

First, configure a ClickHouse pool and create an engine:

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterClickhouse("clickhouse://localhost:9000/default", "analytics", nil)
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

## ClickHouse Data Pool

Access the ClickHouse pool through `engine.Clickhouse()`:

```go
ch := engine.Clickhouse("analytics")
config := ch.GetConfig()
config.GetCode()          // "analytics"
config.GetDataSourceURI() // "clickhouse://localhost:9000/default"
config.GetOptions()       // *ClickhouseOptions with MaxOpenConnections, etc.
```

## Clickhouse Interface Methods

The `Clickhouse` interface returned by `engine.Clickhouse(code)` provides the following methods:

| Method | Description |
|--------|-------------|
| `GetConfig() ClickhouseConfig` | Returns the ClickHouse pool configuration |
| `GetDBClient() DBClient` | Returns the underlying `database/sql` client |
| `SetMockDBClient(mock DBClient)` | Replaces the DB client with a mock (useful for testing) |
| `Exec(ctx, query, args...) (ExecResult, error)` | Executes a query (DDL, INSERT, etc.) |
| `QueryRow(ctx, query, toFill...) (bool, error)` | Queries a single row, returns `false` if not found |
| `Query(ctx, query, args...) (Rows, close, error)` | Queries multiple rows |

Note that unlike the MySQL `DB` interface, `Clickhouse` does not support transactions.

## Executing Queries

Use the `Exec()` method to run DDL statements and data modifications:

```go
ch := engine.Clickhouse("analytics")

// Create a table
_, err := ch.Exec(ctx, "CREATE TABLE IF NOT EXISTS events (id UInt64, name String, ts DateTime) ENGINE = MergeTree() ORDER BY id")

// Insert data
_, err = ch.Exec(ctx, "INSERT INTO events (id, name, ts) VALUES (?, ?, ?)", 1, "page_view", time.Now())
```

## Querying a Single Row

Use `QueryRow()` to fetch a single row. Unlike the MySQL `QueryRow`, this method takes a plain query string (not a `Where` object):

```go
ch := engine.Clickhouse("analytics")
var count uint64
found, err := ch.QueryRow(ctx, "SELECT count() FROM events WHERE name = 'page_view'", &count)
if found {
    fmt.Printf("Page views: %d\n", count)
}
```

If no row matches, `found` is `false` and `err` is `nil`.

## Querying Multiple Rows

Use `Query()` to fetch multiple rows:

```go
ch := engine.Clickhouse("analytics")
var id uint64
var name string
rows, close, err := ch.Query(ctx, "SELECT id, name FROM events ORDER BY id LIMIT 100")
defer close()
for rows.Next() {
    err = rows.Scan(&id, &name)
}
```

The `Rows` interface returned by `Query()` provides:

- `Next() bool` — advances to the next row, returns `false` when done.
- `Scan(dest ...any) error` — scans the current row into the provided variables.
- `Columns() ([]string, error)` — returns the column names.

:::warning
Always include a `defer close()` after every `ch.Query()` call to release the underlying database connection.
:::

## Mocking the DB Client

For unit testing, you can replace the underlying database client with a mock:

```go
ch := engine.Clickhouse("analytics")
ch.SetMockDBClient(myMockClient) // myMockClient must implement the DBClient interface
```
