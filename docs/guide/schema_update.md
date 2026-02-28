# Schema Update

One of the main benefits of using an ORM is the ability to generate and update a database schema based on the data structures in your code. In FluxaORM, these data structures are represented as registered entities.

## MySQL Schema Alterations

The recommended approach is to use the `GetAlters()` function. This function compares the current MySQL schema in all MySQL databases used by the registered entities and returns detailed information that can be used to update the schema:

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"mysql=products"`
    Name string `orm:"required"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(&CategoryEntity{})
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
        fmt.Println(alter.SQL)  // e.g. "CREATE TABLE `CategoryEntity` ..."
        fmt.Println(alter.Pool) // e.g. "products"
    }
}
```

Each `fluxaorm.Alter` has the following fields:

| Field  | Type     | Description |
|--------|----------|-------------|
| `SQL`  | `string` | The SQL statement to execute |
| `Pool` | `string` | The MySQL pool code this alter belongs to |

To execute all the alters, use the `Exec()` method, passing the context:

```go
for _, alter := range alters {
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

::: tip
Make sure to execute all the alters in the exact order they are returned by the `GetAlters()` function.
:::

::: warning
FluxaORM generates `DROP TABLE ...` queries for all tables in the registered MySQL database that are not mapped as entities.
See [ignored tables](/guide/data_pools.html#ignored-tables) section for how to register ignored MySQL tables.
:::

## Updating a Single Entity Schema

You can also update the schema for a single entity using the `entitySchema` object. This is useful when you want to update only one table rather than all tables at once:

```go
ctx := engine.NewContext(context.Background())

// GetSchemaChanges returns pending alterations for this entity
alters, hasChanges, err := entitySchema.GetSchemaChanges(ctx)
if err != nil {
    panic(err)
}
if hasChanges {
    for _, alter := range alters {
        fmt.Println(alter.SQL)  // "CREATE TABLE `CategoryEntity` ..."
        fmt.Println(alter.Pool) // "products"
        err = alter.Exec(ctx)
        if err != nil {
            panic(err)
        }
    }
}
```

For convenience, you can use the following shorthand methods:

```go
// Executes all pending schema alters
err = entitySchema.UpdateSchema(ctx)

// Updates schema and then truncates the table (deletes all rows, resets auto-increment)
err = entitySchema.UpdateSchemaAndTruncateTable(ctx)
```

The `entitySchema` also provides methods for managing the entity table directly:

```go
err = entitySchema.DropTable(ctx)     // drops the entire table
err = entitySchema.TruncateTable(ctx) // truncates the table
```

## Redis Search Index Alterations

If you use Redis Search indexing (via the `redisSearch` and `searchable` struct tags), you can retrieve and apply pending Redis Search index changes with `GetRedisSearchAlters()`:

```go
alters, err := fluxaorm.GetRedisSearchAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    fmt.Println(alter.IndexName) // e.g. "UserEntity_a1b2c3d4"
    fmt.Println(alter.RedisPool) // e.g. "default"
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

Each `fluxaorm.RedisSearchAlter` has the following fields:

| Field       | Type     | Description |
|-------------|----------|-------------|
| `IndexName` | `string` | The Redis Search index name |
| `RedisPool` | `string` | The Redis pool code this index belongs to |

The `Exec(ctx)` method executes the `FT.CREATE` command to create the index. Only indexes that do not yet exist are returned by `GetRedisSearchAlters()` -- existing indexes with a matching name are skipped.

::: tip
Call `GetRedisSearchAlters()` after `GetAlters()` in your migration flow to ensure both MySQL tables and Redis Search indexes are up to date.
:::
