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

There are separate typed methods for `uint64`, `int64`, and `float64` values. Use the variant that matches your field's Go type:

**Uint64 methods** (for `uint`, `uint8`, `uint16`, `uint32`, `uint64` fields):

```go
// Exact match: Age = 25
where := fluxaorm.NewRedisSearchWhere().Uint64Equal("Age", 25)

// Range: Age between 18 and 65
where = fluxaorm.NewRedisSearchWhere().Uint64Range("Age", 18, 65)

// Minimum: Age >= 18
where = fluxaorm.NewRedisSearchWhere().Uint64Min("Age", 18)

// Maximum: Age <= 100
where = fluxaorm.NewRedisSearchWhere().Uint64Max("Age", 100)
```

**Int64 methods** (for `int`, `int8`, `int16`, `int32`, `int64` fields):

```go
// Exact match: Balance = -50
where := fluxaorm.NewRedisSearchWhere().Int64Equal("Balance", -50)

// Range: Balance between -100 and 100
where = fluxaorm.NewRedisSearchWhere().Int64Range("Balance", -100, 100)

// Minimum: Balance >= 0
where = fluxaorm.NewRedisSearchWhere().Int64Min("Balance", 0)

// Maximum: Balance <= 1000
where = fluxaorm.NewRedisSearchWhere().Int64Max("Balance", 1000)
```

**Float64 methods** (for `float32`, `float64` fields):

```go
// Exact match: Score = 9.5
where := fluxaorm.NewRedisSearchWhere().Float64Equal("Score", 9.5)

// Range: Price between 10.50 and 99.99
where = fluxaorm.NewRedisSearchWhere().Float64Range("Price", 10.50, 99.99)

// Minimum: Price >= 5.0
where = fluxaorm.NewRedisSearchWhere().Float64Min("Price", 5.0)

// Maximum: Price <= 99.99
where = fluxaorm.NewRedisSearchWhere().Float64Max("Price", 99.99)
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
    Uint64Min("Age", 18).
    Tag("Status", "active").
    Float64Max("Price", 100)
```

### Sorting

Use `SortBy()` to sort results by a sortable field:

```go
// Sort by Age ascending
where := fluxaorm.NewRedisSearchWhere().
    Uint64Min("Age", 18).
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
    Uint64Min("Age", 18).
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
product, found, err := ProductProvider.SearchOneInRedis(ctx, fluxaorm.NewRedisSearchWhere().Uint64Equal("Age", 25))
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
ids, err := ProductProvider.SearchIDsInRedis(ctx, fluxaorm.NewRedisSearchWhere().Float64Min("Price", 50), nil)
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
| `Uint64Equal(field, value)` | Exact match (unsigned integers) |
| `Uint64Range(field, min, max)` | Range, inclusive (unsigned integers) |
| `Uint64Min(field, min)` | Greater than or equal to (unsigned integers) |
| `Uint64Max(field, max)` | Less than or equal to (unsigned integers) |
| `Int64Equal(field, value)` | Exact match (signed integers) |
| `Int64Range(field, min, max)` | Range, inclusive (signed integers) |
| `Int64Min(field, min)` | Greater than or equal to (signed integers) |
| `Int64Max(field, max)` | Less than or equal to (signed integers) |
| `Float64Equal(field, value)` | Exact match (floats) |
| `Float64Range(field, min, max)` | Range, inclusive (floats) |
| `Float64Min(field, min)` | Greater than or equal to (floats) |
| `Float64Max(field, max)` | Less than or equal to (floats) |
| `Tag(field, values...)` | Exact tag match (OR for multiple values) |
| `Text(field, query)` | Full-text search |
| `Bool(field, value)` | Boolean match |
| `SortBy(field, ascending)` | Sort results by a sortable field |
