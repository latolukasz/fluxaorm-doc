# MySQL Queries

In this section, you will learn how to run SQL queries in MySQL. First, we need to configure the MySQL data pools and engine. In our example, we will create two pools - one with the name `default` and another with the name `users`:

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
registry.RegisterMySQL("user:password@tcp(localhost:3306)/users", "users", nil)
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

## MySQL Data Pool

Now we are ready to get the MySQL data pool that will be used to execute all queries. Access it through `engine.DB()`:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
config := db.GetConfig()
config.GetCode()          // "default"
config.GetDatabaseName()  // "db"
config.GetDataSourceURI() // "user:password@tcp(localhost:3306)/db"
config.GetOptions()       // *MySQLOptions with MaxOpenConnections, DefaultEncoding, etc.
```

## DB Interface Methods

The `DB` interface returned by `engine.DB(code)` provides the following methods:

| Method | Description |
|--------|-------------|
| `GetConfig() MySQLConfig` | Returns the MySQL pool configuration |
| `GetDBClient() DBClient` | Returns the underlying `database/sql` client |
| `SetMockDBClient(mock DBClient)` | Replaces the DB client with a mock (useful for testing) |
| `Exec(ctx, query, args...) (ExecResult, error)` | Executes an INSERT, UPDATE, or DELETE query |
| `QueryRow(ctx, where, toFill...) (bool, error)` | Queries a single row, returns `false` if not found |
| `Query(ctx, query, args...) (Rows, close, error)` | Queries multiple rows |
| `Begin(ctx) (DBTransaction, error)` | Starts a new transaction |

The `DBTransaction` interface extends `DB` with transaction control:

| Method | Description |
|--------|-------------|
| `Commit(ctx) error` | Commits the transaction |
| `Rollback(ctx) error` | Rolls back the transaction |

## Executing Modification Queries

To run queries that modify data in MySQL, use the `Exec()` method:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
result, err := db.Exec(ctx, "INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Berlin", 12)
id, _ := result.LastInsertId()   // 1
rows, _ := result.RowsAffected() // 1

result, err = db.Exec(ctx, "INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?),(?, ?)", "Amsterdam", 13, "Warsaw", 14)
id, _ = result.LastInsertId()   // 3
rows, _ = result.RowsAffected() // 2

result, err = db.Exec(ctx, "UPDATE `Cities` SET `Name` = ? WHERE ID = ?", "New York", 1)
id, _ = result.LastInsertId()   // 0
rows, _ = result.RowsAffected() // 1

dbUsers := engine.DB("users")
result, err = dbUsers.Exec(ctx, "DELETE FROM `Users` WHERE `Status` = ?", "rejected")
id, _ = result.LastInsertId()   // 0
rows, _ = result.RowsAffected() // 0
```

The `ExecResult` interface provides two methods:

- `LastInsertId() (uint64, error)` -- returns the last auto-increment ID inserted.
- `RowsAffected() (uint64, error)` -- returns the number of rows affected by the query.

## Querying a Single Row

To run a query that returns only one row, use the `QueryRow()` method. It takes a `Where` object instead of a raw query string:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
where := fluxaorm.NewWhere("SELECT `ID`, `Name` FROM `Cities` WHERE `ID` = ?", 12)
var id uint64
var name string
found, err := db.QueryRow(ctx, where, &id, &name)
if found {
    fmt.Printf("City: %d %s\n", id, name)
}
```

If no row matches, `found` is `false` and `err` is `nil`.

## Querying Multiple Rows

To run a query that returns multiple rows, use the `Query()` method:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
var id uint64
var name string
results, close, err := db.Query(ctx, "SELECT `ID`, `Name` FROM `Cities` WHERE `ID` > ? LIMIT 100", 20)
defer close()
columns, _ := results.Columns() // []string{"ID", "Name"}
for results.Next() {
    err = results.Scan(&id, &name)
}
```

The `Rows` interface returned by `Query()` provides:

- `Next() bool` -- advances to the next row, returns `false` when done (automatically closes the underlying rows).
- `Scan(dest ...any) error` -- scans the current row into the provided variables.
- `Columns() ([]string, error)` -- returns the column names.

:::warning
Always include a `defer close()` after every `db.Query()` call. Failing to do so will result in the inability to run queries to MySQL, as all open database connections will be occupied.
:::

## Transactions

Working with transactions is straightforward. `Begin()` returns a `DBTransaction` that has all the same query methods (`Exec`, `QueryRow`, `Query`) plus `Commit` and `Rollback`:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)

func() {
    tx, err := db.Begin(ctx)
    defer tx.Rollback(ctx)
    // execute some queries using tx.Exec(), tx.QueryRow(), tx.Query()
    _, err = tx.Exec(ctx, "UPDATE `Cities` SET `Name` = ? WHERE `ID` = ?", "Munich", 5)
    err = tx.Commit(ctx)
}()
```

:::tip
Always put `defer tx.Rollback()` immediately after `Begin()`. If `Commit()` has already been called, `Rollback()` is a no-op.
:::

## Mocking the DB Client

For unit testing, you can replace the underlying database client with a mock:

```go
db := engine.DB(fluxaorm.DefaultPoolCode)
db.SetMockDBClient(myMockClient) // myMockClient must implement the DBClient interface
```

You can also retrieve the underlying client with `db.GetDBClient()`.

## DatabasePipeline

A `DatabasePipeline` lets you batch multiple SQL modification queries and execute them together. When more than one query is added, the pipeline wraps them in a transaction automatically.

### Creating a Pipeline

Access a pipeline through the context:

```go
pipeline := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
```

The pipeline is cached per pool on the context -- calling `DatabasePipeLine()` with the same pool code returns the same pipeline instance.

### Adding Queries

Use `AddQuery()` to enqueue SQL statements:

```go
pipeline := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
pipeline.AddQuery("INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Berlin", 12)
pipeline.AddQuery("INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Munich", 12)
pipeline.AddQuery("UPDATE `Countries` SET `CityCount` = `CityCount` + 2 WHERE `ID` = ?", 12)
```

### Executing the Pipeline

Call `Exec()` to run all enqueued queries:

```go
err := pipeline.Exec(ctx)
```

Execution behavior:
- If the pipeline has **no queries**, `Exec()` is a no-op and returns `nil`.
- If the pipeline has **one query**, it is executed directly with `db.Exec()`.
- If the pipeline has **two or more queries**, they are wrapped in a transaction -- if any query fails, the transaction is rolled back and the error is returned.

After `Exec()` completes (successfully or not), the pipeline is cleared and ready for new queries.

### Pipeline and Flush

Database pipelines are also executed automatically as part of `ctx.Flush()`. When you call `ctx.Flush()`, all entity changes are flushed first, then all database pipelines are executed, then all Redis pipelines are executed. This means you can combine entity operations and raw SQL in a single flush cycle:

```go
pipeline := ctx.DatabasePipeLine(fluxaorm.DefaultPoolCode)
pipeline.AddQuery("UPDATE `Counters` SET `Value` = `Value` + 1 WHERE `Name` = ?", "page_views")

// Also track some entity changes...
user.SetName("Alice")

err := ctx.Flush() // flushes entity changes, then executes the database pipeline
```
