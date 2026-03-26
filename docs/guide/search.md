# Search

In the previous section, you learned how to load entities from a database using their primary keys. In this section, we will cover how to search and load entities using the type-safe query builder. This is useful when you need to find entities that match specific criteria or retrieve paginated lists of results.

In FluxaORM v2, search methods are generated on the entity's Provider. Results are returned as plain slices -- there are no iterators.

## Typed Field Definitions

After code generation, each Provider has a `Fields` struct containing typed field definitions for every column. These fields provide type-safe filter methods that eliminate raw SQL strings for common queries.

```go
// Given this entity definition:
type UserEntity struct {
    ID        uint64 `orm:"redisCache"`
    Name      string `orm:"required"`
    Email     string `orm:"unique=Email;cached"`
    Age       uint32
    Status    string `orm:"enum=active,inactive;required"`
    CreatedAt time.Time
}

// After code generation, UserProvider.Fields contains:
// UserProvider.Fields.ID        → fluxaorm.UintField
// UserProvider.Fields.Name      → fluxaorm.StringField
// UserProvider.Fields.Email     → fluxaorm.StringField
// UserProvider.Fields.Age       → fluxaorm.UintField
// UserProvider.Fields.Status    → fluxaorm.EnumField
// UserProvider.Fields.CreatedAt → fluxaorm.TimeField
```

Each field type provides methods appropriate for its data type. See the [Field Types and Methods](#field-types-and-methods) section below for the full reference.

## Building Queries with NewQuery

Use `fluxaorm.NewQuery()` to build type-safe queries. The query builder supports filtering, sorting, and pagination through a fluent API:

```go
import "github.com/latolukasz/fluxaorm/v2"

query := fluxaorm.NewQuery().
    Filter(
        entities.UserProvider.Fields.Age.Gte(18),
        entities.UserProvider.Fields.Status.Is("active"),
    ).
    SortByDESC(entities.UserProvider.Fields.CreatedAt).
    Pager(fluxaorm.NewPager(1, 20))
```

### Filter

`Filter()` accepts one or more typed conditions. Multiple conditions are combined with AND logic:

```go
query := fluxaorm.NewQuery().Filter(
    entities.UserProvider.Fields.Age.Gte(18),
    entities.UserProvider.Fields.Status.Is("active"),
)
// WHERE `Age` >= 18 AND `Status` = 'active'
```

### SortByASC / SortByDESC

Sort results by any field:

```go
query := fluxaorm.NewQuery().
    SortByASC(entities.UserProvider.Fields.Name)

query = fluxaorm.NewQuery().
    SortByDESC(entities.UserProvider.Fields.CreatedAt)

// Multiple sort clauses
query = fluxaorm.NewQuery().
    SortByASC(entities.UserProvider.Fields.Status).
    SortByDESC(entities.UserProvider.Fields.CreatedAt)
```

### Pager

Use `fluxaorm.NewPager()` to define pagination:

```go
import "github.com/latolukasz/fluxaorm/v2"

// Load first 100 rows
pager := fluxaorm.NewPager(1, 100) // LIMIT 0,100
pager.GetPageSize()    // 100
pager.GetCurrentPage() // 1
pager.String()         // "LIMIT 0,100"

// Load next 100 rows (page 2)
pager = fluxaorm.NewPager(2, 100) // LIMIT 100,100
pager.GetPageSize()    // 100
pager.GetCurrentPage() // 2
pager.String()         // "LIMIT 100,100"

// Move to the next page
pager.IncrementPage()
pager.GetCurrentPage() // 3
```

### FilterWhere (Raw SQL Fallback)

For complex queries that cannot be expressed with typed fields, use `FilterWhere()` with a raw `Where` clause:

```go
query := fluxaorm.NewQuery().
    FilterWhere(fluxaorm.NewWhere("`Age` > ? AND `Name` LIKE ?", 18, "%john%"))
```

You can combine `Filter()` and `FilterWhere()` in the same query. All conditions are joined with AND:

```go
query := fluxaorm.NewQuery().
    Filter(entities.UserProvider.Fields.Status.Is("active")).
    FilterWhere(fluxaorm.NewWhere("`Name` LIKE ?", "%john%"))
```

#### Where Object

`fluxaorm.NewWhere()` defines raw SQL conditions:

```go
import "github.com/latolukasz/fluxaorm/v2"

// WHERE Email = "alice@example.com" AND Age >= 18
where := fluxaorm.NewWhere("`Email` = ? AND `Age` >= ?", "alice@example.com", 18)
where.String()        // "`Email` = ? AND `Age` >= ?"
where.GetParameters() // []any{"alice@example.com", 18}
```

If you pass a slice as a parameter, FluxaORM automatically expands it into `IN (?,?,...)` syntax:

```go
where := fluxaorm.NewWhere("`Age` IN ?", []int{18, 20, 30})
where.String()        // "`Age` IN (?,?,?)"
where.GetParameters() // []any{18, 20, 30}
```

## Searching for Multiple Entities

Use `SearchMany()` on the Provider to find entities matching a query:

```go
import "github.com/latolukasz/fluxaorm/v2"

users, err := entities.UserProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserProvider.Fields.Age.Gte(18)).
        SortByASC(entities.UserProvider.Fields.Name).
        Pager(fluxaorm.NewPager(1, 100)),
)
if err != nil {
    // handle error
}
for _, user := range users {
    fmt.Printf("User: %s\n", user.GetName())
}
```

Pass an empty query to load all rows (with optional pagination):

```go
users, err := entities.UserProvider.SearchMany(ctx,
    fluxaorm.NewQuery().Pager(fluxaorm.NewPager(1, 100)),
)
```

**Signature:**
```go
func (p XxxProvider) SearchMany(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*XxxEntity, error)
```

## Searching with Total Count

If you need the total number of matching rows (useful for pagination UIs), use `SearchManyWithTotal()`:

```go
users, total, err := entities.UserProvider.SearchManyWithTotal(ctx,
    fluxaorm.NewQuery().
        Filter(
            entities.UserProvider.Fields.Age.Gte(18),
            entities.UserProvider.Fields.Status.Is("active"),
        ).
        SortByDESC(entities.UserProvider.Fields.CreatedAt).
        Pager(fluxaorm.NewPager(1, 20)),
)
if err != nil {
    // handle error
}
fmt.Printf("Showing %d of %d total users\n", len(users), total)
```

This executes a `SELECT COUNT(*)` query first, then fetches the page of results.

**Signature:**
```go
func (p XxxProvider) SearchManyWithTotal(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*XxxEntity, int, error)
```

## Searching for a Single Entity

Use `SearchOne()` to find a single entity matching the query. This method automatically adds `LIMIT 1`:

```go
user, found, err := entities.UserProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserProvider.Fields.Email.Is("alice@example.com"),
    ),
)
if err != nil {
    // handle error
}
if !found {
    fmt.Println("User not found")
    return
}
fmt.Printf("Found user: %s\n", user.GetName())
```

::: tip Smart Unique Index Detection
When `SearchOne()` detects that the filter conditions match a cached unique index (e.g., filtering by `Email` when `Email` has the `unique` and `cached` tags), it automatically uses the cached index lookup instead of executing a SQL query. This gives you the same performance as `GetByIndexEmail()` with the convenience of the query builder API.
:::

**Signature:**
```go
func (p XxxProvider) SearchOne(ctx fluxaorm.Context, query *fluxaorm.DBQuery) (*XxxEntity, bool, error)
```

## Including Fake-Deleted Entities

If your entity has a `FakeDelete` field, all search methods automatically filter out soft-deleted rows. To include them, use `WithFakeDeletes()` on the `Where` clause via `FilterWhere()`:

```go
users, err := entities.UserProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserProvider.Fields.Status.Is("active")).
        FilterWhere(fluxaorm.NewWhere("1").WithFakeDeletes()),
)
```

## Field Types and Methods

### Standard Field Types

| Type | Methods |
|------|---------|
| `UintField` | `Eq(uint64)`, `In(...uint64)`, `Gte(uint64)`, `Lte(uint64)`, `Gt(uint64)`, `Lt(uint64)` |
| `IntField` | `Eq(int64)`, `In(...int64)`, `Gte(int64)`, `Lte(int64)`, `Gt(int64)`, `Lt(int64)` |
| `StringField` | `Is(string)`, `In(...string)`, `Like(string)` |
| `BoolField` | `Is(bool)` |
| `FloatField` | `Eq(float64)`, `In(...float64)`, `Gte(float64)`, `Lte(float64)`, `Gt(float64)`, `Lt(float64)` |
| `TimeField` | `Eq(time.Time)`, `Gte(time.Time)`, `Lte(time.Time)`, `Gt(time.Time)`, `Lt(time.Time)` |
| `EnumField` | `Is(string)`, `In(...string)` |
| `ReferenceField` | `Eq(uint64)`, `In(...uint64)` |

### Nullable Field Types

Nullable variants have all the same methods as their non-nullable counterparts, plus:

| Additional Methods |
|---|
| `IsNull()` |
| `IsNotNull()` |

The nullable types are: `NullableUintField`, `NullableIntField`, `NullableStringField`, `NullableBoolField`, `NullableFloatField`, `NullableEnumField`, `NullableReferenceField`, `NullableTimeField`.

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `SearchMany` | `([]*XxxEntity, error)` | Entities matching the query |
| `SearchManyWithTotal` | `([]*XxxEntity, int, error)` | Entities + total count |
| `SearchOne` | `(*XxxEntity, bool, error)` | Single entity (LIMIT 1), with smart cached index detection |
