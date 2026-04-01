# Redis Search

In the previous section, you learned how to search for entities using MySQL queries. However, MySQL-based searching can become a performance bottleneck in high-traffic applications. FluxaORM provides integration with the Redis Search engine, which offers much better performance for indexed queries.

## Defining the Redis Search Index

By default, entities are not indexed in Redis Search. To enable Redis Search for an entity, add the `searchable` tag to each field you want to include in the index. FluxaORM will automatically use the `default` Redis pool for the search index. If you need a different pool, add the `redisSearch=pool` tag on the `ID` field.

```go
type ProductEntity struct {
    ID    uint64
    Name  string  `orm:"required;searchable"`
    Price float64 `orm:"searchable;sortable"`
    Age   uint32  `orm:"searchable;sortable"`
}
```

In this example, `Name`, `Price`, and `Age` are indexed in Redis Search on the `default` Redis pool.

### Sortable Fields

By default, indexed fields are not sortable. Add the `sortable` tag to make a field available for sorting in search queries:

```go
type UserEntity struct {
    ID        uint64
    Name      string `orm:"required;searchable"`
    Age       uint32 `orm:"searchable;sortable"` // can be used in SortByASC/SortByDESC
    CreatedAt time.Time `orm:"searchable"`        // NOT sortable
}
```

## Entity Field Mapping

The table below shows how Go field types are mapped to Redis Search index field types:

| Go Type | Redis Search Type | Notes |
|---------|-------------------|-------|
| `int`, `int8`, `int16`, `int32`, `int64` | NUMERIC | |
| `uint`, `uint8`, `uint16`, `uint32`, `uint64` | NUMERIC | |
| `float32`, `float64` | NUMERIC | |
| `*int...`, `*uint...`, `*float...` | NUMERIC | `nil` stored as `0` |
| `string`, `*string` | TEXT | `nil` stored as `NULL` |
| `bool`, `*bool` | NUMERIC | stored as `0` or `1` |
| `time.Time`, `*time.Time` | NUMERIC | stored as unix timestamp, `nil` as `0` |
| `fluxaorm.Reference` | NUMERIC | `nil` as `0` |
| enum, `[]enum` | TAG | `nil` as `NULL` |

## Running Index Alters

If at least one of your entities uses Redis Search, you must run `GetRedisSearchAlters()` when your application starts to create or update indexes:

```go
import "github.com/latolukasz/fluxaorm/v2"

alters, err := fluxaorm.GetRedisSearchAlters(ctx)
if err != nil {
    panic(err)
}
for _, alter := range alters {
    err = alter.Exec(ctx)
    if err != nil {
        panic(err)
    }
}
```

::: warning
If `alter.Exec(ctx)` modifies the current index (e.g., adds a new field), the previous index is dropped and a new one is created. The new index is then filled with entity data from MySQL. If the entity table contains many rows (hundreds of thousands or more), this operation can take some time.
:::

## Reindexing

FluxaORM automatically updates the Redis Search index when you add, update, or delete an entity via `Flush()`, `FlushAsync(true)`, or `FlushAsync(false)`. When an entity is **updated**, only the fields that actually changed are written to the Redis hash via `HSET` -- unchanged fields are left untouched. Nullable fields that become `NULL` are removed from the hash via `HDEL`. This partial update approach is more efficient than rebuilding the entire hash on every edit.

Full hash rebuilds (delete + recreate) only occur during insert, delete, un-delete (restoring a fake-deleted entity), index schema changes via `GetRedisSearchAlters()`, or manual reindex.

If your Redis index data was manually removed or MySQL data was manually updated, you can trigger a full reindex using the Provider's `ReindexRedisSearch()` method:

```go
err := ProductProvider.ReindexRedisSearch(ctx)
if err != nil {
    // handle error
}
```

This scans all rows in MySQL and rebuilds the Redis Search hashes. For large tables, this operation can take some time.

## Typed Redis Search Fields

After code generation, each Provider with Redis Search enabled has a `FieldsRedisSearch` struct containing typed field definitions for every searchable column. These fields are used with the `NewRedisSearchQuery()` builder.

```go
// Given this entity definition:
type ProductEntity struct {
    ID    uint64
    Name  string  `orm:"required;searchable"`
    Price float64 `orm:"searchable;sortable"`
    Age   uint32  `orm:"searchable;sortable"`
    Status string `orm:"enum=active,inactive;searchable"`
}

// After code generation, ProductProvider.FieldsRedisSearch contains:
// ProductProvider.FieldsRedisSearch.Name   → fluxaorm.RedisSearchTextField
// ProductProvider.FieldsRedisSearch.Price  → fluxaorm.RedisSearchNumericField  (float64 params)
// ProductProvider.FieldsRedisSearch.Age    → fluxaorm.RedisSearchUintField     (uint64 params)
// ProductProvider.FieldsRedisSearch.Status → fluxaorm.RedisSearchTagField
```

### Redis Search Field Types

| Type | Methods | Used for |
|------|---------|----------|
| `RedisSearchUintField` | `Eq(uint64)`, `Gte(uint64)`, `Lte(uint64)`, `Gt(uint64)`, `Lt(uint64)`, `Between(min, max uint64)` | Unsigned integer Go types (`uint8`, `uint16`, `uint32`, `uint64`) and Reference fields |
| `RedisSearchIntField` | `Eq(int64)`, `Gte(int64)`, `Lte(int64)`, `Gt(int64)`, `Lt(int64)`, `Between(min, max int64)` | Signed integer Go types (`int8`, `int16`, `int32`, `int64`) |
| `RedisSearchNumericField` | `Eq(float64)`, `Gte(float64)`, `Lte(float64)`, `Gt(float64)`, `Lt(float64)`, `Between(min, max float64)` | Float Go types (`float32`, `float64`), `bool`, `time.Time` |
| `RedisSearchTextField` | `Match(string)` | Full-text search on string fields |
| `RedisSearchTagField` | `In(...string)` | Exact tag match on enum and set fields |

## Building Search Queries

Use `fluxaorm.NewRedisSearchQuery()` to build Redis Search queries with the typed field definitions:

```go
import "github.com/latolukasz/fluxaorm/v2"

query := fluxaorm.NewRedisSearchQuery().
    Filter(
        entities.ProductProvider.FieldsRedisSearch.Age.Gte(18),
        entities.ProductProvider.FieldsRedisSearch.Status.In("active"),
    ).
    SortByDESC(entities.ProductProvider.FieldsRedisSearch.Price).
    Pager(fluxaorm.NewPager(1, 100))
```

An empty query (no filters) matches all documents (equivalent to `*` in Redis Search syntax).

### Filter

`Filter()` accepts one or more typed Redis Search conditions. Multiple conditions are combined with AND logic (space-separated in Redis Search syntax):

```go
query := fluxaorm.NewRedisSearchQuery().Filter(
    entities.ProductProvider.FieldsRedisSearch.Price.Gte(10.0),
    entities.ProductProvider.FieldsRedisSearch.Price.Lte(100.0),
    entities.ProductProvider.FieldsRedisSearch.Status.In("active"),
)
```

### Numeric Conditions

The numeric field type is chosen based on the Go type of the column:

```go
// RedisSearchUintField — for uint8, uint16, uint32, uint64, Reference fields (accepts uint64)
entities.ProductProvider.FieldsRedisSearch.Age.Gte(18)       // Age is uint32
entities.ProductProvider.FieldsRedisSearch.Age.Between(1, 100)

// RedisSearchIntField — for int8, int16, int32, int64 fields (accepts int64)
entities.ProductProvider.FieldsRedisSearch.Balance.Gte(-100) // Balance is int32
entities.ProductProvider.FieldsRedisSearch.Balance.Lt(0)

// RedisSearchNumericField — for float32, float64, bool, time.Time (accepts float64)
entities.ProductProvider.FieldsRedisSearch.Price.Eq(9.5)     // Price is float64
entities.ProductProvider.FieldsRedisSearch.Price.Between(10.50, 99.99)
```

All three types support the same methods: `Eq()`, `Gte()`, `Lte()`, `Gt()`, `Lt()`, `Between()`.

### Tag Conditions

Use `RedisSearchTagField` for exact value matching on enum fields. Multiple values use OR logic:

```go
// Status is "active"
entities.ProductProvider.FieldsRedisSearch.Status.In("active")

// Status is "active" OR "pending"
entities.ProductProvider.FieldsRedisSearch.Status.In("active", "pending")
```

### Text Conditions

Use `RedisSearchTextField` for full-text search:

```go
// Full-text search on Name
entities.ProductProvider.FieldsRedisSearch.Name.Match("laptop")
```

### Sorting

Use `SortByASC()` or `SortByDESC()` with a sortable field:

```go
// Sort by Age ascending
query := fluxaorm.NewRedisSearchQuery().
    Filter(entities.ProductProvider.FieldsRedisSearch.Age.Gte(18)).
    SortByASC(entities.ProductProvider.FieldsRedisSearch.Age)

// Sort by Price descending
query = fluxaorm.NewRedisSearchQuery().
    Filter(entities.ProductProvider.FieldsRedisSearch.Status.In("active")).
    SortByDESC(entities.ProductProvider.FieldsRedisSearch.Price)
```

::: tip
Only fields with the `sortable` tag can be used in `SortByASC()` and `SortByDESC()`.
:::

## Searching for Entities

Use `SearchManyInRedis()` on the Provider to find entities using the Redis Search index:

```go
import "github.com/latolukasz/fluxaorm/v2"

products, err := entities.ProductProvider.SearchManyInRedis(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductProvider.FieldsRedisSearch.Age.Gte(18)).
        SortByASC(entities.ProductProvider.FieldsRedisSearch.Age).
        Pager(fluxaorm.NewPager(1, 100)),
)
if err != nil {
    // handle error
}
for _, product := range products {
    fmt.Printf("Product: %s, Price: %.2f\n", product.GetName(), product.GetPrice())
}
```

Pass a query without a `Pager` to retrieve all matching results (up to 10,000):

```go
products, err := entities.ProductProvider.SearchManyInRedis(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductProvider.FieldsRedisSearch.Age.Gte(18)),
)
```

**Signature:**
```go
func (p XxxProvider) SearchManyInRedis(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) ([]*XxxEntity, error)
```

## Searching with Total Count

Use `SearchManyInRedisWithTotal()` to get both the results and the total number of matching documents:

```go
products, total, err := entities.ProductProvider.SearchManyInRedisWithTotal(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductProvider.FieldsRedisSearch.Status.In("active")).
        Pager(fluxaorm.NewPager(1, 100)),
)
if err != nil {
    // handle error
}
fmt.Printf("Showing %d of %d total products\n", len(products), total)
```

**Signature:**
```go
func (p XxxProvider) SearchManyInRedisWithTotal(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) ([]*XxxEntity, int, error)
```

## Searching for a Single Entity

Use `SearchOneInRedis()` to retrieve a single matching entity:

```go
product, found, err := entities.ProductProvider.SearchOneInRedis(ctx,
    fluxaorm.NewRedisSearchQuery().
        Filter(entities.ProductProvider.FieldsRedisSearch.Age.Eq(25)),
)
if err != nil {
    // handle error
}
if !found {
    fmt.Println("Product not found")
    return
}
fmt.Printf("Found product: %s\n", product.GetName())
```

::: tip
This method always uses `LIMIT 0 1`. If more than one document matches, only the first is returned.
:::

**Signature:**
```go
func (p XxxProvider) SearchOneInRedis(ctx fluxaorm.Context, query *fluxaorm.RedisSearchQuery) (*XxxEntity, bool, error)
```

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `SearchManyInRedis` | `([]*XxxEntity, error)` | Entities matching the query |
| `SearchManyInRedisWithTotal` | `([]*XxxEntity, int, error)` | Entities + total count |
| `SearchOneInRedis` | `(*XxxEntity, bool, error)` | Single entity (LIMIT 1) |

### Redis Search Field Types

| Type | Methods | Used for |
|------|---------|----------|
| `RedisSearchUintField` | `Eq(uint64)`, `Gte(uint64)`, `Lte(uint64)`, `Gt(uint64)`, `Lt(uint64)`, `Between(min, max uint64)` | Unsigned integers, References |
| `RedisSearchIntField` | `Eq(int64)`, `Gte(int64)`, `Lte(int64)`, `Gt(int64)`, `Lt(int64)`, `Between(min, max int64)` | Signed integers |
| `RedisSearchNumericField` | `Eq(float64)`, `Gte(float64)`, `Lte(float64)`, `Gt(float64)`, `Lt(float64)`, `Between(min, max float64)` | Floats, bool, time.Time |
| `RedisSearchTextField` | `Match(string)` | Full-text search |
| `RedisSearchTagField` | `In(...string)` | Exact tag match (OR for multiple values) |
