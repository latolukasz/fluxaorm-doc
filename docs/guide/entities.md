---
description: "Defining FluxaORM entities as plain Go structs: the ID field, snowflake IDs, table names, entity-level orm tags such as redisCache, redisSearch, cdc and outbox."
---

# Entities

An entity is a plain Go struct that describes one MySQL table. You write the struct, register it in a [Registry](/guide/registry.html), call `Validate()` and run [code generation](/guide/code_generation.html). The generator produces a typed entity type and a Provider with getters, setters and query methods; the struct itself is never used at runtime.

## Defining an Entity

The only structural requirements are a field named `ID` of type `uint64` that is the **first** field of the struct, and supported [field types](/guide/entity_fields.html). No embedded marker type or interface is needed:

```go
package model

type UserEntity struct {
    ID    uint64
    Name  string `orm:"required"`
    Email string `orm:"required"`
    Age   uint8
}
```

`Validate()` rejects a struct that breaks these rules (the two `ID` errors are wrapped as `invalid entity struct '<type>': ...`):

| Problem | Error |
|---------|-------|
| `ID` missing or not the first field | `field ID on position 1 is missing` |
| `ID` is not `uint64` | `ID column must be uint64, got <type> on <entity>` |
| Unsupported field type | `<entity> field <name> type <type> is not supported` |

The `ID` column becomes `` `ID` bigint unsigned NOT NULL `` and the table's `PRIMARY KEY`. It must be `uint64` because IDs are 63-bit snowflake values (see below).

## Registering and Validating

Register pools and entities, validate, and generate:

```go
package main

import (
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

    registry.RegisterEntity(&UserEntity{}, &ProductEntity{}, &CategoryEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    err = fluxaorm.Generate(engine, "./entities")
    if err != nil {
        panic(err)
    }
}
```

`RegisterEntity(entity ...any)` accepts values or pointers; pointers are dereferenced. Entities are processed in sorted type-name order, so validation errors are deterministic.

### Generated names

Generated names derive from the **table name**, not from the Go struct name: the table name is split on `_`, every part is capitalised and the parts are joined. Without a `table` tag the table name equals the struct name, so `UserEntity` produces:

| Generated | Name |
|-----------|------|
| Entity type | `entities.UserEntity` |
| Provider variable | `entities.UserEntityProvider` |
| Typed field descriptors | `entities.UserEntityProvider.Fields.Name`, `.Fields.Age`, ... |
| Enum types | `enums.<Name>` in the `enums/` sub-package |

With `orm:"table=user_accounts"` the same struct generates `entities.UserAccounts` and `entities.UserAccountsProvider`. See [Code Generation](/guide/code_generation.html) for the full generated API.

The generated type implements `fluxaorm.Entity`; `ctx.Save`, `ctx.Delete`, `ctx.ForceDelete` and `ctx.Reload` accept any number of them (see [CRUD](/guide/crud.html)). Your own struct never implements anything.

### ID assignment

A new entity gets its ID immediately in `Provider.New(ctx)`, which calls `ctx.Engine().NextID()` - not on `Save`. IDs come from an in-process snowflake generator (41 bits of milliseconds since 2024-01-01, 11 bits node, 11 bits sequence) that never touches MySQL or Redis. Every running process must use a distinct node ID (`engine.SetNodeID(node)`, default `0`); see [Engine](/guide/engine.html).

```go
user := entities.UserEntityProvider.New(ctx) // user.GetID() is already set
user.SetName("Alice").SetEmail("alice@example.com")
err := ctx.Save(user)
```

## Entity-Level Tags

Entity-level options are `orm` tags placed on the `ID` field. Several tags are combined with `;`:

```go
type OrderEntity struct {
    ID uint64 `orm:"table=orders;mysql=sales;redisCache;cdc"`
}
```

### Table name

By default the table is named after the struct (`UserEntity`). Override it with `table=`:

```go
type UserEntity struct {
    ID uint64 `orm:"table=users"`
}
```

### MySQL pool

Every entity lives in the `default` MySQL pool unless `mysql=` names another registered pool. A missing pool fails validation with `mysql pool '<code>' not found`:

```go
type OrderEntity struct {
    ID uint64 `orm:"mysql=sales"`
}

registry.RegisterMySQL("user:password@tcp(localhost:3306)/app", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
registry.RegisterMySQL("user:password@tcp(localhost:3307)/sales", "sales", &fluxaorm.MySQLOptions{})
```

### Redis row cache

`redisCache` caches rows loaded by ID in Redis. A bare tag uses the `default` Redis pool, `redisCache=orders` uses pool `orders` (`redis pool '<code>' not found` otherwise). Every cached row expires after `EntityCacheTTL` (one hour); writes invalidate keys, they never refresh them. Details, key layout and invalidation are in [Redis Cache](/guide/redis_cache.html).

```go
type UserEntity struct {
    ID uint64 `orm:"redisCache"`
}
```

### Redis Search

Fields tagged `searchable` (optionally `sortable`) are indexed in Redis Search. The index lives in the `default` Redis pool unless `redisSearch=pool` is set on `ID` (`redis pool '<code>' not found for redisSearch in entity '<name>'` when the pool is missing). See [Redis Search](/guide/redis_search.html).

```go
type ProductEntity struct {
    ID    uint64  `orm:"redisSearch=search"`
    Name  string  `orm:"required;searchable"`
    Price float64 `orm:"searchable;sortable"`
}
```

### Change events: `cdc` and `outbox`

`cdc` publishes an insert/update/delete event to NATS JetStream after every committed write of the entity. `outbox` additionally stores the event as a row of `fluxaorm.CDCOutboxEntity` inside the same transaction, so it can be relayed if the publish fails; `outbox` without `cdc` keeps a change log only.

```go
type OrderEntity struct {
    ID uint64 `orm:"cdc;outbox"`
}
```

Consumers are declared with `fluxaorm.ConsumerDef`, not on the entity. A `cdc` entity must be declared by at least one `ConsumerDef`, otherwise `Validate()` fails with `entity '<name>' is tagged `orm:"cdc"` but no consumer declares it, so its events would be published and never read; add it to a ConsumerDef or drop the tag`. An `outbox` entity requires `fluxaorm.CDCOutboxEntity{}` to be registered on the **same** MySQL pool; `Validate()` otherwise fails with `entity '<name>' is tagged `orm:"outbox"` but fluxaorm.CDCOutboxEntity is not registered; add registry.RegisterEntity(fluxaorm.CDCOutboxEntity{})` or `entity '<name>' is tagged `orm:"outbox"` on mysql pool '<a>' but the outbox table is on pool '<b>'; the outbox row would not be in the same transaction`. See [Entity Events](/guide/entity_events.html) and [Outbox](/guide/outbox.html).

::: warning Migration note
The old `orm:"dirty=..."` tag is rejected at `Validate()`: `entity '<name>' uses `orm:"dirty=..."`, which no longer exists; tag it `orm:"cdc"` and declare the entity on a fluxaorm.ConsumerDef instead`.
:::

## Well-Known Fields

Some fields are recognised by name and type and get special behaviour.

### `FakeDelete bool` - soft delete

When the struct has a top-level field `FakeDelete bool`, `ctx.Delete(entity)` marks the row instead of removing it and `ctx.ForceDelete(entity)` removes it for real. The column is stored as `bigint unsigned` holding the row's own ID, which lets the ORM append it to every unique index. See [Fake Delete](/guide/fake_delete.html).

```go
type ProductEntity struct {
    ID         uint64
    Name       string `orm:"required"`
    FakeDelete bool
}
```

### `CreatedAt` / `UpdatedAt time.Time` - timestamps

Fields named `CreatedAt` and `UpdatedAt` of type `time.Time` are always `datetime` columns (the `time` tag is implied) and are maintained automatically:

- on INSERT both are set to `time.Now().UTC().Truncate(time.Second)` if they are zero - a value you set yourself is kept;
- on UPDATE `UpdatedAt` is always overwritten.

Both are excluded from the change maps passed to after-update handlers and change events.

```go
type UserEntity struct {
    ID        uint64
    Name      string `orm:"required"`
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

## References

Relations to other entities are declared with `fluxaorm.Reference[T]` (one ID, `bigint unsigned`) and `fluxaorm.References[T]` (a JSON array of IDs in a `text` column). A plain pointer to a registered entity is **not** supported.

```go
type ProductEntity struct {
    ID       uint64
    Category fluxaorm.Reference[CategoryEntity]  `orm:"required"`
    Tags     fluxaorm.References[TagEntity]
}
```

The generator emits `GetCategoryID()`, `SetCategory(id)`, `GetCategory(ctx)`, `MustGetCategory(ctx)`, `GetTagsIDs()`, `SetTagsIDs(ids)` and `GetTags(ctx)`. Column types and accessors are described in [Entity Fields](/guide/entity_fields.html).

## Indexes

Unique and non-unique indexes are declared by implementing `UniqueIndexes() [][]string`, `CachedUniqueIndexes() [][]string` and `Indexes() [][]string` on the struct. Index names are generated from the column names. See [MySQL Indexes](/guide/mysql_indexes.html).

```go
func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{{"Email"}}
}
```

## Redis Key Namespaces

Every entity with `redisCache` or cached unique indexes owns a Redis key prefix derived from its MySQL pool and table name, and every Redis Search entity owns a hash prefix. `Validate()` refuses two entities whose prefixes collide: `redis key prefix "<prefix>" is claimed by both <A> (<kind>) and <B> (<kind>); rename one of the tables`.

## Complete Example

```go
package model

import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"redisCache"`
    Name string `orm:"required"`
}

func (e CategoryEntity) UniqueIndexes() [][]string {
    return [][]string{{"Name"}}
}

type UserEntity struct {
    ID        uint64 `orm:"redisCache;cdc"`
    Name      string `orm:"required"`
    Email     string `orm:"required"`
    Age       uint8
    Active    bool
    CreatedAt time.Time
    UpdatedAt time.Time
}

func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{{"Email"}}
}

func (e UserEntity) CachedUniqueIndexes() [][]string {
    return [][]string{{"Email"}}
}

type ProductEntity struct {
    ID         uint64  `orm:"table=products;redisCache"`
    Name       string  `orm:"required;searchable"`
    Price      float64 `orm:"decimal=10,2;unsigned;searchable;sortable"`
    Status     string  `orm:"enum=draft,active,archived;required"`
    Category   fluxaorm.Reference[CategoryEntity] `orm:"required"`
    FakeDelete bool
    CreatedAt  time.Time
    UpdatedAt  time.Time
}
```

## Struct Tags Reference

Tags use the `orm` key, are separated by `;`, and a tag without `=value` is a boolean flag. Unknown tags are ignored silently, so check spelling carefully.

| Tag | Placement | Value | Effect | Default |
|-----|-----------|-------|--------|---------|
| `table=name` | `ID` | table name | MySQL table name; also drives generated type names | struct name |
| `mysql=pool` | `ID` | pool code | MySQL pool of the entity (bare `mysql` means `default`) | `default` |
| `redisCache` / `redisCache=pool` | `ID` | pool code | Enable the Redis row cache in that pool | off; bare = `default` |
| `ttl=N` | `ID` | integer | Parsed and validated (`invalid ttl '<v>' for entity '<name>'`) but not used by any read path; rows always expire after `EntityCacheTTL` (1 hour) | - |
| `redisSearch` / `redisSearch=pool` | `ID` | pool code | Redis pool of the Redis Search index (only relevant with `searchable` fields) | `default` |
| `cdc` | `ID` | flag | Publish entity change events to NATS | off |
| `outbox` | `ID` | flag | Store change events in `CDCOutboxEntity` within the write transaction | off |
| `required` | field | flag | `NOT NULL` with a non-null default; for strings, enums, sets, references, JSON and blobs it decides nullability | nullable where applicable |
| `length=N` / `length=max` | `string` | int <= 65535 or `max` | `varchar(N)` or `mediumtext` (`invalid max string: <v>` otherwise) | `255` |
| `enum=a,b,c` / `enum` | `string` | csv or flag | MySQL `ENUM`; bare `enum` references a shared definition and requires `enumName` | - |
| `set=a,b,c` / `set` | `string` | csv or flag | MySQL `SET`; bare `set` requires `enumName` | - |
| `enumName=Name` | `string` | identifier | Name of the generated enum type; alone it references an enum defined elsewhere | `<EntityPrefix><Field>` |
| `time` | `time.Time`, `*time.Time` | flag | `datetime` instead of `date` (implied for `CreatedAt`/`UpdatedAt`) | `date` |
| `decimal=X,Y` | `float32`, `float64` | two ints | `decimal(X,Y)` column | `float` / `double` |
| `unsigned` | `float32`, `float64` | flag | Append ` unsigned` to the float column (ignored on integers) | signed |
| `precision=N` | `float32`, `float64` | int | Number of decimals used by the setter's dirty check, by the Redis row cache when formatting the value, and by Redis Search; no effect on the column | `8` (`float64`), `4` (`float32`), `Y` of `decimal=X,Y` |
| `mediumint` | `int32`, `uint32` | flag | `mediumint` / `mediumint unsigned` | `int` |
| `mediumblob` / `longblob` | `[]uint8` | flag | Blob size | `blob` |
| `searchable` | field | flag | Include the field in the Redis Search index | off |
| `sortable` | field | flag | Make the field `SORTABLE` in Redis Search (needs `searchable`) | off |
| `ignore` | field | flag | Skip the field entirely - no column, no accessors | - |
