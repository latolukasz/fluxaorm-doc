---
description: "Searching FluxaORM entities in MySQL with the type-safe DBQuery builder, typed field descriptors, Where, Pager, SearchOne, SearchMany, SearchManyWithTotal and Count."
---

# Search

[CRUD](/guide/crud.html) covers loading entities by primary key. This section covers finding entities by their column values with the type-safe query builder `fluxaorm.DBQuery`, sorting, pagination, and the generated `SearchOne`, `SearchMany`, `SearchManyWithTotal` and `Count` methods.

All search methods are generated on the entity's Provider and return plain slices. They select only the `ID` column in SQL and then hydrate the entities through `GetByID`/`GetByIDs`, so results pass through the [context cache](/guide/context_cache.html) and the [Redis row cache](/guide/redis_cache.html) exactly like primary-key loads.

## Typed Field Descriptors

After [code generation](/guide/code_generation.html) every Provider has a `Fields` struct with one typed descriptor per column. Descriptors build `fluxaorm.Condition` values for `Filter()` and implement `fluxaorm.Field` for `SortByASC()`/`SortByDESC()`.

```go
// Entity definition
type UserEntity struct {
    ID        uint64 `orm:"redisCache"`
    Name      string `orm:"required"`
    Email     string
    Age       uint32
    Score     *float64
    Status    string `orm:"enum=active,inactive;required"`
    Country   fluxaorm.Reference[CountryEntity]
    CreatedAt time.Time
}

func (e UserEntity) UniqueIndexes() [][]string       { return [][]string{{"Email"}} }
func (e UserEntity) CachedUniqueIndexes() [][]string { return [][]string{{"Email"}} }

// Generated descriptors (package entities):
// entities.UserEntityProvider.Fields.ID        fluxaorm.UintField
// entities.UserEntityProvider.Fields.Name      fluxaorm.StringField
// entities.UserEntityProvider.Fields.Email     fluxaorm.NullableStringField  (string without `required`)
// entities.UserEntityProvider.Fields.Age       fluxaorm.UintField
// entities.UserEntityProvider.Fields.Score     fluxaorm.NullableFloatField
// entities.UserEntityProvider.Fields.Status    fluxaorm.EnumField
// entities.UserEntityProvider.Fields.Country   fluxaorm.NullableUintField    (Reference without `required`)
// entities.UserEntityProvider.Fields.CreatedAt fluxaorm.TimeField
```

### Go type to descriptor mapping

| Go field | Tag | Descriptor |
|----------|-----|------------|
| `ID uint64` | | `UintField` (always) |
| `uint8` .. `uint64` | | `UintField` |
| `int8` .. `int64` | | `IntField` |
| `float32`, `float64` | | `FloatField` |
| `bool` | | `BoolField` |
| `time.Time` (date or `orm:"time"`) | | `TimeField` |
| `string` | `required` | `StringField` |
| `string` | (not required) | `NullableStringField` |
| `string` | `enum=...` or `enumName=...` + `required` | `EnumField` |
| `string` | `enum=...` or `enumName=...`, not required | `NullableEnumField` |
| `fluxaorm.Reference[T]` | `required` | `ReferenceField` |
| `fluxaorm.Reference[T]` | (not required) | `NullableUintField` |
| `*uint8` .. `*uint64` | | `NullableUintField` |
| `*int8` .. `*int64` | | `NullableIntField` |
| `*float32`, `*float64` | | `NullableFloatField` |
| `*bool` | | `NullableBoolField` |
| `*time.Time` | | `NullableTimeField` |
| `*string` | | `NullableStringField` |

Not present in `Fields`: the `FakeDelete` column, `[]uint8` (blob) columns, `set=` columns, `fluxaorm.References[T]` columns and JSON struct pointer columns.

::: tip
The `fluxaorm.NullableReferenceField` type exists in the library but the generator never emits it: an optional reference is exposed as `NullableUintField`, which has the same `Eq`/`In`/`IsNull`/`IsNotNull` methods.
:::

### Condition methods per descriptor

Every method returns a `fluxaorm.Condition`. Column names are always back-quoted in the generated SQL.

| Descriptor | Methods | SQL |
|------------|---------|-----|
| `UintField` | `Eq(v uint64)`, `Gte(v uint64)`, `Lte(v uint64)`, `Gt(v uint64)`, `Lt(v uint64)`, `In(values ...uint64)` | `` `col` = ? ``, `>=`, `<=`, `>`, `<`, `` `col` IN (?,?,...) `` |
| `IntField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt` (`int64`), `In(values ...int64)` | same |
| `FloatField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt` (`float64`), `In(values ...float64)` | same |
| `TimeField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt` (`time.Time`) | same, no `In` |
| `StringField` | `Is(v string)`, `Like(v string)`, `In(values ...string)`, `IsEmpty()` | `` `col` = ? ``, `` `col` LIKE ? ``, `IN`, `` `col` = '' `` |
| `BoolField` | `Is(v bool)` | `` `col` = ? `` |
| `EnumField` | `Is(v any)`, `In(values ...any)` | `` `col` = ? ``, `IN` |
| `ReferenceField` | `Eq(v uint64)`, `In(values ...uint64)` | `` `col` = ? ``, `IN` |
| `NullableUintField` | `UintField` methods + `IsNull()`, `IsNotNull()` | `` `col` IS NULL ``, `` `col` IS NOT NULL `` |
| `NullableIntField` | `IntField` methods + `IsNull()`, `IsNotNull()` | |
| `NullableFloatField` | `FloatField` methods + `IsNull()`, `IsNotNull()` | |
| `NullableTimeField` | `TimeField` methods + `IsNull()`, `IsNotNull()` | |
| `NullableStringField` | `Is`, `Like`, `In`, `IsEmpty()` + `IsNull()`, `IsNotNull()` | |
| `NullableBoolField` | `Is(v bool)` + `IsNull()`, `IsNotNull()` | |
| `NullableEnumField` | `Is(v any)`, `In(values ...any)` + `IsNull()`, `IsNotNull()` | |

`EnumField.Is`/`In` take `any`, so you can pass the generated enum constants directly:

```go
import "myapp/entities/enums"

entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)
entities.UserEntityProvider.Fields.Status.In(enums.UserStatusList.Active, enums.UserStatusList.Inactive)
```

### Negating a condition

Every `Condition` has `Not() Condition`, which wraps the predicate in `NOT (...)`. Calling `Not()` on an already negated condition returns the original one.

```go
entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Inactive).Not()
// NOT (`Status` = ?)

entities.UserEntityProvider.Fields.Name.Like("%test%").Not()
// NOT (`Name` LIKE ?)
```

## Building Queries with NewQuery

`fluxaorm.NewQuery()` returns an empty `*fluxaorm.DBQuery`. All builder methods return the query, so they chain:

```go
import "github.com/latolukasz/fluxaorm/v2"

query := fluxaorm.NewQuery().
    Filter(
        entities.UserEntityProvider.Fields.Age.Gte(18),
        entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active),
    ).
    SortByDESC(entities.UserEntityProvider.Fields.CreatedAt).
    Pager(fluxaorm.NewPager(1, 20))
// SELECT `ID` FROM `UserEntity` WHERE `Age` >= ? AND `Status` = ? ORDER BY `CreatedAt` DESC LIMIT 0,20
```

| Method | Behaviour |
|--------|-----------|
| `Filter(conditions ...Condition) *DBQuery` | **Appends** typed conditions. Every call adds to the list; all conditions are joined with `AND`. |
| `FilterWhere(w Where) *DBQuery` | Sets the single raw `Where` slot. A second call **replaces** the first one. |
| `SortByASC(f Field) *DBQuery` / `SortByDESC(f Field) *DBQuery` | Append a sort clause; several calls produce `ORDER BY a ASC, b DESC`. |
| `Pager(p *Pager) *DBQuery` | Sets the `LIMIT` clause. Without a pager `SearchMany` has **no** `LIMIT`. |
| `GetConditions() []Condition` | Returns the typed conditions (used by generated `SearchOne` for cached unique index detection). |
| `BuildWhereClause() (string, []any)` | Typed conditions followed by the raw where, joined with `AND`; `""`, `nil` when empty. |
| `BuildOrderClause() string` | `ORDER BY ...` or `""`. |
| `BuildLimitClause() string` | `pager.String()` or `""`. |
| `IsWithFakeDeletes() bool` | `true` only when the raw where was created with `WithFakeDeletes()`. |

### FilterWhere: raw SQL fallback

For predicates that the typed descriptors cannot express, pass a `Where` built with `fluxaorm.NewWhere()`. Typed conditions and the raw where are combined with `AND`:

```go
query := fluxaorm.NewQuery().
    Filter(entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)).
    FilterWhere(fluxaorm.NewWhere("(`Name` LIKE ? OR `Email` LIKE ?)", "%john%", "%john%"))
// WHERE `Status` = ? AND (`Name` LIKE ? OR `Email` LIKE ?)
```

::: warning
`FilterWhere` holds one `Where`. If you need several raw fragments, build one `Where` and extend it with `Append()` instead of calling `FilterWhere` twice.
:::

### The Where object

`func fluxaorm.NewWhere(query string, parameters ...any) *fluxaorm.BaseWhere` creates a raw SQL fragment with `?` placeholders. `*BaseWhere` implements the `fluxaorm.Where` interface (`String()`, `GetParameters()`, `IsWithFakeDeletes()`).

```go
where := fluxaorm.NewWhere("`Email` = ? AND `Age` >= ?", "alice@example.com", 18)
where.String()        // "`Email` = ? AND `Age` >= ?"
where.GetParameters() // []any{"alice@example.com", 18}

// A slice or array parameter expands the first "IN ?" into "IN (?,?,...)":
where = fluxaorm.NewWhere("`Age` IN ?", []int{18, 20, 30})
where.String()        // "`Age` IN (?,?,?)"
where.GetParameters() // []any{18, 20, 30}

// Extend an existing where (a leading space is added when missing):
where.Append("AND `Status` = ?", "active")
where.String()        // "`Age` IN (?,?,?) AND `Status` = ?"

// Replace parameters after construction:
where.SetParameter(1, 21)          // 1-based index
where.SetParameters(21, 22, 23, "active")
```

| Method | Description |
|--------|-------------|
| `String() string` | The SQL fragment |
| `GetParameters() []any` | The bound parameters |
| `Append(query string, parameters ...any)` | Appends another fragment and its parameters |
| `SetParameter(index int, param any) *BaseWhere` | Replaces one parameter (1-based) |
| `SetParameters(params ...any) *BaseWhere` | Replaces all parameters |
| `WithFakeDeletes() *BaseWhere` | Marks the query to include fake-deleted rows (see below) |
| `IsWithFakeDeletes() bool` | Whether `WithFakeDeletes()` was called |

## Pager

`fluxaorm.NewPager(currentPage, pageSize int) *fluxaorm.Pager` describes one page. Pages are 1-based; `String()` renders `LIMIT <(page-1)*size>,<size>`.

```go
pager := fluxaorm.NewPager(1, 100)
pager.GetPageSize()    // 100
pager.GetCurrentPage() // 1
pager.String()         // "LIMIT 0,100"

pager.IncrementPage()
pager.GetCurrentPage() // 2
pager.String()         // "LIMIT 100,100"

// The fields are exported as well:
pager.CurrentPage = 5
pager.PageSize = 25
```

The pager performs no validation: page `0` or a negative page produces a negative offset, so always start from page `1`.

## SearchMany

```go
func (p userEntityProvider) SearchMany(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*entities.UserEntity, error)
```

Runs `SELECT ID FROM <table> [WHERE ...] [ORDER BY ...] [LIMIT ...]` and hydrates the ids with `GetByIDs`. Without a `Pager` there is no `LIMIT`, so an empty query loads the whole table.

```go
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Age.Gte(18)).
        SortByASC(entities.UserEntityProvider.Fields.Name).
        Pager(fluxaorm.NewPager(1, 100)),
)
if err != nil {
    return err
}
for _, user := range users {
    fmt.Println(user.GetName())
}
```

The returned slice keeps the SQL order. Entities are hydrated through `GetByIDs`, so each one is served from the context cache when already loaded, from the Redis row cache when the entity has `redisCache`, and otherwise loaded with a single `SELECT ... WHERE ID IN (...)`. Every loaded entity is placed in the context cache, so two searches in one `Context` that return the same row give you the same pointer.

## SearchManyWithTotal

```go
func (p userEntityProvider) SearchManyWithTotal(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*entities.UserEntity, int, error)
```

Runs `SELECT COUNT(*)` with the query's `WHERE` first. When the count is `0` it returns `nil, 0, nil` without a second query; otherwise it runs the same id query as `SearchMany` (with the pager) and returns the page plus the total.

```go
users, total, err := entities.UserEntityProvider.SearchManyWithTotal(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)).
        SortByDESC(entities.UserEntityProvider.Fields.CreatedAt).
        Pager(fluxaorm.NewPager(1, 20)),
)
fmt.Printf("showing %d of %d users\n", len(users), total)
```

## Count

```go
func (p userEntityProvider) Count(ctx fluxaorm.Context, query *fluxaorm.DBQuery) (int, error)
```

Runs only `SELECT COUNT(*) FROM <table> [WHERE ...]`. Sort clauses and the pager are ignored.

```go
active, err := entities.UserEntityProvider.Count(ctx,
    fluxaorm.NewQuery().Filter(entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)),
)
```

## SearchOne

```go
func (p userEntityProvider) SearchOne(ctx fluxaorm.Context, query *fluxaorm.DBQuery) (*entities.UserEntity, bool, error)
```

Runs the id query with `LIMIT 1` (honouring `ORDER BY`) and returns `GetByID` of the found id. `found` is `false` with a `nil` error when no row matches. A `Pager` on the query is ignored.

```go
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Email.Is("alice@example.com")),
)
if err != nil {
    return err
}
if !found {
    fmt.Println("not found")
    return nil
}
fmt.Println(user.GetName())
```

### Cached unique index detection

When the entity declares `CachedUniqueIndexes()`, `SearchOne` inspects `query.GetConditions()` before building SQL. If the query has exactly as many typed conditions as an index has columns, and every one of them is an equality (`Eq`/`Is`) on exactly those columns, the lookup goes through the Redis unique-index key instead of a `SELECT`:

1. Outside a transaction (`ctx.InTransaction() == false`) the key `<redisCachePrefix>u:<IndexName>@<hash>:<value hash>` is read with `GET`. On a hit the id is loaded with `GetByID`, and the loaded row's column values (and `FakeDelete == 0` when present) are verified against the query before it is returned.
2. On a miss (or a failed verification) `SELECT ID ... WHERE <cols> = ? LIMIT 1` runs, the id is written back to the key with `fluxaorm.EntityCacheTTL`, and `GetByID` returns the entity.
3. Inside `ctx.Transaction` Redis is neither read nor written; the `SELECT` runs on the transaction.

Only `GetConditions()` participates in the detection: a condition qualifies when it implements `fluxaorm.EqCondition` (`ColumnName()`, `EqValue()`), which `Eq`, `Is` and `IsEmpty()` do and `In`, `Like`, comparisons and `Not()` do not. `FilterWhere`, sort clauses and `WithFakeDeletes()` are ignored on that path, and any non-equality condition (or an extra condition) falls back to the regular `SELECT ID ... LIMIT 1`. The key format and invalidation rules are described in [Redis Cache](/guide/redis_cache.html).

```go
// Uses the cached unique index "Email":
entities.UserEntityProvider.SearchOne(ctx, fluxaorm.NewQuery().
    Filter(entities.UserEntityProvider.Fields.Email.Is("alice@example.com")))

// Regular SQL (Like is not an equality):
entities.UserEntityProvider.SearchOne(ctx, fluxaorm.NewQuery().
    Filter(entities.UserEntityProvider.Fields.Email.Like("alice%")))
```

## Fake-Deleted Rows

When the entity has a `FakeDelete` field, `SearchOne`, `SearchMany`, `SearchManyWithTotal` and `Count` append `FakeDelete = 0` to the `WHERE` clause. To include fake-deleted rows, pass a `Where` created with `WithFakeDeletes()` through `FilterWhere`; `DBQuery` has no other switch for it:

```go
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)).
        FilterWhere(fluxaorm.NewWhere("1").WithFakeDeletes()),
)
```

See [Fake Delete](/guide/fake_delete.html).

## Transactions and Caches

All search SQL runs through `ctx.DB(pool)`, which is the open transaction for that pool when the context is inside `ctx.Transaction` and a write has already opened one, otherwise the plain pool (see [Transactions](/guide/transactions.html)). Inside a transaction the Redis row cache and cached unique index keys are bypassed, so results reflect uncommitted writes of the same transaction.

Search never caches the list of ids; only the individual entities are cached (context cache and, with `redisCache`, the Redis row cache).

## Loading by IDs

`GetByIDs(ctx fluxaorm.Context, id ...uint64) ([]*entities.UserEntity, error)` is what every search uses for hydration. It de-duplicates the ids, keeps the input order, serves context-cache hits first, then Redis row-cache hits (outside transactions), and loads the rest with a single `SELECT ... WHERE ID IN (...)`. Ids that do not exist are silently dropped from the result (and, for entities with `redisCache`, negatively cached in Redis outside a transaction). Details are in [CRUD](/guide/crud.html).

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `SearchMany(ctx, query)` | `([]*E, error)` | Entities matching the query, SQL order, no `LIMIT` without a pager |
| `SearchManyWithTotal(ctx, query)` | `([]*E, int, error)` | `COUNT(*)` first, then the page; `nil, 0, nil` when the count is 0 |
| `SearchOne(ctx, query)` | `(*E, bool, error)` | `LIMIT 1`; cached unique index fast path when the conditions match one |
| `Count(ctx, query)` | `(int, error)` | `COUNT(*)` only |
