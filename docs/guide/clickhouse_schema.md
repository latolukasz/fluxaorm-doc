---
description: "Declaring ClickHouse tables with the FluxaORM table builder and reconciling them with GetClickhouseAlters, with every DDL statement classified as safe or destructive."
---

# ClickHouse Schema

FluxaORM manages ClickHouse tables the same way it manages MySQL tables: you declare the table with a builder, register it, and `GetClickhouseAlters` returns the DDL needed to bring the live database in line, every statement classified as **safe** or **destructive**. Nothing is executed implicitly. Querying ClickHouse is covered in [ClickHouse Queries](/guide/clickhouse_queries.html); the MySQL counterpart of this page is [Schema Update](/guide/schema_update.html).

## Defining a Table

`fluxaorm.NewClickhouseTable(tableName, poolCode)` returns a `*ClickhouseTableBuilder`. Every method returns the builder, so a definition is one chain:

```go
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

which produces this `CREATE TABLE` (the table name is not database-qualified; the pool's DSN selects the database):

```sql
CREATE TABLE events (
  id UInt64,
  event_name String,
  user_id UInt64,
  ts DateTime,
  processed UInt8 DEFAULT 0,
  payload String CODEC(ZSTD(1))
) ENGINE = MergeTree()
ORDER BY (id, ts)
PARTITION BY toYYYYMM(ts)
TTL ts + INTERVAL 90 DAY
SETTINGS index_granularity = 8192;
```

### Column methods

| Method | Column SQL |
|--------|------------|
| `Column(name, typeName)` | `name type` |
| `ColumnDefault(name, typeName, defaultExpr)` | `name type DEFAULT expr` |
| `ColumnMaterialized(name, typeName, expr)` | `name type MATERIALIZED expr` |
| `ColumnAlias(name, typeName, expr)` | `name type ALIAS expr` |
| `ColumnCodec(name, typeName, codec)` | `name type CODEC(codec)` |
| `ColumnTTL(name, typeName, ttl)` | `name type TTL ttl` |
| `ColumnComment(name, typeName, comment)` | `name type COMMENT 'comment'` |
| `ColumnFull(name, typeName, opts ClickhouseColumnOptions)` | all of the above combined |

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

`ColumnFull` emits at most one default clause, with precedence `Materialized` > `Alias` > `Default`. The rendered order is `name type [DEFAULT|MATERIALIZED|ALIAS expr] [CODEC(...)] [TTL ...] [COMMENT '...']`; single quotes in comments are escaped as `\'`.

```go
table.ColumnFull("amount", "Decimal(18,2)", fluxaorm.ClickhouseColumnOptions{
    Default: "0",
    Codec:   "ZSTD(3)",
    Comment: "order total",
})
// amount Decimal(18,2) DEFAULT 0 CODEC(ZSTD(3)) COMMENT 'order total'
```

### Table-level methods

| Method | Effect |
|--------|--------|
| `Engine(engine)` | `ENGINE = <engine>`; `()` is appended when the value has no parenthesis (`MergeTree` -> `MergeTree()`, `ReplacingMergeTree(Version)` is kept). Required. |
| `OrderBy(columns...)` | `ORDER BY (a, b)`. Required. |
| `PartitionBy(expr)` | `PARTITION BY <expr>` |
| `PrimaryKey(columns...)` | `PRIMARY KEY (a, b)`; ClickHouse defaults it to the `ORDER BY` key when omitted |
| `TTL(expr)` | table-level `TTL <expr>` |
| `Setting(key, value)` | appends one `SETTINGS k = v` pair; call repeatedly for several |
| `Comment(comment)` | `COMMENT '<comment>'` |

## Registering Tables

Register the pool and the table before `Validate()`:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", nil)
registry.RegisterClickhouseTable(table)

engine, err := registry.Validate()
```

`Validate()` checks every registered builder and fails with the first problem:

| Rule | Error |
|------|-------|
| table name empty | `clickhouse table name is required` |
| pool code empty | `clickhouse pool code is required for table '<t>'` |
| no columns | `clickhouse table '<t>' must have at least one column` |
| no engine | `clickhouse table '<t>' must have an engine` |
| no `OrderBy` | `clickhouse table '<t>' must have ORDER BY` |
| pool not registered | `clickhouse pool '<pool>' not registered for table '<t>'` |
| same table registered twice in one pool | `duplicate clickhouse table '<t>' in pool '<pool>' (already registered in pool '<pool>')` |

## GetClickhouseAlters

```go
func GetClickhouseAlters(ctx Context) ([]ClickhouseAlter, error)

type ClickhouseAlter struct {
    SQL    string      // statement to execute
    Pool   string      // ClickHouse pool code
    Kind   AlterKind   // create_table, add_column, change_column, drop_column, modify_table, convert_table, drop_table
    Safety AlterSafety // AlterSafe or AlterDestructive
}

func (a ClickhouseAlter) IsSafe() bool         // a.Safety == AlterSafe
func (a ClickhouseAlter) Exec(ctx Context) error // ctx.Engine().Clickhouse(a.Pool).Exec(ctx, a.SQL)
```

`AlterKind` and `AlterSafety` are the same types the MySQL diff uses; see [Schema Update](/guide/schema_update.html) for their values. The result is sorted by the `SQL` string only, so unlike MySQL alters it is **not** ordered for execution - apply the safe alters first and the destructive ones once the fleet is uniform:

```go
ctx := engine.NewContext(context.Background())

alters, err := fluxaorm.GetClickhouseAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    if !alter.IsSafe() {
        fmt.Printf("pending destructive %s on %s: %s\n", alter.Kind, alter.Pool, alter.SQL)
        continue
    }
    if err := alter.Exec(ctx); err != nil {
        panic(err)
    }
}
```

## What the Diff Emits

For every pool that has registered tables the ORM lists `system.tables` (excluding views), then compares each registered table with `system.columns` and `system.tables`.

| Situation | Statement | Kind | Safety |
|-----------|-----------|------|--------|
| Table missing | `CREATE TABLE ...` (as above) | `create_table` | safe |
| Column in the builder, not in the table | `ALTER TABLE t ADD COLUMN <column sql>;` | `add_column` | safe |
| Column differs in type, default kind (case-insensitive), default expression, comment or codec | `ALTER TABLE t MODIFY COLUMN <column sql>;` | `change_column` | destructive |
| Column in the table, not in the builder | `ALTER TABLE t DROP COLUMN c;` | `drop_column` | destructive |
| `ORDER BY` differs from `system.tables.sorting_key` | `-- TABLE t: ORDER BY mismatch. Current: (...), Expected: (...). Manual recreation required.` | `convert_table` | destructive |
| Engine name differs (compared before the parenthesis) | `-- TABLE t: ENGINE mismatch. Current: X, Expected: Y. Manual recreation required.` | `convert_table` | destructive |
| `PartitionBy` set and differs from `partition_key` | `-- TABLE t: PARTITION BY mismatch. Current: X, Expected: Y. Manual recreation required.` | `convert_table` | destructive |
| `TTL` set and differs (whitespace-collapsed, case-insensitive) from the table's `create_table_query` | `ALTER TABLE t MODIFY TTL <expr>;` | `convert_table` | destructive |
| Builder has any `Setting` | `ALTER TABLE t MODIFY SETTING k = v, ...;` - emitted on **every** run, nothing is compared | `modify_table` | safe |
| `Comment` set and differs from the table comment | `ALTER TABLE t MODIFY COMMENT '...';` | `modify_table` | safe |
| Table exists (engine other than `View`) but is not registered and not ignored | `DROP TABLE IF EXISTS t;` | `drop_table` | destructive |

Notes:

- Codec comparison expects `system.columns.compression_codec` to equal `CODEC(<codec>)`; a column that has a codec in ClickHouse while the builder declares none is also reported as `change_column`. `PrimaryKey` and column-level `TTL` are not compared.
- `MODIFY COLUMN` is destructive because a narrowing type change loses data and the diff cannot tell it from a widening one; `MODIFY TTL` is destructive because shortening a TTL deletes rows. A TTL mismatch additionally prints `TABLE t: TTL mismatch. Current: ..., Expected: ... Manual recreation required.` to stdout.
- The `-- TABLE ...` alters are SQL comments: `Exec` runs them harmlessly and they come back on every run until you recreate the table by hand, because `ENGINE`, `ORDER BY` and `PARTITION BY` cannot be altered in ClickHouse.
- A pool that is registered with `RegisterClickhouse` but has **no** registered tables gets a `DROP TABLE IF EXISTS` for every table it contains, except ignored ones.

::: warning
Every table the ORM does not know about is scheduled for `DROP TABLE`. Protect tables owned by other systems with `ClickhouseOptions.IgnoredTables` when registering the pool (see [Data Pools](/guide/data_pools.html)):

```go
registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", &fluxaorm.ClickhouseOptions{
    IgnoredTables: []string{"raw_imports", "legacy_events"},
})
```
:::

## Complete Example

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterClickhouse("clickhouse://localhost:9000/analytics", "analytics", &fluxaorm.ClickhouseOptions{
        IgnoredTables: []string{"raw_imports"},
    })

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
            ColumnCodec("value", "Float64", "Gorilla").
            Column("ts", "DateTime").
            Engine("ReplacingMergeTree(ts)").
            OrderBy("id").
            Comment("aggregated metrics"),
    )

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    ctx := engine.NewContext(context.Background())

    alters, err := fluxaorm.GetClickhouseAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        fmt.Printf("[%s] %s %s: %s\n", alter.Safety, alter.Kind, alter.Pool, alter.SQL)
        if alter.IsSafe() {
            if err := alter.Exec(ctx); err != nil {
                panic(err)
            }
        }
    }
}
```

::: tip
Run `GetClickhouseAlters` next to `GetAlters` (MySQL), `GetRedisSearchAlters` and `GetNatsAlters` in one deploy step so every store follows the same safe-first, destructive-later rollout; see [Schema Update](/guide/schema_update.html).
:::
