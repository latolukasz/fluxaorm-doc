---
description: "Updating the MySQL schema with FluxaORM: GetAlters returns safe and destructive alters derived from your entities, which you review and execute yourself."
---

# Schema Update

FluxaORM derives the MySQL schema from the registered entities and computes the statements needed to bring the live database in line with it. Nothing is executed implicitly: `GetAlters` returns a plan, every statement is classified as **safe** or **destructive**, and your deploy code decides what to run and when.

## GetAlters

```go
func GetAlters(ctx Context) (alters []Alter, err error)
```

`GetAlters` inspects every registered MySQL pool (`SHOW FULL TABLES`, `SHOW CREATE TABLE`, `SHOW INDEXES`), diffs each entity against its table, adds a `DROP TABLE` for every table without an entity, and returns the result sorted deterministically by pool, table, kind rank and SQL.

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterEntity(&UserEntity{}, &ProductEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    ctx := engine.NewContext(context.Background())

    alters, err := fluxaorm.GetAlters(ctx)
    if err != nil {
        panic(err)
    }
    for _, alter := range alters {
        fmt.Printf("[%s] %s %s.%s: %s\n", alter.Safety, alter.Kind, alter.Pool, alter.Table, alter.Reason)
        fmt.Println(alter.SQL)
    }
}
```

### The `Alter` type

```go
type Alter struct {
    SQL    string      // statement to execute, database-qualified
    Pool   string      // MySQL pool code
    Kind   AlterKind   // what the statement does
    Table  string      // table name
    Entity string      // Go type of the entity, e.g. "model.UserEntity"; empty for a table with no registered entity
    Safety AlterSafety // AlterSafe or AlterDestructive
    Reason string      // why it was emitted / why it is destructive; empty for plain safe statements
}

func (a Alter) Exec(ctx Context) error // ctx.Engine().DB(a.Pool).Exec(ctx, a.SQL)
func (a Alter) IsSafe() bool           // a.Safety == AlterSafe
```

### `AlterSafety`

```go
type AlterSafety uint8

const (
    AlterDestructive AlterSafety = iota // zero value: an unclassified statement fails closed
    AlterSafe
)

func (s AlterSafety) String() string // "safe" or "destructive"
```

`AlterSafe` answers one question: *can the previous code version keep running against this statement?* Adding a nullable column or a plain index is safe. Changing a column type, dropping anything, or adding a unique index is destructive.

```go
func SplitAlters(in []Alter) (safe, destructive []Alter)
```

### `AlterKind`

`AlterKind` is a `string` used for metric labels and for ordering. The rank column is the execution order within one table:

| Constant | Value | Rank | Typical safety |
|----------|-------|------|----------------|
| `AlterKindCreateTable` | `create_table` | 0 | safe |
| `AlterKindAddColumn` | `add_column` | 10 | safe (destructive when `NOT NULL` without `DEFAULT`) |
| `AlterKindSetDefault` | `set_default` | 11 | safe |
| `AlterKindAddIndex` | `add_index` | 20 | safe (destructive when it indexes a deferred column) |
| `AlterKindAddUniqueIndex` | `add_unique_index` | 20 | destructive |
| `AlterKindRebuildIndex` | `rebuild_index` | 30 | destructive |
| `AlterKindModifyTable` | `modify_table` | 35 | (ClickHouse and NATS alters only) |
| `AlterKindChangeColumn` | `change_column` | 40 | destructive |
| `AlterKindDropForeignKey` | `drop_foreign_key` | 45 | destructive |
| `AlterKindDropIndex` | `drop_index` | 50 | destructive |
| `AlterKindDropColumn` | `drop_column` | 60 | destructive |
| `AlterKindConvertTable` | `convert_table` | 70 | destructive |
| `AlterKindDropTable` | `drop_table` | 80 | destructive |

```go
func AllAlterKinds() []AlterKind // every kind, sorted, for building a policy over them
```

## The Rolling-Deploy Contract

The plan is designed for deployments where the old and the new code version run side by side for a while:

1. **During the rollout** (old pods still live) apply only the safe alters, in the returned order. The previous version keeps inserting and reading without errors.
2. **After the fleet is uniform** (only the new version is running) apply the destructive alters.

Because the plan is recomputed from the live schema every time, running `GetAlters` again after step 1 returns exactly the destructive remainder.

```go
package main

import (
    "context"
    "fmt"
    "os"

    "github.com/latolukasz/fluxaorm/v2"
)

// applySchema runs on boot. Destructive alters run only when APPLY_DESTRUCTIVE_ALTERS=1,
// which the pipeline sets for the post-rollout job.
func applySchema(ctx fluxaorm.Context) error {
    alters, err := fluxaorm.GetAlters(ctx)
    if err != nil {
        return err
    }
    safe, destructive := fluxaorm.SplitAlters(alters)

    for _, alter := range safe {
        if err := alter.Exec(ctx); err != nil {
            return fmt.Errorf("%s on %s.%s: %w", alter.Kind, alter.Pool, alter.Table, err)
        }
    }

    if os.Getenv("APPLY_DESTRUCTIVE_ALTERS") != "1" {
        for _, alter := range destructive {
            fmt.Printf("pending destructive alter %s on %s.%s (%s)\n", alter.Kind, alter.Pool, alter.Table, alter.Reason)
        }
        return nil
    }
    for _, alter := range destructive {
        if err := alter.Exec(ctx); err != nil {
            return fmt.Errorf("%s on %s.%s: %w", alter.Kind, alter.Pool, alter.Table, err)
        }
    }
    return nil
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterEntity(&UserEntity{}, &ProductEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    if err := applySchema(engine.NewContext(context.Background())); err != nil {
        panic(err)
    }
}
```

::: tip
Keep the returned order inside each group. `set_default` is ranked directly after `add_column` because between the two statements a required text column exists without a default, and an INSERT that omits it fails with MySQL error 1364.
:::

## What the Diff Emits

### New table

A missing table produces a single safe `create_table`:

```sql
CREATE TABLE `app`.`UserEntity` (
  `ID` bigint unsigned NOT NULL,
  `Name` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT '',
  `Age` tinyint unsigned NOT NULL DEFAULT '0',
  UNIQUE INDEX `Name` (`Name`),
 PRIMARY KEY (`ID`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

Columns follow struct field order; the charset and collation come from `MySQLOptions.DefaultEncoding` (`utf8mb4`) and `DefaultCollate` (`0900_ai_ci`).

### Existing table

The diff emits **one `Alter` per unit of work** and is keyed by **column name, never position** - reordering struct fields emits nothing.

| Situation | Kind / safety | Statement | Reason |
|-----------|---------------|-----------|--------|
| New column | `add_column`, safe | ``ALTER TABLE `db`.`t`\n    ADD COLUMN <def> [AFTER `prev`], ALGORITHM=INSTANT;`` - `AFTER` only when the preceding struct column already exists | - |
| New `NOT NULL` column without a `DEFAULT` | `add_column`, **destructive** | as above; the column is marked *deferred* | `NOT NULL without DEFAULT` |
| New required text/blob column | `add_column` safe + `set_default` safe | the `DEFAULT ('')` expression cannot ride on an INSTANT `ADD COLUMN`, so it is split into a following `MODIFY <def>, ALGORITHM=INSTANT` | `adding the column default the ADD could not carry` |
| Same column, only the `DEFAULT` differs | `set_default`, safe | `MODIFY <def>, ALGORITHM=INSTANT` | `column default changed` |
| Same column, any other difference | `change_column`, destructive | ``CHANGE COLUMN `c` <def>`` | `CHANGED FROM <live definition>` |
| Column not in the entity | `drop_column`, destructive | ``DROP COLUMN `c` `` | `column is no longer part of the entity` |
| `CONSTRAINT` (foreign key) on the table | `drop_foreign_key`, destructive | `DROP FOREIGN KEY <name>` - reported on every run until dropped | `foreign keys are not part of the entity schema` |
| New plain index | `add_index`, safe | ``ADD INDEX `n` (`a`,`b`)`` | - |
| New unique index | `add_unique_index`, destructive | ``ADD UNIQUE INDEX `n` (`a`)`` | `unique index cannot be added during a rollout` |
| Plain index over a deferred column | `add_index`, destructive | as above | `indexes a column that is itself deferred` |
| Index with same name, different definition | `rebuild_index`, destructive | ``DROP INDEX `n`,\n    ADD ... `n` (...)`` in one statement | `index definition changed` |
| Index not in the entity (except `PRIMARY`) | `drop_index`, destructive | ``DROP INDEX `n` `` | `index is no longer part of the entity` |
| Table charset differs from `DefaultEncoding` or engine is not InnoDB | `convert_table`, destructive | ``ALTER TABLE `db`.`t`\n ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;`` | `table rebuild: engine or charset conversion` |
| Table without a registered entity | `drop_table`, destructive, `Entity == ""` | ``DROP TABLE IF EXISTS `db`.`t`;`` | `table has no registered entity` |

Notes:

- `ALGORITHM=INSTANT` is pinned on every `ADD COLUMN` and `MODIFY`, so MySQL fails loudly instead of silently falling back to a table rebuild.
- Column equivalence tolerates MySQL's rendering differences: a missing `DEFAULT NULL` on a nullable column and the charset introducer in `DEFAULT (_utf8mb4'')` are not reported as changes. Applying the plan and calling `GetAlters` again must yield nothing.
- `FakeDelete` handling (appending the column to indexes and adding a `FakeDelete` index) happens before the diff; see [MySQL Indexes](/guide/mysql_indexes.html).

::: warning
Every table in a registered MySQL database that has no entity is scheduled for `DROP TABLE`. List tables the ORM should leave alone in `MySQLOptions.IgnoredTables` (see [Data Pools](/guide/data_pools.html)).
:::

## Other Alter Families

The same `Kind` / `Safety` / `IsSafe()` / `Exec(ctx)` shape exists for the other stores. They are described on their own pages; call them alongside `GetAlters` in your deploy flow.

| Function | Alter type | Page |
|----------|------------|------|
| `func GetRedisSearchAlters(ctx Context) ([]RedisSearchAlter, error)` | `RedisSearchAlter{IndexName, RedisPool, Kind, Safety}` - creates missing `FT` indexes (safe) and drops stale ones (destructive) | [Redis Search](/guide/redis_search.html) |
| `func GetClickhouseAlters(ctx Context) ([]ClickhouseAlter, error)` | `ClickhouseAlter{SQL, Pool, Kind, Safety}` | [ClickHouse Schema](/guide/clickhouse_schema.html) |
| `func GetNatsAlters(ctx Context) ([]NatsAlter, error)` | `NatsAlter{Description, PoolCode, Kind, Safety}` - streams and consumers | [NATS](/guide/nats.html) |
