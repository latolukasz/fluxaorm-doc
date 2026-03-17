# ClickHouse Schema Management

FluxaORM provides schema management for ClickHouse tables, similar to the MySQL [schema update](/guide/schema_update.html) feature. Define your ClickHouse tables using a fluent builder API, register them with the registry, and use `GetClickhouseAlters()` to generate the DDL statements needed to synchronize your database.

## Defining a ClickHouse Table

Use `NewClickhouseTable()` to create a table definition with a fluent builder:

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

table := fluxaorm.NewClickhouseTable("events", "analytics").
    Column("id", "UInt64").
    Column("event_name", "String").
    Column("user_id", "UInt64").
    Column("ts", "DateTime").
    ColumnDefault("processed", "UInt8", "0").
    ColumnCodec("payload", "String", "ZSTD(1)").
    Engine("MergeTree").
    OrderBy("id", "ts").
    PartitionBy("toYYYYMM(ts)").
    TTL("ts + INTERVAL 90 DAY").
    Setting("index_granularity", "8192")
```

## Registering Tables

Register ClickHouse table definitions with the registry before calling `Validate()`:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterClickhouse("clickhouse://localhost:9000/default", "analytics", nil)
registry.RegisterClickhouseTable(
    fluxaorm.NewClickhouseTable("events", "analytics").
        Column("id", "UInt64").
        Column("event_name", "String").
        Column("ts", "DateTime").
        Engine("MergeTree").
        OrderBy("id", "ts"),
)
engine, err := registry.Validate()
```

## Builder API Reference

### Column Methods

All column methods return `*ClickhouseTableBuilder` for fluent chaining:

| Method | Description |
|--------|-------------|
| `Column(name, typeName)` | Simple column |
| `ColumnDefault(name, typeName, defaultExpr)` | Column with DEFAULT expression |
| `ColumnMaterialized(name, typeName, expr)` | Column with MATERIALIZED expression |
| `ColumnAlias(name, typeName, expr)` | Column with ALIAS expression |
| `ColumnCodec(name, typeName, codec)` | Column with compression CODEC |
| `ColumnTTL(name, typeName, ttl)` | Column with column-level TTL |
| `ColumnComment(name, typeName, comment)` | Column with a comment |
| `ColumnFull(name, typeName, opts)` | Column with all options via `ClickhouseColumnOptions` |

### ClickhouseColumnOptions

Used with `ColumnFull()` to set multiple column options at once:

```go
type ClickhouseColumnOptions struct {
    Default      string // DEFAULT expression
    Materialized string // MATERIALIZED expression
    Alias        string // ALIAS expression
    Codec        string // e.g. "ZSTD(1)"
    TTL          string // column-level TTL expression
    Comment      string
}
```

### Table-Level Methods

| Method | Description |
|--------|-------------|
| `Engine(engine)` | Table engine, e.g. `"MergeTree"`, `"ReplacingMergeTree(Version)"` |
| `OrderBy(columns...)` | ORDER BY columns (required) |
| `PartitionBy(expr)` | PARTITION BY expression |
| `PrimaryKey(columns...)` | PRIMARY KEY columns (defaults to ORDER BY if not set) |
| `TTL(expr)` | Table-level TTL expression |
| `Setting(key, value)` | Add a SETTINGS key=value pair |
| `Comment(comment)` | Table comment |

## Getting Schema Alters

Use `GetClickhouseAlters()` to compare registered table definitions with the actual ClickHouse database and get the DDL statements needed:

```go
ctx := engine.NewContext(context.Background())

alters, err := fluxaorm.GetClickhouseAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    fmt.Println(alter.SQL)  // e.g. "CREATE TABLE events ..."
    fmt.Println(alter.Pool) // e.g. "analytics"
}
```

Each `fluxaorm.ClickhouseAlter` has the following fields:

| Field  | Type     | Description |
|--------|----------|-------------|
| `SQL`  | `string` | The DDL statement to execute |
| `Pool` | `string` | The ClickHouse pool code this alter belongs to |

To execute all alters:

```go
for _, alter := range alters {
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

## What Gets Compared

`GetClickhouseAlters()` generates the following types of DDL:

| Scenario | Generated DDL |
|----------|---------------|
| Table not in database | `CREATE TABLE ...` |
| New column | `ALTER TABLE ... ADD COLUMN ...` |
| Changed column (type, default, codec, comment) | `ALTER TABLE ... MODIFY COLUMN ...` |
| Removed column | `ALTER TABLE ... DROP COLUMN ...` |
| Table in database but not registered | `DROP TABLE IF EXISTS ...` |
| TTL defined in builder | `ALTER TABLE ... MODIFY TTL ...` |
| SETTINGS defined in builder | `ALTER TABLE ... MODIFY SETTING ...` |
| COMMENT defined in builder | `ALTER TABLE ... MODIFY COMMENT ...` |
| ENGINE or ORDER BY mismatch | Warning comment (manual recreation required) |

::: warning
ENGINE, ORDER BY, and PARTITION BY **cannot** be altered in ClickHouse. If these differ between the registered definition and the actual table, `GetClickhouseAlters()` returns a SQL comment describing the mismatch. You must manually recreate the table to fix these.
:::

::: warning
FluxaORM generates `DROP TABLE ...` queries for all tables in the ClickHouse database that are not registered.
See [ignored tables](/guide/data_pools.html#clickhouse-ignored-tables) for how to protect tables from being dropped.
:::

## Full Example

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", nil)

    // Define tables
    registry.RegisterClickhouseTable(
        fluxaorm.NewClickhouseTable("events", "analytics").
            Column("id", "UInt64").
            Column("event_name", "String").
            Column("user_id", "UInt64").
            Column("ts", "DateTime").
            ColumnDefault("processed", "UInt8", "0").
            Engine("MergeTree").
            OrderBy("id", "ts").
            PartitionBy("toYYYYMM(ts)").
            TTL("ts + INTERVAL 90 DAY"),
    )

    registry.RegisterClickhouseTable(
        fluxaorm.NewClickhouseTable("metrics", "analytics").
            Column("id", "UInt64").
            Column("name", "String").
            Column("value", "Float64").
            Column("ts", "DateTime").
            ColumnCodec("value", "Float64", "Gorilla").
            Engine("MergeTree").
            OrderBy("id"),
    )

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    ctx := engine.NewContext(context.Background())

    // Get and apply alters
    alters, err := fluxaorm.GetClickhouseAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        fmt.Println(alter.SQL)
        err = alter.Exec(ctx)
        if err != nil {
            panic(err)
        }
    }
}
```

::: tip
Call `GetClickhouseAlters()` alongside `GetAlters()` and `GetRedisSearchAlters()` in your migration flow to keep all data stores in sync.
:::
