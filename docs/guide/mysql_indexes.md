# MySQL Indexes

In FluxaORM v2, unique indexes are defined directly on entity struct fields using the `orm:"unique=IndexName"` tag. There is no separate `IndexDefinition` struct or `IndexInterface` to implement. After code generation, unique indexes are automatically detected by `SearchOne()` when filter conditions match an index.

## Defining Unique Indexes

Add the `orm:"unique=IndexName"` tag to any field to include it in a unique index:

```go
type UserEntity struct {
    ID    uint64
    Email string `orm:"required;unique=Email"`
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

To create an index that spans multiple columns, give them the same index name and use a position suffix to control column order:

```go
type UserEntity struct {
    ID    uint64
    Name  string `orm:"required;unique=NameAge"`
    Age   uint8  `orm:"unique=NameAge:2"`
    Email string `orm:"required;unique=Email"`
}
```

The `:2` suffix on `Age` indicates it is the second column in the `NameAge` index. The first field tagged with `unique=NameAge` (without a position suffix) defaults to position 1. This creates:

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

### Position Rules

- The first column defaults to position 1 when no suffix is specified
- Additional columns must specify their position explicitly: `unique=IndexName:2`, `unique=IndexName:3`, etc.
- Positions must be sequential starting from 1 with no gaps

Here is an example with three columns:

```go
type OrderEntity struct {
    ID         uint64
    CustomerID uint64 `orm:"unique=CustomerOrder"`
    Year       uint16 `orm:"unique=CustomerOrder:2"`
    OrderNum   uint32 `orm:"unique=CustomerOrder:3"`
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

By default, `SearchOne()` with unique index conditions queries MySQL directly every time it is called. For frequently accessed indexes, you can enable caching by adding the `cached` tag to the **first** column of the index:

```go
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required;unique=NameAge;cached"`
    Age   uint8  `orm:"unique=NameAge:2"`
    Email string `orm:"required;unique=Email;cached"`
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
    Code string `orm:"required;unique=Code;cached"`
    SKU  int32  `orm:"unique=Code:2"`
}
```

Even without `orm:"redisCache"` on the `ID` field, `SearchOne()` caches the resolved entity ID in Redis when filtering by the `Code` index columns, avoiding repeated MySQL index lookups.

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
    Name string `orm:"required;unique=Name;cached"`
    Slug string `orm:"required;unique=Slug;cached"`
}

type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Email string `orm:"required;unique=Email;cached"`
    Name  string `orm:"required;unique=NameCountry;cached"`
    Country string `orm:"unique=NameCountry:2"`
}

type ProductEntity struct {
    ID       uint64
    SKU      string `orm:"required;unique=SKU"`
    Category fluxaorm.Reference[CategoryEntity] `orm:"required;unique=CategorySlug"`
    Slug     string `orm:"required;unique=CategorySlug:2"`
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
