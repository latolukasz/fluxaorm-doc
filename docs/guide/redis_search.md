---
description: "Indexing FluxaORM entities in Redis Search (FT.SEARCH): searchable and sortable tags, index maintenance on Save, typed queries and reindexing."
---

# Redis Search

[Search](/guide/search.html) runs against MySQL. For high-traffic filtering and sorting FluxaORM can additionally index entities in the Redis Search engine (`FT.*` commands): every searchable entity row is mirrored as a Redis hash, an `FT.SEARCH` query returns matching ids, and the entities are then loaded through the regular caches with `GetByIDs`.

## Defining the Index

Add the `searchable` tag to every field that should be indexed. Add `sortable` to fields you want to sort by. The Redis pool is chosen with `redisSearch=<pool>` on the `ID` field; a bare `redisSearch` tag, or no tag at all when at least one field is `searchable`, uses `fluxaorm.DefaultPoolCode` (`"default"`). The pool must be registered with `registry.RegisterRedis(...)`, otherwise `Validate()` fails with `redis pool '<pool>' not found for redisSearch in entity '<Entity>'`.

```go
type ProductEntity struct {
    ID        uint64                             `orm:"redisSearch=search"`
    Name      string                             `orm:"required;searchable"`
    Price     float64                            `orm:"searchable;sortable"`
    Stock     uint32                             `orm:"searchable;sortable"`
    Status    string                             `orm:"enum=active,inactive;required;searchable"`
    Category  fluxaorm.Reference[CategoryEntity] `orm:"searchable"`
    Discount  *int32                             `orm:"searchable"`
    CreatedAt time.Time                          `orm:"searchable;sortable"`
}
```

### Field type mapping

| Go field | Redis Search type | Generated descriptor | Stored hash value |
|----------|-------------------|----------------------|-------------------|
| `uint8` .. `uint64`, `*uint8` .. `*uint64` | NUMERIC | `RedisSearchUintField` | decimal |
| `fluxaorm.Reference[T]` | NUMERIC | `RedisSearchUintField` | referenced id |
| `int8` .. `int64`, `*int8` .. `*int64` | NUMERIC | `RedisSearchIntField` | decimal |
| `float32`, `float64`, `*float32`, `*float64` | NUMERIC | `RedisSearchNumericField` | `strconv.FormatFloat(v, 'g', -1, 64)` |
| `bool`, `*bool` | NUMERIC | `RedisSearchNumericField` | `1` / `0` |
| `time.Time`, `*time.Time` (date or `orm:"time"`) | NUMERIC | `RedisSearchNumericField` | Unix seconds |
| `string` (plain) | TEXT | `RedisSearchTextField` | raw string |
| `string` with `enum=` | TAG | `RedisSearchTagField` | enum value |
| `string` with `set=` | TAG | `RedisSearchTagField` | set value |

The `searchable` tag is ignored on `[]uint8` (blob) and JSON struct columns; they are never indexed.

A `NULL` value is **not** stored: nullable fields are written to the hash only when they have a value, and when an update sets a nullable field to `NULL` the hash field is removed with `HDEL`. Query `IsNull`-style semantics therefore do not exist in Redis Search; a document without the field simply does not match a range on it.

### Index name and hash keys

Both names are derived at `Validate()` time and baked into the generated provider:

- **Index name**: `<tableName>_<8 hex chars>` where the hash is FNV-32a over the sorted list of `<column>:<REDISTYPE>:<0|1 sortable>` entries, e.g. `ProductEntity_d6bf3283`. Adding, removing or retyping a searchable field or toggling `sortable` yields a new index name.
- **Hash key prefix**: the first 5 hex chars of FNV-32a over `<tableName>:search` followed by `:h:`, e.g. `3056f:h:`. A document key is `<prefix><ID>`, e.g. `3056f:h:42`.

The generated provider exposes them and implements `fluxaorm.RedisSearchEntityProvider`:

```go
entities.ProductEntityProvider.RedisSearchCode()       // "search"
entities.ProductEntityProvider.RedisSearchIndexName()  // "ProductEntity_d6bf3283"
entities.ProductEntityProvider.RedisSearchHashPrefix() // "3056f:h:"

// Iterate every generated provider and pick the search-enabled ones:
for _, p := range entities.AllProviders {
    if sp, ok := p.(fluxaorm.RedisSearchEntityProvider); ok {
        fmt.Println(sp.RedisSearchIndexName())
    }
}
```

## Creating and Dropping Indexes

Hashes are written by `Save`, but the `FT` index itself must be created once. `fluxaorm.GetRedisSearchAlters(ctx)` compares the registered entities with `FT._LIST` on each pool and returns the pending operations:

```go
type RedisSearchAlter struct {
    IndexName string
    RedisPool string
    Kind      fluxaorm.AlterKind   // AlterKindAddIndex or AlterKindDropIndex
    Safety    fluxaorm.AlterSafety // AlterSafe or AlterDestructive
}

func (a RedisSearchAlter) IsSafe() bool
func (a RedisSearchAlter) Exec(ctx fluxaorm.Context) error

func GetRedisSearchAlters(ctx fluxaorm.Context) ([]RedisSearchAlter, error)
```

| Situation | Alter | `Exec` runs |
|-----------|-------|-------------|
| Entity index name not present in Redis | `Kind: AlterKindAddIndex`, `Safety: AlterSafe` | `FT.CREATE <name> ON HASH PREFIX 1 <prefix> SCHEMA <col> TEXT/NUMERIC/TAG [SORTABLE] ...` |
| Index named `<table>_<8 hex>` for a registered entity whose current name differs | `Kind: AlterKindDropIndex`, `Safety: AlterDestructive` | `FT.DROPINDEX <name>` (documents are kept) |

Because the index name embeds the field-set hash, a schema change is never an in-place modify: you get one safe create for the new name and one destructive drop for the old one. The `AlterKind`/`AlterSafety` types and the recommended rolling-deploy order (safe alters during rollout, destructive alters once every instance runs the new code) are described in [Schema Update](/guide/schema_update.html).

```go
alters, err := fluxaorm.GetRedisSearchAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    if !alter.IsSafe() {
        continue // drop stale indexes in a later step
    }
    if err = alter.Exec(ctx); err != nil {
        panic(err)
    }
}
```

::: warning
`FT.CREATE` backfills asynchronously from the hashes that already exist under the prefix. The index exists immediately but an `FT.SEARCH` issued right after `Exec` can return partial results. Alters never read MySQL; if the hashes are missing or stale, run `ReindexRedisSearch` (below).
:::

## How Hashes Are Maintained

The generated entity code keeps the hash in sync as part of `ctx.Save(...)`, `ctx.Delete(...)` and `ctx.ForceDelete(...)` (see [CRUD](/guide/crud.html)). The Redis commands are queued on `ctx.RedisPipeLine(<search pool>)` and executed in the post-commit phase, after the SQL statements are committed:

| Write | Redis commands |
|-------|----------------|
| Insert | `DEL <key>` then `HSET <key> <all searchable fields>`. When the entity has `FakeDelete` and it is set, nothing is written. |
| Update | Only when at least one searchable column changed: `HSET` of the changed fields, plus `HDEL` for nullable searchable columns that became `NULL`. Unchanged fields are left untouched. |
| Update that sets `FakeDelete` | `DEL <key>` |
| Update that clears `FakeDelete` (un-delete) | `DEL <key>` then full `HSET` |
| Delete / ForceDelete | `DEL <key>` |

Inside `ctx.Transaction` the pipeline runs once the outer transaction commits. A failure in this phase (SQL already durable) is reported as `*fluxaorm.PostCommitError`; see [Transactions](/guide/transactions.html).

## Reindexing

```go
func (p productEntityProvider) ReindexRedisSearch(ctx fluxaorm.Context) error
```

Rebuilds every hash from MySQL:

1. `SCAN MATCH <prefix>* COUNT 1000` + `UNLINK` (in a Lua script) removes all existing hashes of the entity.
2. `SELECT <all columns> FROM <table>` is streamed row by row; rows with a non-zero `FakeDelete` are skipped.
3. For every row `DEL <key>` + `HSET <key> ...` are queued and the pipeline is executed every 1000 rows.

It does not touch the `FT` index itself. Typical procedure after adding Redis Search to an existing table, or after a schema change:

```go
// 1. create the (new) index
alters, _ := fluxaorm.GetRedisSearchAlters(ctx)
for _, alter := range alters {
    if alter.IsSafe() {
        _ = alter.Exec(ctx)
    }
}
// 2. fill the hashes from MySQL
if err := entities.ProductEntityProvider.ReindexRedisSearch(ctx); err != nil {
    return err
}
// 3. once every instance runs the new code, drop stale indexes
for _, alter := range alters {
    if !alter.IsSafe() {
        _ = alter.Exec(ctx)
    }
}
```

## Typed Redis Search Fields

For every search-enabled entity the Provider has a `FieldsRedisSearch` struct with one descriptor per searchable column. Descriptors build `fluxaorm.RedisSearchCondition` values for `Filter()` and implement `fluxaorm.RedisSearchField` for sorting.

```go
// entities.ProductEntityProvider.FieldsRedisSearch.Name      fluxaorm.RedisSearchTextField
// entities.ProductEntityProvider.FieldsRedisSearch.Price     fluxaorm.RedisSearchNumericField
// entities.ProductEntityProvider.FieldsRedisSearch.Stock     fluxaorm.RedisSearchUintField
// entities.ProductEntityProvider.FieldsRedisSearch.Status    fluxaorm.RedisSearchTagField
// entities.ProductEntityProvider.FieldsRedisSearch.Category  fluxaorm.RedisSearchUintField
// entities.ProductEntityProvider.FieldsRedisSearch.Discount  fluxaorm.RedisSearchIntField
// entities.ProductEntityProvider.FieldsRedisSearch.CreatedAt fluxaorm.RedisSearchNumericField
```

| Type | Methods | FT.SEARCH syntax |
|------|---------|------------------|
| `RedisSearchNumericField` | `Eq(v float64)`, `Gte(v float64)`, `Lte(v float64)`, `Gt(v float64)`, `Lt(v float64)`, `Between(min, max float64)` | `@col:[v v]`, `@col:[v +inf]`, `@col:[-inf v]`, `@col:[(v +inf]`, `@col:[-inf (v]`, `@col:[min max]` |
| `RedisSearchUintField` | same with `uint64` | as above, but `Lte`/`Lt` use `0` as the lower bound: `@col:[0 v]`, `@col:[0 (v]` |
| `RedisSearchIntField` | same with `int64` | as `RedisSearchNumericField` |
| `RedisSearchTextField` | `Match(text string)` | `@col:<text>` (inserted verbatim, no escaping or quoting) |
| `RedisSearchTagField` | `In(values ...string)` | `@col:{...}` with the values inside the braces joined by a pipe character (OR) |

All descriptors expose `ColumnName() string`. A pipe character inside a tag value is escaped with a backslash before it is joined.

```go
f := entities.ProductEntityProvider.FieldsRedisSearch

f.Stock.Gte(1)                                        // @Stock:[1 +inf]
f.Price.Between(10.5, 99.99)                          // @Price:[10.5 99.99]
f.Discount.Lt(0)                                      // @Discount:[-inf (0]
f.Status.In("active", "pending")                      // @Status:{active|pending}
f.Category.Eq(category.GetID())                       // @Category:[7 7]
f.Name.Match("laptop")                                // @Name:laptop
f.CreatedAt.Gte(float64(since.Unix()))                // time is stored as Unix seconds
```

Booleans are stored as `1`/`0`, so filter them with `Eq(1)` / `Eq(0)` on the `RedisSearchNumericField`.

::: warning
`Match` passes the text straight into the query string. Escape Redis Search special characters yourself if the value comes from user input.
:::

## Building Queries with NewRedisSearchQuery

```go
query := fluxaorm.NewRedisSearchQuery().
    Filter(
        entities.ProductEntityProvider.FieldsRedisSearch.Status.In("active"),
        entities.ProductEntityProvider.FieldsRedisSearch.Stock.Gte(1),
    ).
    SortByDESC(entities.ProductEntityProvider.FieldsRedisSearch.Price).
    Pager(fluxaorm.NewPager(1, 50))

query.BuildQueryString() // "@Status:{active} @Stock:[1 +inf]"
```

| Method | Behaviour |
|--------|-----------|
| `Filter(conditions ...RedisSearchCondition) *RedisSearchQuery` | Appends conditions. They are joined with a space, which is `AND` in Redis Search syntax. |
| `SortByASC(f RedisSearchField) *RedisSearchQuery` / `SortByDESC(f RedisSearchField) *RedisSearchQuery` | Sets the **single** sort field. A second call replaces the first. Not validated against `sortable`; sorting by a non-sortable field fails at `FT.SEARCH` time. |
| `Pager(p *Pager) *RedisSearchQuery` | Sets `LIMIT offset count`. Without a pager the query uses `LIMIT 0 10000`. |
| `GetPagerOffsetCount() (offset int, count int)` | `(page-1)*size, size`, or `0, 10000` without a pager. |
| `BuildQueryString() string` | The query string; `*` when there are no conditions. |
| `BuildSearchOptions(offset, count int) *redis.FTSearchOptions` | go-redis options with `NoContent: true`, `LimitOffset`/`Limit` and the optional `SortBy`. |

`Pager` is shared with the MySQL query builder; see [Search](/guide/search.html#pager).

## Searching

All three methods run `FT.SEARCH <index> <query> NOCONTENT LIMIT ... [SORTBY ...]`, strip the hash prefix from the returned document ids and load the entities with `GetByIDs`. The result keeps the `FT.SEARCH` order; ids whose MySQL row no longer exists are dropped; hydration uses the [context cache](/guide/context_cache.html) and the [Redis row cache](/guide/redis_cache.html).

### SearchManyInRedis

```go
func (p productEntityProvider) SearchManyInRedis(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) ([]*entities.ProductEntity, error)
```

Returns `nil, nil` when no document matches.

```go
products, err := entities.ProductEntityProvider.SearchManyInRedis(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductEntityProvider.FieldsRedisSearch.Stock.Gte(1)).
        SortByASC(entities.ProductEntityProvider.FieldsRedisSearch.Price).
        Pager(fluxaorm.NewPager(1, 100)),
)
if err != nil {
    return err
}
for _, product := range products {
    fmt.Printf("%s %.2f\n", product.GetName(), product.GetPrice())
}
```

### SearchManyInRedisWithTotal

```go
func (p productEntityProvider) SearchManyInRedisWithTotal(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) ([]*entities.ProductEntity, int, error)
```

Issues **two** `FT.SEARCH` calls: first with `LIMIT 0 0` to read the total, then, if the total is not `0`, the paged query. A zero total returns `nil, 0, nil`.

```go
products, total, err := entities.ProductEntityProvider.SearchManyInRedisWithTotal(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductEntityProvider.FieldsRedisSearch.Status.In("active")).
        Pager(fluxaorm.NewPager(1, 100)),
)
fmt.Printf("showing %d of %d products\n", len(products), total)
```

### SearchOneInRedis

```go
func (p productEntityProvider) SearchOneInRedis(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) (*entities.ProductEntity, bool, error)
```

Always searches with `LIMIT 0 1`; a `Pager` on the query is ignored. Sorting is honoured, so combine a filter with `SortBy*` to pick the first document deterministically.

```go
product, found, err := entities.ProductEntityProvider.SearchOneInRedis(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductEntityProvider.FieldsRedisSearch.Category.Eq(categoryID)).
        SortByDESC(entities.ProductEntityProvider.FieldsRedisSearch.CreatedAt),
)
if err != nil {
    return err
}
if !found {
    fmt.Println("not found")
}
```

## Raw FT Commands

The Redis pool exposes the underlying commands when you need them directly: `engine.Redis(pool).FTCreate(...)`, `FTDrop(ctx, index, dropDocuments)`, `FTList(ctx)`, `FTInfo(ctx, index)` and `FTSearch(ctx, index, query, options)`. See [Redis Operations](/guide/redis_operations.html).

For a raw `FTSearch` against your own index there is also the untyped, column-name based builder `fluxaorm.NewRedisSearchWhere()`. It produces the same syntax as the typed descriptors (`Float64Range/Min/Max/Equal`, `Int64...`, `Uint64...`, `Tag(field, values...)`, `Text(field, text)`, `Bool(field, value)`, `SortBy(field, ascending)`); `String()` returns the query (`*` when empty) and `GetSearchOptions(offset, count)` the matching `*redis.FTSearchOptions`. The generated `Search*InRedis` methods accept only `*RedisSearchQuery`.

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `SearchManyInRedis(ctx, query)` | `([]*E, error)` | One `FT.SEARCH`, `LIMIT 0 10000` without a pager |
| `SearchManyInRedisWithTotal(ctx, query)` | `([]*E, int, error)` | Two `FT.SEARCH` calls (total, then page); `nil, 0, nil` on zero total |
| `SearchOneInRedis(ctx, query)` | `(*E, bool, error)` | `LIMIT 0 1`, pager ignored |
| `ReindexRedisSearch(ctx)` | `error` | Unlinks all hashes and rebuilds them from MySQL in batches of 1000 |
| `fluxaorm.GetRedisSearchAlters(ctx)` | `([]RedisSearchAlter, error)` | Safe `FT.CREATE` for missing indexes, destructive `FT.DROPINDEX` for stale ones |
