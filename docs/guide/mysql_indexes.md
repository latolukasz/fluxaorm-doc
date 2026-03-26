# MySQL Indexes

In FluxaORM v2, indexes are defined by implementing interfaces on your entity struct. There are three interfaces available: `EntityUniqueIndexes` for unique indexes, `EntityCachedUniqueIndexes` for cached unique indexes, and `EntityIndexes` for non-unique indexes. After code generation, unique indexes are automatically detected by `SearchOne()` when filter conditions match an index.

## Defining Unique Indexes

Implement the `EntityUniqueIndexes` interface on your entity struct. The method returns a map where each key is the index name and the value is an ordered slice of column names:

```go
type UserEntity struct {
    ID    uint64
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "Email": {"Email"},
    }
}
```

This creates a unique index named `Email` on the `Email` column:

```sql
UNIQUE KEY `Email` (`Email`)
```

After code generation, you can look up entities by unique indexes using `SearchOne()`. When the filter conditions match a cached unique index, `SearchOne()` automatically uses the optimized cached lookup:

```go
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserEntityProvider.Fields.Email.Is("alice@example.com"),
    ),
)
if err != nil {
    // handle error
}
if found {
    fmt.Println(user.GetName())
}
```

## Composite Unique Indexes

To create an index that spans multiple columns, list the column names in the desired order:

```go
type UserEntity struct {
    ID    uint64
    Name  string `orm:"required"`
    Age   uint8
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "NameAge": {"Name", "Age"},
        "Email":   {"Email"},
    }
}
```

The order of columns in the slice determines their position in the index. This creates:

```sql
UNIQUE KEY `NameAge` (`Name`, `Age`),
UNIQUE KEY `Email` (`Email`)
```

After code generation, look up entities by composite indexes by filtering on all index columns:

```go
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserEntityProvider.Fields.Name.Is("Alice"),
        entities.UserEntityProvider.Fields.Age.Eq(30),
    ),
)
```

Here is an example with three columns:

```go
type OrderEntity struct {
    ID         uint64
    CustomerID uint64
    Year       uint16
    OrderNum   uint32
}

func (e OrderEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "CustomerOrder": {"CustomerID", "Year", "OrderNum"},
    }
}
```

This creates:

```sql
UNIQUE KEY `CustomerOrder` (`CustomerID`, `Year`, `OrderNum`)
```

```go
order, found, err := entities.OrderEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.OrderEntityProvider.Fields.CustomerID.Eq(customerID),
        entities.OrderEntityProvider.Fields.Year.Eq(2025),
        entities.OrderEntityProvider.Fields.OrderNum.Eq(1001),
    ),
)
```

## Cached Unique Indexes

By default, `SearchOne()` with unique index conditions queries MySQL directly every time it is called. For frequently accessed indexes, you can enable caching by implementing the `EntityCachedUniqueIndexes` interface. Every entry in `CachedUniqueIndexes()` must also exist in `UniqueIndexes()`:

```go
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Age   uint8
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "NameAge": {"Name", "Age"},
        "Email":   {"Email"},
    }
}

func (e UserEntity) CachedUniqueIndexes() map[string][]string {
    return map[string][]string{
        "NameAge": {"Name", "Age"},
        "Email":   {"Email"},
    }
}
```

When an index is cached, `SearchOne()` automatically detects that the filter conditions match the cached index and works as follows:

1. Check Redis for the cached index-to-ID mapping
2. If found, load the entity via `GetByID()` (which itself benefits from Redis entity cache)
3. If not found, query MySQL, cache the ID mapping in Redis, then return via `GetByID()`

::: tip
For cached indexes to be most effective, the entity should also have Redis cache enabled (`orm:"redisCache"` on the `ID` field). This way both the index lookup and the entity data are served from Redis.
:::

### Automatic Cache Invalidation

You do not need to manually invalidate cached index entries. FluxaORM automatically handles cache updates when:

- A new entity is **inserted** -- the index key is cached
- An entity is **updated** and an indexed column changes -- the old cache key is removed and the new one is set
- An entity is **deleted** (including soft deletes) -- the cache key is removed

### Cached Indexes Without Redis Entity Cache

Cached unique indexes also work on entities without Redis entity cache. In this case, the index-to-ID mapping is still cached in Redis, but the entity data itself is fetched from MySQL:

```go
type ProductEntity struct {
    ID   uint64
    Code string `orm:"required"`
    SKU  int32
}

func (e ProductEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "Code": {"Code", "SKU"},
    }
}

func (e ProductEntity) CachedUniqueIndexes() map[string][]string {
    return map[string][]string{
        "Code": {"Code", "SKU"},
    }
}
```

Even without `orm:"redisCache"` on the `ID` field, `SearchOne()` caches the resolved entity ID in Redis when filtering by the `Code` index columns, avoiding repeated MySQL index lookups.

## Non-Unique Indexes

To define non-unique indexes, implement the `EntityIndexes` interface. The method returns a map where each key is the index name and the value is an ordered slice of column names:

```go
type UserEntity struct {
    ID   uint64
    Name string `orm:"required"`
    Age  uint32
}

func (e UserEntity) Indexes() map[string][]string {
    return map[string][]string{
        "AgeIndex": {"Age"},
    }
}
```

This creates:

```sql
KEY `AgeIndex` (`Age`)
```

Non-unique indexes improve query performance but do not enforce uniqueness. They are useful for columns frequently used in `WHERE` clauses or `ORDER BY`.

## FakeDelete and Indexes

When an entity has a `FakeDelete bool` field, the `FakeDelete` column is automatically appended to all indexes (both unique and non-unique). You do not need to include it in your index definitions.

## Parameter Types

The typed field definitions on the Provider use widened Go types, matching the getter return types:

| Field Go Type | Field Type | Eq/Is Parameter Type |
|--------------|-----------|---------------------|
| uint8, uint16, uint32, uint64 | `UintField` | uint64 |
| int8, int16, int32, int64 | `IntField` | int64 |
| float32, float64 | `FloatField` | float64 |
| string | `StringField` | string |
| bool | `BoolField` | bool |
| time.Time | `TimeField` | time.Time |
| enum field | `EnumField` | string |
| Reference (required) | `ReferenceField` | uint64 |
| *uint, *int, etc. | `NullableUintField`, etc. | uint64, int64, etc. |
| Reference (optional) | `NullableReferenceField` | uint64 |

::: tip Time Truncation
When a unique index includes a `time.Time` column, the generated code automatically truncates the parameter before querying. DateTime fields (tagged with `orm:"time"`, or the built-in `CreatedAt`/`UpdatedAt` columns) are truncated to second precision. Date fields are truncated to day precision. This matches the truncation applied by setter methods, ensuring lookups always find the stored row regardless of sub-second or sub-day precision in the input value.
:::

## Complete Example

Here is a complete example showing entities with various index configurations:

```go
package entity

import (
    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"localCache;redisCache"`
    Name string `orm:"required"`
    Slug string `orm:"required"`
}

func (e CategoryEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "Name": {"Name"},
        "Slug": {"Slug"},
    }
}

func (e CategoryEntity) CachedUniqueIndexes() map[string][]string {
    return map[string][]string{
        "Name": {"Name"},
        "Slug": {"Slug"},
    }
}

type UserEntity struct {
    ID      uint64 `orm:"redisCache"`
    Email   string `orm:"required"`
    Name    string `orm:"required"`
    Country string
    Age     uint32
}

func (e UserEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "Email":       {"Email"},
        "NameCountry": {"Name", "Country"},
    }
}

func (e UserEntity) CachedUniqueIndexes() map[string][]string {
    return map[string][]string{
        "Email":       {"Email"},
        "NameCountry": {"Name", "Country"},
    }
}

func (e UserEntity) Indexes() map[string][]string {
    return map[string][]string{
        "Age": {"Age"},
    }
}

type ProductEntity struct {
    ID       uint64
    SKU      string                                `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity]    `orm:"required"`
    Slug     string                                `orm:"required"`
}

func (e ProductEntity) UniqueIndexes() map[string][]string {
    return map[string][]string{
        "SKU":          {"SKU"},
        "CategorySlug": {"Category", "Slug"},
    }
}
```

After code generation:

```go
// Single-column cached lookups (auto-detected by SearchOne)
cat, found, err := entities.CategoryEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.CategoryEntityProvider.Fields.Name.Is("Electronics")),
)
cat, found, err = entities.CategoryEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.CategoryEntityProvider.Fields.Slug.Is("electronics")),
)

// Composite cached lookups
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserEntityProvider.Fields.Name.Is("Alice"),
        entities.UserEntityProvider.Fields.Country.Is("US"),
    ),
)

// Single-column cached lookup
user, found, err = entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.UserEntityProvider.Fields.Email.Is("alice@example.com")),
)

// Non-cached lookups (hit MySQL every time)
product, found, err := entities.ProductEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.ProductEntityProvider.Fields.SKU.Is("MOUSE-001")),
)

// Composite with reference
product, found, err = entities.ProductEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.ProductEntityProvider.Fields.Category.Eq(categoryID),
        entities.ProductEntityProvider.Fields.Slug.Is("wireless-mouse"),
    ),
)
```
