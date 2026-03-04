# Code Generation

FluxaORM v2 is built around **code generation**. You define entities as plain Go structs, register them with a `Registry`, validate into an `Engine`, and then call `fluxaorm.Generate()` to produce fully typed Provider and Entity code. The generated code handles all database scanning, dirty tracking, caching, and query building -- with zero reflection at runtime.

## Overview

The code generation workflow has three steps:

1. **Define** entity structs with struct tags (`orm:"..."`)
2. **Validate** the registry to produce an `Engine`
3. **Generate** typed Go code by calling `fluxaorm.Generate(engine, outputDir)`

The generated output includes:

| Generated type | Naming pattern | Purpose |
|---|---|---|
| **Provider** | `XxxProvider` | Singleton with table metadata and all query/factory methods |
| **Entity** | `XxxEntity` | Struct with context, ID, dirty tracking, getters/setters |
| **SQLRow** | `xxxSQLRow` | Flat struct for reflection-free database scanning |
| **Enums** | `enums/XxxName` | Type-safe string enum constants (separate package) |

## Calling Generate

```go
package main

import (
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{})
    registry.RegisterEntity(ProductEntity{})
    registry.RegisterEntity(CategoryEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    err = fluxaorm.Generate(engine, "./entities")
    if err != nil {
        panic(err)
    }
}
```

`Generate` accepts two arguments:

| Parameter | Type | Description |
|---|---|---|
| `engine` | `fluxaorm.Engine` | A validated engine containing all registered entity schemas |
| `outputDirectory` | `string` | An existing, writable directory where generated files will be placed |

The function will:

1. Resolve the output directory to an absolute path and verify it exists and is writable.
2. Find the nearest `go.mod` to determine the module name (used for the `enums` import path).
3. **Remove all existing `.go` files** in the output directory (but not subdirectories).
4. Generate one `.go` file per entity, named after the table name (e.g., `user.go`, `product.go`).
5. Generate enum type definitions in an `enums/` subdirectory if any entity uses enum or set fields.

::: warning
`Generate` deletes all `.go` files in the output directory before writing new ones. Do not place hand-written Go files in the same directory as generated output.
:::

::: tip
Run `Generate` as part of a dedicated `cmd/generate/main.go` program or a `go generate` directive. It should be executed whenever entity definitions change, not at application startup.
:::

## Output Structure

Given three entities `UserEntity`, `ProductEntity`, and `CategoryEntity`, the output directory will look like:

```
entities/
  user.go
  product.go
  category.go
  enums/
    UserStatus.go
    ProductType.go
```

Each generated file belongs to the package derived from the output directory name (e.g., `package entities`). The `enums/` subdirectory is created only if at least one entity has enum or set fields.

## Generated Provider

For each registered entity, the generator creates a **Provider** -- a package-level singleton variable that holds table metadata and provides all query and factory methods for that entity.

For a struct named `UserEntity` mapped to table `user`, the generator produces:

```go
// Private type with table metadata
type userProvider struct {
    tableName         string
    dbCode            string
    redisCode         string
    cacheIndex        uint64
    uuidRedisKeyMutex *sync.Mutex
    // ... additional fields for Redis cache/search if configured
}

// Public singleton -- use this in your application code
var UserProvider = userProvider{
    tableName: "user",
    dbCode:    "default",
    redisCode: "default",
    // ...
}
```

You never create a Provider yourself. Simply reference the exported variable (e.g., `entities.UserProvider`) and call methods on it.

### Query Methods

Every Provider has the following methods:

#### GetByID

Fetches a single entity by its primary key. Returns the entity, a boolean indicating whether it was found, and an error.

```go
user, found, err := entities.UserProvider.GetByID(ctx, 42)
if err != nil {
    return err
}
if !found {
    // user with ID 42 does not exist
}
fmt.Println(user.GetName())
```

**Signature:**
```go
func (p userProvider) GetByID(ctx fluxaorm.Context, id uint64) (entity *UserEntity, found bool, err error)
```

The method checks the context cache first, then Redis cache (if configured), and falls back to MySQL.

#### MustGetByID

A convenience wrapper around `GetByID` that panics if the entity is not found. The `bool` return value is removed; errors are still returned normally.

```go
user, err := entities.UserProvider.MustGetByID(ctx, 42)
if err != nil {
    return err
}
// No need to check "found" -- panics if user with ID 42 does not exist
fmt.Println(user.GetName())
```

**Signature:**
```go
func (p userProvider) MustGetByID(ctx fluxaorm.Context, id uint64) (entity *UserEntity, err error)
```

Use `MustGetByID` when a missing entity indicates a programming error or data inconsistency. It calls `GetByID` internally and panics with a descriptive message if the entity is not found.

#### GetByIDs

Fetches multiple entities by their primary keys. Returns a slice containing only the found entities (missing IDs are silently skipped), preserving the order of the input IDs.

```go
users, err := entities.UserProvider.GetByIDs(ctx, 1, 2, 3, 10, 20)
if err != nil {
    return err
}
for _, user := range users {
    fmt.Println(user.GetID(), user.GetName())
}
```

**Signature:**
```go
func (p userProvider) GetByIDs(ctx fluxaorm.Context, id ...uint64) ([]*UserEntity, error)
```

Duplicated IDs in the input are automatically deduplicated. The method uses context cache, Redis cache (if configured), and MySQL in a batched query for any remaining IDs.

#### New

Creates a new entity instance with an auto-generated UUID. The entity is automatically tracked for flushing.

```go
user := entities.UserProvider.New(ctx)
user.SetName("Alice")
user.SetEmail("alice@example.com")
err := ctx.Flush()
```

**Signature:**
```go
func (p userProvider) New(ctx fluxaorm.Context) *UserEntity
```

UUIDs are generated via Redis INCR, initialized from the current MAX(ID) in MySQL on first use. This guarantees unique, monotonically increasing IDs across all application instances.

#### NewWithID

Creates a new entity instance with a specific ID. Use this when you need to control the ID value.

```go
user := entities.UserProvider.NewWithID(ctx, 1000)
user.SetName("Bob")
err := ctx.Flush()
```

**Signature:**
```go
func (p userProvider) NewWithID(ctx fluxaorm.Context, id uint64) *UserEntity
```

#### Search

Queries for entities matching a WHERE clause with optional pagination.

```go
where := fluxaorm.NewWhere("`Age` > ? AND `Status` = ?", 18, "active")
pager := &fluxaorm.Pager{CurrentPage: 1, PageSize: 20}

users, err := entities.UserProvider.Search(ctx, where, pager)
if err != nil {
    return err
}
for _, user := range users {
    fmt.Println(user.GetName())
}
```

**Signature:**
```go
func (p userProvider) Search(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]*UserEntity, error)
```

Both `where` and `pager` can be `nil`. Passing `nil` for `where` returns all rows; passing `nil` for `pager` returns all matching rows without pagination.

#### SearchOne

Queries for a single entity matching a WHERE clause. Adds `LIMIT 1` automatically.

```go
where := fluxaorm.NewWhere("`Email` = ?", "alice@example.com")
user, found, err := entities.UserProvider.SearchOne(ctx, where)
```

**Signature:**
```go
func (p userProvider) SearchOne(ctx fluxaorm.Context, where fluxaorm.Where) (*UserEntity, bool, error)
```

#### SearchWithCount

Like `Search`, but also returns the total number of matching rows (before pagination). Useful for building paginated UIs.

```go
pager := &fluxaorm.Pager{CurrentPage: 2, PageSize: 10}
users, total, err := entities.UserProvider.SearchWithCount(ctx, nil, pager)
// total = 150 (all matching rows), len(users) = 10 (current page)
```

**Signature:**
```go
func (p userProvider) SearchWithCount(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]*UserEntity, int, error)
```

#### SearchIDs

Like `Search`, but returns only the entity IDs (not full entities). Useful when you only need IDs or want to minimize data transfer.

```go
ids, err := entities.UserProvider.SearchIDs(ctx, where, pager)
```

**Signature:**
```go
func (p userProvider) SearchIDs(ctx fluxaorm.Context, where fluxaorm.Where, pager *fluxaorm.Pager) ([]uint64, error)
```

#### SearchIDsWithCount

Like `SearchIDs`, but also returns the total count.

```go
ids, total, err := entities.UserProvider.SearchIDsWithCount(ctx, where, pager)
```

**Signature:**
```go
func (p userProvider) SearchIDsWithCount(ctx fluxaorm.Context, where fluxaorm.Where, pager fluxaorm.Pager) ([]uint64, int, error)
```

### Unique Index Getters

If an entity has unique indexes defined, the generator creates `GetByIndex<IndexName>` methods on the Provider. These accept the index column values as parameters and return a single entity.

```go
user, found, err := entities.UserProvider.GetByIndexEmail(ctx, "alice@example.com")
```

If the unique index has Redis caching enabled (`cachedUnique` tag), the lookup first checks Redis before falling back to MySQL, and caches the result for future lookups.

### Redis Search Methods

If an entity has Redis Search configured, additional methods are generated:

- `SearchInRedis(ctx, where, pager)` -- search using Redis Search, returns full entities
- `SearchOneInRedis(ctx, where)` -- search for a single entity using Redis Search
- `SearchInRedisWithCount(ctx, where, pager)` -- search with total count
- `SearchIDsInRedis(ctx, where, pager)` -- search returning only IDs
- `SearchIDsInRedisWithCount(ctx, where, pager)` -- search IDs with total count
- `ReindexRedisSearch(ctx)` -- rebuild the entire Redis Search index from MySQL data

These methods use `*fluxaorm.RedisSearchWhere` instead of `fluxaorm.Where`.

## Generated Entity

For each registered entity, the generator creates an **Entity struct** that wraps the raw database data with context awareness and dirty tracking.

```go
type UserEntity struct {
    ctx                  fluxaorm.Context
    id                   uint64
    new                  bool
    deleted              bool
    originDatabaseValues *userSQLRow
    databaseBind         map[string]any
    // ... additional fields for Redis cache if configured
}
```

### Core Methods

Every generated entity has these methods:

```go
// Returns the entity's primary key
func (e *UserEntity) GetID() uint64

// Marks the entity for deletion on next Flush()
func (e *UserEntity) Delete()
```

If the entity has a `FakeDelete` field, `Delete()` performs a soft delete by setting `FakeDelete = true`. A separate `ForceDelete()` method is also generated for hard deletes.

### Getters and Setters

For each field in the entity struct, the generator creates typed getter and setter methods. The naming pattern is:

| Method | Description |
|---|---|
| `Get<Field>()` | Returns the current value (checks dirty map first, then origin) |
| `Set<Field>(value)` | Sets a new value; automatically tracks the entity for flushing if the value changed |

**Example for a `Name` field of type `string`:**

```go
name := user.GetName()      // returns string
user.SetName("New Name")    // sets a new value, marks entity as dirty
```

**Setter dirty tracking:** When you call a setter, it compares the new value against the original value. If they are the same, the field is removed from the dirty map (no-op). If they differ, the field is added to the dirty map and the entity is automatically tracked for the next `Flush()` call.

### Field Type Mapping

The generated getters and setters use Go-native types:

| Entity field type | Getter return type | Setter parameter type |
|---|---|---|
| `uint`, `uint8`, ..., `uint64` | `uint64` | `uint64` |
| `int`, `int8`, ..., `int64` | `int64` | `int64` |
| `float32`, `float64` | `float64` | `float64` |
| `bool` | `bool` | `bool` |
| `string` | `string` | `string` |
| `time.Time` | `time.Time` | `time.Time` |
| `*uint64` (nullable) | `*uint64` | `*uint64` |
| Enum field | `enums.XxxName` | `enums.XxxName` |
| Set field | `[]enums.XxxName` | `...enums.XxxName` (variadic) |

### Reference Fields

For reference (foreign key) fields, the generator creates three methods:

```go
// Returns the raw foreign key value
func (e *ProductEntity) GetCategoryID() uint64

// Sets the raw foreign key value
func (e *ProductEntity) SetCategory(value uint64)

// Loads the referenced entity (calls GetByID on the referenced Provider)
func (e *ProductEntity) GetCategory(ctx fluxaorm.Context) (*CategoryEntity, bool, error)

// Loads the referenced entity, panics if not found
func (e *ProductEntity) MustGetCategory(ctx fluxaorm.Context) (*CategoryEntity, error)
```

The `MustGet<Reference>` method is a convenience wrapper around `Get<Reference>`. It removes the `bool` return value and panics if the referenced entity is not found. Errors are still returned normally. This works the same way for both required and optional references.

For optional (non-required) references, the ID getter returns `*uint64` instead of `uint64`.

## Generated SQLRow

The `SQLRow` struct is a flat, unexported type used internally for reflection-free database scanning. Each field is named `F0`, `F1`, `F2`, etc., matching the column order.

```go
type userSQLRow struct {
    F0 uint64         // ID
    F1 string         // Name
    F2 sql.NullString // Email (nullable)
    F3 time.Time      // CreatedAt
    // ...
}
```

You do not interact with `SQLRow` directly. It is used by the generated Provider methods to scan query results and by the Entity methods to read original values.

## Generated Enums

When an entity field uses the `enum` or `set` struct tag, the generator creates type-safe enum definitions in the `enums/` subdirectory.

For example, given an entity field:

```go
type UserEntity struct {
    ID     uint64
    Status string `orm:"enum=active,inactive,banned;required"`
}
```

The generator creates `enums/UserStatus.go`:

```go
package enums

type UserStatus string

var UserStatusList = struct {
    Active   UserStatus
    Inactive UserStatus
    Banned   UserStatus
}{
    Active:   "active",
    Inactive: "inactive",
    Banned:   "banned",
}
```

Use enum values in your application code:

```go
import "your/module/entities/enums"

user := entities.UserProvider.New(ctx)
user.SetStatus(enums.UserStatusList.Active)

status := user.GetStatus() // returns enums.UserStatus
if status == enums.UserStatusList.Banned {
    // handle banned user
}
```

## Practical Workflow

Here is a complete example showing the typical development workflow with FluxaORM code generation.

### Step 1: Define Entities

```go
package main

import "time"

type UserEntity struct {
    ID        uint64
    Name      string    `orm:"required;length=200"`
    Email     string    `orm:"required;unique=Email;length=255"`
    Age       uint8
    Status    string    `orm:"enum=active,inactive,banned;required"`
    CreatedAt time.Time `orm:"time"`
}

type ProductEntity struct {
    ID          uint64
    Name        string `orm:"required;length=200"`
    Category    *CategoryEntity
    Price       float64 `orm:"decimal=10,2"`
}

type CategoryEntity struct {
    ID   uint64
    Name string `orm:"required;length=100"`
}
```

### Step 2: Generate Code

Create a generation program (e.g., `cmd/generate/main.go`):

```go
package main

import (
    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{})
    registry.RegisterEntity(ProductEntity{})
    registry.RegisterEntity(CategoryEntity{})

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    err = fluxaorm.Generate(engine, "./entities")
    if err != nil {
        panic(err)
    }
}
```

Run it:

```bash
go run cmd/generate/main.go
```

### Step 3: Use Generated Code

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
    "your/module/entities"
    "your/module/entities/enums"
)

func main() {
    // ... setup registry and engine (same as above)
    ctx := engine.NewContext(context.Background())

    // Create a new user
    user := entities.UserProvider.New(ctx)
    user.SetName("Alice")
    user.SetEmail("alice@example.com")
    user.SetAge(30)
    user.SetStatus(enums.UserStatusList.Active)

    // Create a category and product
    category := entities.CategoryProvider.New(ctx)
    category.SetName("Electronics")

    product := entities.ProductProvider.New(ctx)
    product.SetName("Laptop")
    product.SetCategoryID(category.GetID())
    product.SetPrice(999.99)

    // Persist all changes in a single flush
    err := ctx.Flush()
    if err != nil {
        panic(err)
    }

    // Query entities
    foundUser, exists, err := entities.UserProvider.GetByID(ctx, user.GetID())
    if err != nil {
        panic(err)
    }
    if exists {
        fmt.Println("Found user:", foundUser.GetName())
    }

    // Search with conditions
    where := fluxaorm.NewWhere("`Age` >= ?", 18)
    pager := &fluxaorm.Pager{CurrentPage: 1, PageSize: 10}
    users, err := entities.UserProvider.Search(ctx, where, pager)
    if err != nil {
        panic(err)
    }
    for _, u := range users {
        fmt.Println(u.GetName(), u.GetEmail())
    }

    // Unique index lookup
    userByEmail, found, err := entities.UserProvider.GetByIndexEmail(ctx, "alice@example.com")
    if err != nil {
        panic(err)
    }
    if found {
        fmt.Println("Found by email:", userByEmail.GetName())
    }

    // Update an entity
    foundUser.SetName("Alice Updated")
    err = ctx.Flush()
    if err != nil {
        panic(err)
    }

    // Delete an entity
    foundUser.Delete()
    err = ctx.Flush()
    if err != nil {
        panic(err)
    }
}
```
