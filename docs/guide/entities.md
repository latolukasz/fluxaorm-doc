# Entities

In FluxaORM v2, an Entity is a Go struct that represents data stored in a MySQL database table. You define the struct, register it with a Registry, validate the configuration, and then run code generation to produce typed Provider and Entity code with getters, setters, and query methods.

## Defining an Entity

To define an entity, create a Go struct with an `ID` field of type `uint64` as the first field:

```go
package entity

import "github.com/latolukasz/fluxaorm/v2"

type UserEntity struct {
    ID    uint64
    Name  string `orm:"required"`
    Email string `orm:"required;unique=Email"`
    Age   uint8
}
```

Every entity must have an `ID uint64` field. This field maps to the primary key in the corresponding MySQL table.

## Registering and Validating Entities

Before you can use entities, you must register them with a Registry and validate the configuration:

```go
package main

import "github.com/latolukasz/fluxaorm/v2"

func main() {
    registry := fluxaorm.NewRegistry()

    // Register data pools
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/mydb", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

    // Register entities
    registry.RegisterEntity(UserEntity{}, ProductEntity{}, CategoryEntity{})

    // Validate configuration and create engine
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    // Generate typed code
    err = fluxaorm.Generate(engine, "./entities")
    if err != nil {
        panic(err)
    }
}
```

The workflow is:

1. Create a `Registry` with `fluxaorm.NewRegistry()`
2. Register MySQL and Redis pools
3. Register entity structs with `registry.RegisterEntity(...)`
4. Call `registry.Validate()` to verify configuration and create an Engine
5. Call `fluxaorm.Generate(engine, outputDir)` to generate typed code

After `Generate()` runs, you get a typed Provider and Entity for each registered struct. For example, registering `UserEntity` produces:

- `entities.UserEntityProvider` -- a Provider variable with methods like `New()`, `GetByID()`, `Search()`, etc.
- `entities.UserEntity` -- a generated Entity type with `GetName()`, `SetName()`, `GetEmail()`, `SetEmail()`, etc.

## MySQL Pool

By default, every entity is connected to the `default` MySQL pool. You can specify a different pool using the `orm:"mysql=pool_name"` tag on the `ID` field:

```go
type UserEntity struct {
    ID uint64 // uses the "default" pool
}

type OrderEntity struct {
    ID uint64 `orm:"mysql=sales"` // uses the "sales" pool
}
```

Make sure to register the pool in the Registry:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterMySQL("user:password@tcp(localhost:3306)/users", fluxaorm.DefaultPoolCode, nil)
registry.RegisterMySQL("user:password@tcp(localhost:3307)/sales", "sales", nil)
registry.RegisterEntity(UserEntity{}, OrderEntity{})
```

## Redis Cache

To protect MySQL from unnecessary queries, entities can be automatically cached in Redis. Enable Redis caching with the `orm:"redisCache"` tag on the `ID` field:

```go
type UserEntity struct {
    ID uint64 `orm:"redisCache"` // cache in the "default" Redis pool
}

type OrderEntity struct {
    ID uint64 `orm:"redisCache=orders"` // cache in the "orders" Redis pool
}
```

When Redis caching is enabled, FluxaORM automatically stores entity data in Redis after loading it from MySQL. Subsequent reads are served from Redis, significantly reducing MySQL load.

::: tip
To optimize Redis as a cache, set the `maxmemory` configuration to a value below the machine's memory size and enable the `allkeys-lru` eviction policy. Consider disabling persistence -- if data is lost, FluxaORM automatically refills it from MySQL.
:::

### Cache TTL

By default, Redis cache entries never expire. You can set a TTL (in seconds) using the `ttl` tag:

```go
type UserEntity struct {
    ID uint64 `orm:"redisCache;ttl=30"` // Cache for 30 seconds
}
```

The TTL is reset every time the data is updated.

## Local In-Memory Cache

To cache entity data in local memory, use the `localCache` tag. You can optionally specify a maximum cache size:

```go
type CategoryEntity struct {
    ID uint64 `orm:"localCache"` // unlimited local cache
}

type ProductEntity struct {
    ID uint64 `orm:"localCache=1000"` // cache up to 1000 entities
}
```

### Using Both Redis and Local Cache

You can enable both local and Redis caching on the same entity:

```go
type CategoryEntity struct {
    ID uint64 `orm:"localCache;redisCache"`
}
```

::: tip
Enabling both local and Redis caching is highly recommended for frequently accessed entities. When data is requested:

1. FluxaORM first checks the local cache
2. If not found locally, it checks Redis
3. If not in Redis either, it queries MySQL, then populates both caches

This multi-layer caching greatly reduces MySQL load, especially when running on multiple servers or with autoscaling.
:::

## Custom Table Name

By default, FluxaORM uses the struct name as the MySQL table name. Override this with the `table` tag:

```go
type UserEntity struct {
    ID uint64 `orm:"table=users"`
}
```

## Soft Deletes (Fake Delete)

To enable soft deletes, add a `FakeDelete bool` field to your entity:

```go
type ProductEntity struct {
    ID         uint64
    Name       string `orm:"required"`
    FakeDelete bool
}
```

When `FakeDelete` is present, calling `entity.Delete()` sets the `FakeDelete` column to `1` instead of removing the row from MySQL. All generated query methods (`Search`, `SearchIDs`, etc.) automatically filter out soft-deleted rows unless you explicitly include them using `fluxaorm.NewWhere("1 = 1").WithFakeDeletes()`.

## Automatic Timestamps

FluxaORM automatically manages `CreatedAt` and `UpdatedAt` fields if they are defined as `time.Time`:

```go
type UserEntity struct {
    ID        uint64
    Name      string    `orm:"required"`
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

- `CreatedAt` is automatically set to the current UTC time on insert (unless you set it explicitly before flushing)
- `UpdatedAt` is automatically set to the current UTC time on both insert and update

## References (Foreign Keys)

Use `fluxaorm.Reference[T]` to define a foreign key relationship to another entity:

```go
type CategoryEntity struct {
    ID   uint64
    Name string `orm:"required"`
}

type ProductEntity struct {
    ID       uint64
    Name     string                                 `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity]      `orm:"required"`
}
```

The `Category` field creates a `Category bigint NOT NULL` column in the `ProductEntity` table. After code generation, you access the reference ID via `entity.GetCategoryID()` and set it via `entity.SetCategory(id)`.

To make a reference optional (nullable), omit the `orm:"required"` tag:

```go
type ProductEntity struct {
    ID       uint64
    Name     string                                 `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity]      // nullable reference
}
```

For an optional reference, the getter returns `*uint64`: `entity.GetCategoryID()` returns `nil` when no reference is set.

## Enums and Sets

Define inline enums and sets directly in the struct tag without implementing any interface:

```go
type OrderEntity struct {
    ID     uint64
    Status string `orm:"enum=pending,processing,shipped,delivered;required"`
    Tags   string `orm:"set=sale,featured,new;required"`
}
```

The `enum` tag creates a MySQL `ENUM` column, and the `set` tag creates a MySQL `SET` column.

### Shared Enum Types

When multiple fields use the same set of values, use `enumName` to share a single generated type:

```go
type OrderEntity struct {
    ID             uint64
    Status         string `orm:"enum=pending,processing,shipped,delivered;required"`
    PreviousStatus string `orm:"enum=pending,processing,shipped,delivered;enumName=Status"`
}
```

You can also share enums **across entities** by defining the values in one entity and referencing them from others:

```go
type OrderEntity struct {
    ID     uint64
    Status string `orm:"enum=pending,processing,shipped,delivered;required;enumName=OrderStatus"`
}

type OrderLogEntity struct {
    ID     uint64
    Status string `orm:"enum;enumName=OrderStatus"` // no values needed — references OrderEntity
}
```

This works the same way for sets: `orm:"set;enumName=TypeName"` references a definition from another entity. Values only need to be defined once — when you add a new value, only the defining entity needs to change.

Both fields share the generated `enums.Status` type. The code generator creates enum types in an `enums/` subdirectory with typed constants:

```go
// Generated in enums/Status.go
package enums

type Status string
var StatusList = struct {
    Pending    Status
    Processing Status
    Shipped    Status
    Delivered  Status
}{
    Pending:    "pending",
    Processing: "processing",
    Shipped:    "shipped",
    Delivered:  "delivered",
}
```

After generation, you use the typed enum values:

```go
order := entities.OrderEntityProvider.New(ctx)
order.SetStatus(enums.StatusList.Pending)

// For sets, pass variadic values
order.SetTags(enums.StatusList.Sale, enums.StatusList.Featured)
```

## Redis Search

To enable full-text and numeric search via Redis Search, add the `orm:"redisSearch"` tag to the `ID` field and mark individual fields as `searchable` and optionally `sortable`:

```go
type ProductEntity struct {
    ID    uint64  `orm:"redisSearch=default"`
    Name  string  `orm:"required;searchable"`
    Price float64 `orm:"searchable;sortable"`
    Stock uint32  `orm:"searchable;sortable"`
}
```

After code generation, the Provider includes Redis Search methods like `SearchIDsInRedis()`, `SearchInRedis()`, and `SearchOneInRedis()`.

## Unique Indexes

Define unique indexes using the `orm:"unique=IndexName"` tag. For composite indexes, use a position suffix:

```go
type UserEntity struct {
    ID    uint64
    Name  string `orm:"required;unique=NameAge"`
    Age   uint8  `orm:"unique=NameAge:2"`
    Email string `orm:"required;unique=Email"`
}
```

This creates two unique indexes: a composite `NameAge` index on `(Name, Age)` and a single-column `Email` index. After code generation, you get typed lookup methods:

```go
user, found, err := entities.UserEntityProvider.GetByIndexNameAge(ctx, "Alice", 30)
user, found, err := entities.UserEntityProvider.GetByIndexEmail(ctx, "alice@example.com")
```

See the [MySQL Indexes](/guide/mysql_indexes.html) page for full details on unique indexes and caching.

## Complete Example

Here is a complete example showing multiple entities with various features:

```go
package entity

import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"localCache;redisCache"`
    Name string `orm:"required;unique=Name"`
}

type UserEntity struct {
    ID        uint64 `orm:"redisCache"`
    Name      string `orm:"required"`
    Email     string `orm:"required;unique=Email"`
    Age       uint8
    Active    bool
    CreatedAt time.Time
    UpdatedAt time.Time
}

type ProductEntity struct {
    ID         uint64    `orm:"redisCache"`
    Name       string    `orm:"required"`
    Price      float64   `orm:"decimal=10,2;unsigned"`
    Status     string    `orm:"enum=draft,active,archived;required"`
    Category   fluxaorm.Reference[CategoryEntity] `orm:"required"`
    FakeDelete bool
    CreatedAt  time.Time
    UpdatedAt  time.Time
}
```

## Struct Tags Reference

All `orm` struct tags available in v2:

| Tag | Description |
|-----|-------------|
| `mysql=pool` | Use a specific MySQL pool (on `ID` field) |
| `table=name` | Custom MySQL table name (on `ID` field) |
| `redisCache` / `redisCache=pool` | Enable Redis entity cache (on `ID` field) |
| `localCache` / `localCache=size` | Enable local in-memory cache (on `ID` field) |
| `ttl=seconds` | Redis cache TTL in seconds (on `ID` field) |
| `redisSearch=pool` | Enable Redis Search indexing (on `ID` field) |
| `required` | NOT NULL in MySQL; for strings, prevents empty default |
| `unique=Name` | Declare a unique index column |
| `unique=Name:N` | Composite unique index with column position N |
| `cached` | Cache unique index lookups in Redis |
| `enum=a,b,c` | MySQL ENUM column with specified values |
| `enum` | Reference a shared enum defined in another entity (requires `enumName`) |
| `set=a,b,c` | MySQL SET column with specified values |
| `set` | Reference a shared set defined in another entity (requires `enumName`) |
| `enumName=TypeName` | Share a generated enum type across fields or entities |
| `time` | Map `time.Time` to `datetime` instead of `date` |
| `length=N` | Set varchar length (default 255) |
| `length=max` | Use `mediumtext` instead of varchar |
| `decimal=X,Y` | Use MySQL `decimal(X,Y)` for floats |
| `unsigned` | Unsigned float column |
| `mediumint` | Use MySQL `mediumint` for int32/uint32 |
| `searchable` | Include field in Redis Search index |
| `sortable` | Make field sortable in Redis Search |
| `ignore` | Do not store this field in MySQL |
