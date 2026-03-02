# Redis Search

In the previous section, you learned how to search for entities using MySQL queries. However, MySQL-based searching can become a performance bottleneck in high-traffic applications. FluxaORM provides integration with the Redis Search engine, which offers much better performance for indexed queries.

## Defining the Redis Search Index

By default, entities are not indexed in Redis Search. To enable Redis Search for an entity, you need two things:

1. Add the `redisSearch` tag on the `ID` field, specifying the Redis pool to use for the search index.
2. Add the `searchable` tag to each field you want to include in the index.

```go
type ProductEntity struct {
    ID    uint64  `orm:"redisSearch=default"`
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
    ID        uint64 `orm:"redisSearch=default"`
    Name      string `orm:"required;searchable"`
    Age       uint32 `orm:"searchable;sortable"` // can be used in SortBy()
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

FluxaORM automatically updates the Redis Search index when you add, update, or delete an entity via `Flush()`, `FlushAsync(true)`, or `FlushAsync(false)`. However, if your Redis index data was manually removed or MySQL data was manually updated, you can trigger a full reindex using the Provider's `ReindexRedisSearch()` method:

```go
err := ProductProvider.ReindexRedisSearch(ctx)
if err != nil {
    // handle error
}
```

This scans all rows in MySQL and rebuilds the Redis Search hashes. For large tables, this operation can take some time.

## Building Search Queries

Use `fluxaorm.NewRedisSearchWhere()` to build Redis Search query conditions:

```go
import "github.com/latolukasz/fluxaorm/v2"

where := fluxaorm.NewRedisSearchWhere()
```

An empty `RedisSearchWhere` matches all documents (equivalent to `*` in Redis Search syntax).

### Numeric Conditions

```go
// Exact match: Age = 25
where := fluxaorm.NewRedisSearchWhere().NumericEqual("Age", 25)

// Range: Age between 18 and 65
where = fluxaorm.NewRedisSearchWhere().NumericRange("Age", 18, 65)

// Minimum: Age >= 18
where = fluxaorm.NewRedisSearchWhere().NumericMin("Age", 18)

// Maximum: Price <= 99.99
where = fluxaorm.NewRedisSearchWhere().NumericMax("Price", 99.99)
```

### Tag Conditions

Tag conditions match exact values. You can provide multiple values (OR logic):

```go
// Status is "active"
where := fluxaorm.NewRedisSearchWhere().Tag("Status", "active")

// Status is "active" OR "pending"
where = fluxaorm.NewRedisSearchWhere().Tag("Status", "active", "pending")
```

### Text Conditions

Text conditions perform full-text search on TEXT fields:

```go
// Full-text search on Name
where := fluxaorm.NewRedisSearchWhere().Text("Name", "alice")
```

### Boolean Conditions

```go
// Active = true
where := fluxaorm.NewRedisSearchWhere().Bool("Active", true)

// Active = false
where = fluxaorm.NewRedisSearchWhere().Bool("Active", false)
```

### Combining Conditions

Multiple conditions are combined with AND logic (space-separated in Redis Search syntax). Chain the builder methods:

```go
where := fluxaorm.NewRedisSearchWhere().
    NumericMin("Age", 18).
    Tag("Status", "active").
    NumericMax("Price", 100)
```

### Sorting

Use `SortBy()` to sort results by a sortable field:

```go
// Sort by Age ascending
where := fluxaorm.NewRedisSearchWhere().
    NumericMin("Age", 18).
    SortBy("Age", true)

// Sort by Price descending
where = fluxaorm.NewRedisSearchWhere().
    Tag("Status", "active").
    SortBy("Price", false)
```

::: tip
Only fields with the `sortable` tag can be used in `SortBy()`.
:::

## Searching for Entities

Use the `SearchInRedis()` method on the Provider to find entities using the Redis Search index:

```go
import "github.com/latolukasz/fluxaorm/v2"

where := fluxaorm.NewRedisSearchWhere().
    NumericMin("Age", 18).
    SortBy("Age", true)

products, err := ProductProvider.SearchInRedis(ctx, where, fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
for _, product := range products {
    fmt.Printf("Product: %s, Price: %.2f\n", product.GetName(), product.GetPrice())
}
```

The `Pager` argument is optional. Pass `nil` to retrieve all matching results (up to 10,000):

```go
products, err := ProductProvider.SearchInRedis(ctx, where, nil)
```

**Signature:**
```go
func (p XxxProvider) SearchInRedis(ctx fluxaorm.Context, where *fluxaorm.RedisSearchWhere, pager *fluxaorm.Pager) ([]*XxxEntity, error)
```

## Searching with Total Count

Use `SearchInRedisWithCount()` to get both the results and the total number of matching documents:

```go
products, total, err := ProductProvider.SearchInRedisWithCount(ctx, where, fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
fmt.Printf("Showing %d of %d total products\n", len(products), total)
```

**Signature:**
```go
func (p XxxProvider) SearchInRedisWithCount(ctx fluxaorm.Context, where *fluxaorm.RedisSearchWhere, pager *fluxaorm.Pager) ([]*XxxEntity, int, error)
```

## Searching for a Single Entity

Use `SearchOneInRedis()` to retrieve a single matching entity:

```go
product, found, err := ProductProvider.SearchOneInRedis(ctx, fluxaorm.NewRedisSearchWhere().NumericEqual("Age", 25))
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
func (p XxxProvider) SearchOneInRedis(ctx fluxaorm.Context, where *fluxaorm.RedisSearchWhere) (*XxxEntity, bool, error)
```

## Searching for Primary Keys

If you only need entity IDs, use `SearchIDsInRedis()`:

```go
ids, err := ProductProvider.SearchIDsInRedis(ctx, fluxaorm.NewRedisSearchWhere().NumericMin("Price", 50), nil)
if err != nil {
    // handle error
}
for _, id := range ids {
    fmt.Printf("Product ID: %d\n", id)
}
```

**Signature:**
```go
func (p XxxProvider) SearchIDsInRedis(ctx fluxaorm.Context, where *fluxaorm.RedisSearchWhere, pager *fluxaorm.Pager) ([]uint64, error)
```

With total count:

```go
ids, total, err := ProductProvider.SearchIDsInRedisWithCount(ctx, fluxaorm.NewRedisSearchWhere().Tag("Status", "active"), fluxaorm.NewPager(1, 50))
if err != nil {
    // handle error
}
fmt.Printf("Found %d IDs out of %d total\n", len(ids), total)
```

**Signature:**
```go
func (p XxxProvider) SearchIDsInRedisWithCount(ctx fluxaorm.Context, where *fluxaorm.RedisSearchWhere, pager *fluxaorm.Pager) ([]uint64, int, error)
```

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `SearchInRedis` | `([]*XxxEntity, error)` | Entities matching the query |
| `SearchInRedisWithCount` | `([]*XxxEntity, int, error)` | Entities + total count |
| `SearchOneInRedis` | `(*XxxEntity, bool, error)` | Single entity (LIMIT 1) |
| `SearchIDsInRedis` | `([]uint64, error)` | Primary keys only |
| `SearchIDsInRedisWithCount` | `([]uint64, int, error)` | Primary keys + total count |

### RedisSearchWhere Builder Methods

| Method | Description |
|--------|-------------|
| `NumericEqual(field, value)` | Exact numeric match |
| `NumericRange(field, min, max)` | Numeric range (inclusive) |
| `NumericMin(field, min)` | Greater than or equal to |
| `NumericMax(field, max)` | Less than or equal to |
| `Tag(field, values...)` | Exact tag match (OR for multiple values) |
| `Text(field, query)` | Full-text search |
| `Bool(field, value)` | Boolean match |
| `SortBy(field, ascending)` | Sort results by a sortable field |
