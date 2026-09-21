---
description: "Running raw SQL on FluxaORM MySQL pools: Exec, QueryRow, Query, manual transactions and the DatabasePipeline for batching statements."
---

# MySQL Queries

Besides entities, FluxaORM lets you run raw SQL against any registered MySQL pool. This page covers the two ways to obtain a database handle, the `Exec`/`QueryRow`/`Query` methods, manual transactions, and the `DatabasePipeline` for batching statements.

```go
import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"
)

registry := fluxaorm.NewRegistry()
registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
registry.RegisterMySQL("user:password@tcp(localhost:3306)/users", "users", &fluxaorm.MySQLOptions{})
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

Pool options (`ConnMaxLifetime`, `MaxOpenConnections`, `MaxIdleConnections`, `DefaultEncoding`, `DefaultCollate`, `IgnoredTables`) are described in [Data Pools](/guide/data_pools.html).

## Two Handles: ctx.DB and engine.DB

| Accessor | Returns | Use it for |
|----------|---------|------------|
| `ctx.DB(pool string) fluxaorm.DBBase` | The pool's **open transaction** when this context is inside `ctx.Transaction` and a write on that pool has already opened one; otherwise the pool itself. | Application queries. This is the handle every generated entity method uses. |
| `engine.DB(code string) fluxaorm.DB` | Always the plain pool; `DB` adds `Begin`. | Manual transactions, DDL, `GetDBClient`/`SetMockDBClient`, anything that must not join a transaction. |

```go
type DBBase interface {
    GetConfig() MySQLConfig
    GetDBClient() DBClient
    SetMockDBClient(mock DBClient)
    Exec(ctx Context, query string, args ...any) (ExecResult, error)
    QueryRow(ctx Context, query Where, toFill ...any) (found bool, err error)
    Query(ctx Context, query string, args ...any) (rows Rows, close func(), err error)
}

type DB interface {
    DBBase
    Begin(ctx Context) (DBTransaction, error)
}

type DBTransaction interface {
    DBBase
    Commit(ctx Context) error
    Rollback(ctx Context) error
}
```

`DBTransaction` extends `DBBase`, not `DB`: a transaction has no `Begin`.

::: warning Lazy BEGIN
`ctx.Transaction` opens a pool's transaction lazily, on the first entity write or `DatabasePipeline.Exec` for that pool. A `ctx.DB(pool).Exec(...)` issued inside `ctx.Transaction` **before** any such write runs on the plain pool, outside the transaction. Queue raw statements on `ctx.DatabasePipeLine(pool)` (below) when they must be part of the transaction. See [Transactions](/guide/transactions.html).
:::

### Pool configuration

```go
config := ctx.DB(fluxaorm.DefaultPoolCode).GetConfig()
config.GetCode()          // "default"
config.GetDatabaseName()  // "app"
config.GetDataSourceURI() // "user:password@tcp(localhost:3306)/app"
config.GetOptions()       // *fluxaorm.MySQLOptions
```

## Exec

```go
Exec(ctx Context, query string, args ...any) (ExecResult, error)
```

Runs an `INSERT`, `UPDATE`, `DELETE` or DDL statement with `?` placeholders.

```go
db := ctx.DB(fluxaorm.DefaultPoolCode)

result, err := db.Exec(ctx, "INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Berlin", 12)
if err != nil {
    return err
}
id, _ := result.LastInsertId()   // uint64
rows, _ := result.RowsAffected() // uint64

result, err = db.Exec(ctx, "UPDATE `Cities` SET `Name` = ? WHERE `ID` = ?", "Munich", id)

dbUsers := ctx.DB("users")
result, err = dbUsers.Exec(ctx, "DELETE FROM `Users` WHERE `Status` = ?", "rejected")
```

`ExecResult` has two methods, both returning `uint64`:

- `LastInsertId() (uint64, error)`
- `RowsAffected() (uint64, error)`

## QueryRow

```go
QueryRow(ctx Context, query Where, toFill ...any) (found bool, err error)
```

Runs a query expected to return at most one row and scans it into `toFill`. The statement is passed as a `fluxaorm.Where` (see [Search](/guide/search.html#the-where-object)), created with `fluxaorm.NewWhere(query, params...)`.

```go
var id uint64
var name string
found, err := ctx.DB(fluxaorm.DefaultPoolCode).QueryRow(ctx,
    fluxaorm.NewWhere("SELECT `ID`, `Name` FROM `Cities` WHERE `ID` = ?", 12),
    &id, &name)
if err != nil {
    return err
}
if !found {
    fmt.Println("no such city")
}
```

`found` is `false` with a `nil` error when no row matches; any other scan or driver error is returned as `err`.

## Query

```go
Query(ctx Context, query string, args ...any) (rows Rows, close func(), err error)
```

Runs a query that returns many rows.

```go
rows, close, err := ctx.DB(fluxaorm.DefaultPoolCode).Query(ctx,
    "SELECT `ID`, `Name` FROM `Cities` WHERE `ID` > ? LIMIT 100", 20)
if err != nil {
    return err
}
defer close()
columns, _ := rows.Columns() // []string{"ID", "Name"}
for rows.Next() {
    var id uint64
    var name string
    if err = rows.Scan(&id, &name); err != nil {
        return err
    }
}
```

`Rows` has three methods:

- `Next() bool` -- advances to the next row; when it returns `false` the underlying `*sql.Rows` is closed automatically.
- `Scan(dest ...any) error`
- `Columns() ([]string, error)`

There is no `Err()` or `Close()` on `Rows`; use the returned `close` function.

::: warning
Check `err` before calling `close`: on error `Query` returns `nil, nil, err` and the `close` function is `nil`. When `Query` succeeds, always `defer close()` so the connection is released even if you stop iterating early.
:::

## Transactions

The preferred way is `ctx.Transaction(func(tx fluxaorm.Context) error)`: entity writes, `DatabasePipeline.Exec` and reads through `tx.DB(pool)` join one transaction per pool, nested calls join the outer one, and post-commit work (Redis pipelines, callbacks) runs after `COMMIT`. See [Transactions](/guide/transactions.html).

A manual transaction on a single pool is also available through `engine.DB(pool).Begin(ctx)`:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
tx, err := db.Begin(ctx)
if err != nil {
    return err
}
defer tx.Rollback(ctx)

if _, err = tx.Exec(ctx, "UPDATE `Cities` SET `Name` = ? WHERE `ID` = ?", "Munich", 5); err != nil {
    return err
}
return tx.Commit(ctx)
```

`Commit` and `Rollback` are no-ops when the handle is not (or no longer) in a transaction, so `defer tx.Rollback(ctx)` right after `Begin` is safe. A manual transaction is invisible to entity methods and to `ctx.DB(pool)`.

## DatabasePipeline

A `DatabasePipeline` collects SQL modification statements for one pool and executes them together.

```go
pipeline := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
pipeline.AddQuery("INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Berlin", 12)
pipeline.AddQuery("INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Munich", 12)
pipeline.AddQuery("UPDATE `Countries` SET `CityCount` = `CityCount` + 2 WHERE `ID` = ?", 12)
err := pipeline.Exec(ctx)
```

| Method | Description |
|--------|-------------|
| `ctx.DatabasePipeLine(pool string) *DatabasePipeline` | Returns the context's pipeline for the pool; one instance per pool per context. |
| `AddQuery(query string, parameters ...any)` | Enqueues a statement. |
| `AddQueryForTable(table, query string, parameters ...any)` | Same, additionally recording the target table name (used by generated entity code). |
| `Exec(ctx Context) error` | Executes and clears the queue (also on error). |

`Exec` behaviour:

- No statements: returns `nil`.
- Inside `ctx.Transaction`: the statements join the context's transaction for that pool, opening it if needed. No separate commit happens here.
- Otherwise, one statement: executed directly with `Exec`.
- Otherwise, two or more statements: `Begin`, `Exec` each, `Commit`; on the first error the transaction is rolled back and the error returned.

### Pipelines and Save

`ctx.Save(entities...)` queues the entity `INSERT`/`UPDATE`/`DELETE` statements on the same per-pool pipelines and then executes **every** database pipeline of the context, so raw statements added before `Save` are written in the same unit of work (and in the same transaction when `Save` opens one for several entities):

```go
ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode).
    AddQuery("UPDATE `Counters` SET `Value` = `Value` + 1 WHERE `Name` = ?", "page_views")
user.SetName("Alice")
err := ctx.Save(user) // UPDATE Counters + UPDATE user
```

`Save()` with no entities, or only `nil` entries, returns before touching the pipelines. Passing an unchanged entity still executes the queued database pipelines, including when that entity was saved earlier in the same transaction; the entity itself adds no SQL. When you only have raw statements, call `pipeline.Exec(ctx)` yourself.

## Mocking the Client

`GetDBClient() DBClient` returns the underlying `*sql.DB`-compatible client and `SetMockDBClient(mock DBClient)` replaces it, for unit tests that must not hit MySQL. Use the pool handle from `engine.DB(pool)`; see [Testing](/guide/testing.html).

## Logging and Metrics

Every `Exec`, `QueryRow`, `Query`, `Begin`, `Commit` and `Rollback` is reported to the query loggers registered on the context (`ctx.RegisterQueryLogger(handler, fluxaorm.QueryLoggerOptions{MySQL: true})`, see [Queries Log](/guide/queries_log.html)) and to the Prometheus metrics when a metrics registry is configured (see [Metrics](/guide/metrics.html)).
