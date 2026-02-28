# Search

In the previous section, you learned how to load entities from a database using their primary keys. In this section, we will cover how to search and load entities using SQL query conditions. This is useful when you need to find entities that match specific criteria or retrieve paginated lists of results.

In FluxaORM v2, search methods are generated on the entity's Provider. Results are returned as plain slices -- there are no iterators.

## Using the Pager Object

It is good practice to limit the number of rows returned in a search query. FluxaORM provides the `Pager` object to define SQL `LIMIT` clauses for pagination.

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

## Using the Where Object

Every SQL search query requires conditions. Use `fluxaorm.NewWhere()` to define these conditions:

```go
import "github.com/latolukasz/fluxaorm/v2"

// WHERE Email = "alice@example.com" AND Age >= 18
where := fluxaorm.NewWhere("Email = ? AND Age >= ?", "alice@example.com", 18)
where.String()        // "Email = ? AND Age >= ?"
where.GetParameters() // []any{"alice@example.com", 18}
```

### Modifying Parameters

You can update individual parameters or replace all parameters after creating a `Where`:

```go
// Update the first parameter (1-indexed)
where.SetParameter(1, "bob@example.com")
where.GetParameters() // []any{"bob@example.com", 18}

// Replace all parameters
where.SetParameters("carol@example.com", 21)
where.GetParameters() // []any{"carol@example.com", 21}
```

### Appending Conditions

You can append additional conditions to an existing `Where`:

```go
where := fluxaorm.NewWhere("Email = ? AND Age >= ?", "alice@example.com", 18)
where.Append(" AND Age <= ?", 60)
where.String()        // "Email = ? AND Age >= ? AND Age <= ?"
where.GetParameters() // []any{"alice@example.com", 18, 60}
```

### ORDER BY Clause

You can include `ORDER BY` directly in the where clause:

```go
// WHERE 1 ORDER BY Age
where := fluxaorm.NewWhere("1 ORDER BY Age")

// WHERE Age > 10 ORDER BY Age
where = fluxaorm.NewWhere("Age > ? ORDER BY Age", 10)
```

### Slice (IN) Parameters

If you pass a slice as a parameter, FluxaORM automatically expands it into `IN (?,?,...)` syntax:

```go
where := fluxaorm.NewWhere("Age IN ?", []int{18, 20, 30})
where.String()        // "Age IN (?,?,?)"
where.GetParameters() // []any{18, 20, 30}
```

## Searching for Entities

Use the `Search()` method on the Provider to find entities matching a SQL condition. It returns a plain slice of entity pointers:

```go
import "github.com/latolukasz/fluxaorm/v2"

users, err := UserProvider.Search(ctx, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
for _, user := range users {
    fmt.Printf("User: %s\n", user.GetName())
}
```

The `Pager` argument is optional. Pass `nil` to search for all matching rows without a limit:

```go
users, err := UserProvider.Search(ctx, fluxaorm.NewWhere("Age >= ?", 18), nil)
```

The `Where` argument is also optional. Pass `nil` to load all rows:

```go
users, err := UserProvider.Search(ctx, nil, fluxaorm.NewPager(1, 100))
```

**Signature:**
```go
func (p XxxProvider) Search(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]*XxxEntity, error)
```

## Searching with Total Count

If you need the total number of matching rows (useful for pagination UIs), use `SearchWithCount()`:

```go
users, total, err := UserProvider.SearchWithCount(ctx, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
fmt.Printf("Showing %d of %d total users\n", len(users), total)
```

This executes a `SELECT COUNT(*)` query first, then fetches the page of results.

**Signature:**
```go
func (p XxxProvider) SearchWithCount(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]*XxxEntity, int, error)
```

## Searching for a Single Entity

Use `SearchOne()` to find a single entity matching the condition. This method automatically adds `LIMIT 1` to the query:

```go
user, found, err := UserProvider.SearchOne(ctx, fluxaorm.NewWhere("Email = ?", "alice@example.com"))
if err != nil {
    // handle error
}
if !found {
    fmt.Println("User not found")
    return
}
fmt.Printf("Found user: %s\n", user.GetName())
```

::: tip
`SearchOne()` always appends `LIMIT 1` to the SQL query, so even if your condition matches multiple rows, only the first result is returned.
:::

**Signature:**
```go
func (p XxxProvider) SearchOne(ctx fluxaorm.Context, where fluxaorm.Where) (*XxxEntity, bool, error)
```

## Searching for Primary Keys

If you only need entity IDs without loading full entity data, use `SearchIDs()`:

```go
ids, err := UserProvider.SearchIDs(ctx, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
for _, id := range ids {
    fmt.Printf("User ID: %d\n", id)
}
```

**Signature:**
```go
func (p XxxProvider) SearchIDs(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]uint64, error)
```

If you also need the total count, use `SearchIDsWithCount()`:

```go
ids, total, err := UserProvider.SearchIDsWithCount(ctx, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
if err != nil {
    // handle error
}
fmt.Printf("Found %d IDs out of %d total\n", len(ids), total)
```

**Signature:**
```go
func (p XxxProvider) SearchIDsWithCount(ctx fluxaorm.Context, where fluxaorm.Where, pager fluxaorm.Pager) ([]uint64, int, error)
```

## Summary

| Method | Returns | Description |
|--------|---------|-------------|
| `Search` | `([]*XxxEntity, error)` | Entities matching the condition |
| `SearchWithCount` | `([]*XxxEntity, int, error)` | Entities + total count |
| `SearchOne` | `(*XxxEntity, bool, error)` | Single entity (LIMIT 1) |
| `SearchIDs` | `([]uint64, error)` | Primary keys only |
| `SearchIDsWithCount` | `([]uint64, int, error)` | Primary keys + total count |
