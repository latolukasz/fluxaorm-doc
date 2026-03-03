# CRUD Operations

In the previous sections, you learned how to configure FluxaORM and update the MySQL schema. Now it is time to perform CRUD (Create, Read, Update, and Delete) operations.

In FluxaORM v2, all CRUD operations go through **generated Provider singletons** and **entity methods**. After defining your entity structs and running the code generator, each entity gets:

- A `XxxProvider` variable with methods like `New()`, `GetByID()`, `GetByIDs()`, `Search()`, etc.
- A `XxxEntity` struct with typed getter/setter methods like `GetName()`, `SetName()`, `Delete()`, etc.

The following examples build upon this code base:

```go
package main

import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"localCache;redisCache"`
    Code string `orm:"required;length=10;unique=Code"`
    Name string `orm:"required;length=100"`
}

type ProductEntity struct {
    ID       uint64 `orm:"redisCache"`
    Name     string `orm:"required;length=100"`
    Price    float64
    Category uint64 `orm:"required"` // reference to CategoryEntity
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 0)
    registry.RegisterEntity(&CategoryEntity{}, &ProductEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    // Generate code (typically done once, output committed to your repo)
    err = fluxaorm.Generate(engine, "entities")
    if err != nil {
        panic(err)
    }

    ctx := engine.NewContext(context.Background())
    // Use ctx with generated Providers for all CRUD operations
    _ = ctx
}
```

After running the code generator, you will have `CategoryEntityProvider` and `ProductEntityProvider` singletons in the `entities` package, along with `CategoryEntity` and `ProductEntity` structs with typed getters and setters.

## Creating Entities

To insert a new entity into the database, use the Provider's `New()` method and then call `ctx.Flush()`:

```go
category := entities.CategoryEntityProvider.New(ctx)
category.SetCode("electronics")
category.SetName("Electronics")
err := ctx.Flush()
```

The `New()` method automatically generates a unique ID for the entity using Redis-backed UUID generation. The entity is registered with the context immediately upon creation, so `ctx.Flush()` knows about it.

### Creating with a Specific ID

If you need to set the ID yourself, use `NewWithID()`:

```go
category := entities.CategoryEntityProvider.NewWithID(ctx, 42)
category.SetCode("books")
category.SetName("Books")
err := ctx.Flush()
```

### Batch Inserts

You can create multiple entities before calling `Flush()`. All inserts are batched into a single transaction:

```go
cat1 := entities.CategoryEntityProvider.New(ctx)
cat1.SetCode("electronics")
cat1.SetName("Electronics")

cat2 := entities.CategoryEntityProvider.New(ctx)
cat2.SetCode("books")
cat2.SetName("Books")

product := entities.ProductEntityProvider.New(ctx)
product.SetName("Laptop")
product.SetPrice(999.99)
product.SetCategory(cat1.GetID()) // reference by ID

err := ctx.Flush() // all three entities inserted in one batch
```

## Reading Entities

### GetByID

To retrieve a single entity by its primary key, use `GetByID()`:

```go
product, found, err := entities.ProductEntityProvider.GetByID(ctx, 12345)
if err != nil {
    // handle error
}
if !found {
    // entity does not exist
}
fmt.Println(product.GetName())  // "Laptop"
fmt.Println(product.GetPrice()) // 999.99
```

The return signature is `(*XxxEntity, bool, error)`. The boolean indicates whether the entity was found.

`GetByID()` automatically uses the three-tier cache (context cache, Redis cache, MySQL) when available.

### GetByIDs

To retrieve multiple entities by their IDs, use `GetByIDs()`:

```go
products, err := entities.ProductEntityProvider.GetByIDs(ctx, 123, 456, 789)
if err != nil {
    // handle error
}
for _, product := range products {
    fmt.Println(product.GetID(), product.GetName())
}
```

The return signature is `([]*XxxEntity, error)`. The returned slice contains only the entities that were found -- missing IDs are silently skipped. The order of results matches the order of the input IDs (excluding missing ones).

### GetByIndex (Unique Index)

If your entity has a unique index, the code generator creates a `GetByIndex<IndexName>()` method:

```go
// Given: Code string `orm:"required;length=10;unique=Code"`
category, found, err := entities.CategoryEntityProvider.GetByIndexCode(ctx, "electronics")
```

### Search

For general queries with WHERE clauses, use `Search()`:

```go
products, err := entities.ProductEntityProvider.Search(
    ctx,
    fluxaorm.NewWhere("`Price` > ? AND `Category` = ?", 100.0, categoryID),
    fluxaorm.NewPager(1, 20), // page 1, 20 results per page
)
```

### SearchOne

To retrieve a single entity matching a WHERE clause:

```go
product, found, err := entities.ProductEntityProvider.SearchOne(
    ctx,
    fluxaorm.NewWhere("`Name` = ?", "Laptop"),
)
```

### SearchWithCount

To get both results and total count (useful for pagination):

```go
products, totalRows, err := entities.ProductEntityProvider.SearchWithCount(
    ctx,
    fluxaorm.NewWhere("`Category` = ?", categoryID),
    fluxaorm.NewPager(1, 20),
)
fmt.Printf("Showing %d of %d total products\n", len(products), totalRows)
```

### SearchIDs

To retrieve only IDs without loading full entities:

```go
ids, err := entities.ProductEntityProvider.SearchIDs(
    ctx,
    fluxaorm.NewWhere("`Price` > ?", 50.0),
    nil, // no pager, return all matching IDs
)
```

## Updating Entities

In v2, updating an entity is straightforward: retrieve it, call setters on the fields you want to change, and flush. There is no need for `EditEntity()` or `EditEntityField()` -- the entity automatically tracks which fields have been modified (dirty tracking).

```go
product, found, err := entities.ProductEntityProvider.GetByID(ctx, 12345)
if err != nil || !found {
    // handle error or not found
}

product.SetName("Gaming Laptop")
product.SetPrice(1299.99)
err = ctx.Flush() // executes UPDATE ProductEntity SET Name=?, Price=? WHERE ID=12345
```

### How Dirty Tracking Works

Each `Set<Field>()` call compares the new value against the current (original) value. If the value is the same, the setter is a no-op. Only actually changed fields are included in the UPDATE statement.

```go
product, _, _ := entities.ProductEntityProvider.GetByID(ctx, 12345)

product.SetName("Same Name")  // no-op if Name is already "Same Name"
product.SetPrice(1499.99)     // marks Price as dirty

err := ctx.Flush() // UPDATE only includes Price (if Name was unchanged)
```

### Tracking Entities from Search Results

Entities returned by `GetByID()` and `GetByIDs()` are automatically placed in the context cache. However, entities returned by `Search()`, `SearchOne()`, and `SearchWithCount()` are **not** automatically tracked for flush.

To update entities returned by search methods, you need to register them with the context using `ctx.Track()`:

```go
products, _ := entities.ProductEntityProvider.Search(ctx, fluxaorm.NewWhere("`Price` > ?", 100.0), nil)
for _, product := range products {
    product.SetPrice(product.GetPrice() * 0.9) // 10% discount
}
err := ctx.Flush()
```

When you call `Set<Field>()` on an entity, the entity automatically tracks itself with the context if it was not already tracked.

## Deleting Entities

To delete an entity, call the `Delete()` method on it and then flush:

```go
product, found, err := entities.ProductEntityProvider.GetByID(ctx, 12345)
if err != nil || !found {
    // handle error or not found
}

product.Delete()
err = ctx.Flush() // executes DELETE FROM ProductEntity WHERE ID = 12345
```

The `Delete()` method marks the entity for deletion and registers it with the context. The actual DELETE query is executed when `ctx.Flush()` is called.

## Flush

`ctx.Flush()` is the central method that executes all pending operations. It processes all tracked entities and:

1. **Inserts** new entities created with `Provider.New()` or `Provider.NewWithID()`
2. **Updates** existing entities that have dirty (modified) fields
3. **Deletes** entities marked with `entity.Delete()`

All SQL operations for the same MySQL pool are batched into a single transaction. Redis cache updates are sent via Redis pipelines. This ensures that all database operations are both fast and atomic.

```go
// Create
cat := entities.CategoryEntityProvider.New(ctx)
cat.SetCode("toys")
cat.SetName("Toys")

// Update
product, _, _ := entities.ProductEntityProvider.GetByID(ctx, 12345)
product.SetName("Updated Name")

// Delete
oldProduct, _, _ := entities.ProductEntityProvider.GetByID(ctx, 99999)
oldProduct.Delete()

// Execute all operations in one batch
err := ctx.Flush()
```

After a successful flush, tracked entities are cleared from the context. If you need to make further changes, simply modify entities and call `Flush()` again.

See [Lifecycle Callbacks](/guide/lifecycle_callbacks) to register handlers that execute after successful INSERT, UPDATE, or DELETE operations.

### ClearFlush

If you need to discard all pending operations without executing them, use `ClearFlush()`:

```go
product.SetName("Tentative Name")
ctx.ClearFlush() // discards all pending inserts, updates, and deletes
```

## FlushAsync

`ctx.FlushAsync(immediateRedisUpdates)` works like `Flush()` but instead of executing SQL directly against MySQL, it publishes the SQL queries to a Redis Stream for asynchronous processing. Pass `true` to update Redis cache and search indexes immediately (optimistic update), or `false` to defer all cache updates to the consumer alongside the SQL writes.

```go
product := entities.ProductEntityProvider.New(ctx)
product.SetName("Async Product")
product.SetPrice(29.99)

err := ctx.FlushAsync(true) // SQL queued to Redis Stream; Redis cache updated immediately
// or
err = ctx.FlushAsync(false) // both SQL and Redis cache deferred to the consumer
```

To process the queued SQL operations, you need to run a consumer:

```go
consumer, err := ctx.GetAsyncSQLConsumer()
if err != nil {
    panic(err)
}
// In a background goroutine or worker process:
err = consumer.Consume(100, 5*time.Second) // process up to 100 events, block for 5s
```

This is useful for write-heavy workloads where you want to return a response quickly and defer the MySQL writes to a background worker.

## Accessing Field Values

All field values are accessed through generated typed getter methods:

```go
product, _, _ := entities.ProductEntityProvider.GetByID(ctx, 12345)

// Getters
id := product.GetID()           // uint64
name := product.GetName()       // string
price := product.GetPrice()     // float64
catID := product.GetCategory()  // uint64 (reference ID)

// Setters
product.SetName("New Name")
product.SetPrice(199.99)
product.SetCategory(newCategoryID)
```

### Nullable Fields

For nullable fields (pointer types in the struct definition), getters return pointers — except for nullable strings which return `string` (empty string `""` when NULL):

```go
type UserEntity struct {
    ID      uint64  `orm:"redisCache"`
    Name    string  `orm:"required"`
    Age     *uint64 // nullable
    Comment string  // nullable (no "required" tag)
}

user, _, _ := entities.UserEntityProvider.GetByID(ctx, 1)
age := user.GetAge()         // *uint64 (nil if NULL in database)
comment := user.GetComment() // string ("" if NULL in database)

// Setting nullable fields
user.SetAge(nil)           // sets to NULL
newAge := uint64(30)
user.SetAge(&newAge)       // sets to 30
user.SetComment("")        // sets to NULL
user.SetComment("hello")   // sets to "hello"
```

### Reference Fields

For reference fields (foreign keys to other entities), the generated code provides both an ID getter and a convenience method to load the referenced entity:

```go
// Get just the reference ID
categoryID := product.GetCategoryID() // uint64

// Load the referenced entity (performs a GetByID on the referenced Provider)
category, found, err := product.GetCategory(ctx)
```
