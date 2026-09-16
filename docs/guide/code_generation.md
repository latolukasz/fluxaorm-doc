# Code Generation

FluxaORM uses no reflection at runtime. You describe entities as plain Go structs (see [Entities](/guide/entities.html)), register them in a `Registry`, and run `fluxaorm.Generate()`. The generator emits one Go file per entity containing a typed **Provider** (loading, searching, factory and metadata methods) and a typed **Entity** (getters, setters, dirty tracking and the SQL it needs to persist itself), plus a shared `enums` package. This page is a reference for what is generated and how to call it.

## Running the generator

```go
func Generate(engine Engine, outputDirectory string) error
```

`Generate` needs a validated `Engine`. Use `registry.ValidateForCodeGen()` rather than `Validate()`: it builds the entity schemas without opening a single connection to MySQL, Redis or NATS, so the generator can run on a machine that has no access to the databases (a developer laptop, CI). Pools still have to be registered so that tags such as `orm:"mysql=logs"` or `orm:"redisCache"` can be resolved, but the addresses are never dialled.

Put the call in a small program and run it whenever an entity struct changes:

```go
// cmd/generate/main.go
package main

import (
    "os"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/model"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(model.CategoryEntity{}, model.UserEntity{})

    engine, err := registry.ValidateForCodeGen()
    if err != nil {
        panic(err)
    }
    if err = os.MkdirAll("entities", 0o755); err != nil {
        panic(err)
    }
    if err = fluxaorm.Generate(engine, "entities"); err != nil {
        panic(err)
    }
}
```

```bash
go run ./cmd/generate
```

What `Generate` does, in order:

1. Checks the output directory: it must be non-empty (`output directory is empty`), exist (`output directory does not exist: <path>`), be a directory and be writable.
2. Walks up from the output directory until it finds a `go.mod` and reads its `module` line. The import path of the generated `enums` package is `<module>/<relative path of the output dir>/enums`, so the output directory must live inside a Go module.
3. **Deletes every regular file in the output directory**, whatever its extension. Sub-directories (such as `enums/`) are kept, but the enum files inside are rewritten. Never put hand-written files in the output directory.
4. Writes one file per registered entity, then `providers.go`, then the consumer files when consumers or tasks are registered.
5. Runs every file through `go/format`.

The package name of the generated code is the base name of the output directory (`entities` in the example above). Commit the generated files together with the entity structs that produced them.

## Upgrading FluxaORM

Regenerate all entities after updating the ORM dependency, even when your model structs have not changed. The generator and runtime must agree on the entity persistence protocol.

The transaction save fix requires generated snapshot and rollback support, including `PrivateSnapshot`, `PrivateRollback` and `PrivateIsSnapshot`. Older generated entities can still compile, but `Save` returns `fluxaorm.ErrEntityNeedsRegeneration` rather than using an entity without this support. Run your generator with the updated dependency, then rebuild and test the application. `Save`, `Transaction` and the public setters keep their existing signatures.

The `GetByID` and `GetByIDs` allocation improvements are emitted into generated providers. Rerun your application generator with the updated ORM dependency to adopt them; changing the dependency alone does not rewrite existing providers. These optimizations preserve method signatures, cache behavior, and missing-row behavior, as well as input order and duplicate handling in `GetByIDs`. Newly generated readers require the updated ORM runtime for numeric scan adapters and Redis command batching; `database/sql` conversions, NULL handling, overflow errors, and the Redis row-cache format are preserved.

## Output layout

| File | Content |
|:-----|:--------|
| `<TableName>.go` | One file per entity. The file name is the table name verbatim: `UserEntity.go` for a struct `UserEntity`, `users.go` when the struct carries `orm:"table=users"`. |
| `providers.go` | `var AllProviders = []fluxaorm.EntityProvider{...}`, pointers to every provider sorted by table name. |
| `consumers.go`, `<consumer>_consumer.go` | Only when consumers or tasks are registered. See [Consumers](/guide/consumers.html) and [Tasks](/guide/tasks.html). |
| `enums/<EnumName>.go` | Package `enums`, one file per enum name (see [Enums](#enums)). |

## Naming rules

- The **table name** is the struct type name unless the `ID` field carries `orm:"table=..."`.
- The **entity type** is the table name with its first letter capitalised and underscores removed, capitalising each segment: `UserEntity` stays `UserEntity`, a table `user_accounts` becomes `UserAccounts`.
- The **provider variable** is `<Entity>Provider` (`UserEntityProvider`). Its type, the fields struct and the SQL row struct are unexported (`userEntityProvider`, `userEntityFields`, `userEntitySQLRow`).
- The **cache index** stored in the provider is the fully qualified Go type name of the source struct (`model.UserEntity`). It is assigned at validation time and used as the key of the [context cache](/guide/context_cache.html) and of the [lifecycle handlers](/guide/lifecycle_callbacks.html).

The examples on this and the following pages use these two structs, defined in a package `model` and generated into a package `entities`:

```go
package model

import (
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

type CategoryEntity struct {
    ID   uint64 `orm:"redisCache"`
    Code string `orm:"required;length=10"`
    Name string `orm:"required;length=100"`
}

func (e CategoryEntity) UniqueIndexes() [][]string {
    return [][]string{{"Code"}}
}

func (e CategoryEntity) CachedUniqueIndexes() [][]string {
    return [][]string{{"Code"}}
}

type UserEntity struct {
    ID        uint64 `orm:"redisCache"`
    Name      string `orm:"required;length=100"`
    Email     string `orm:"length=255"`
    Age       *uint8
    Status    string `orm:"enum=active,blocked;required;enumName=UserStatus"`
    Category  fluxaorm.Reference[CategoryEntity] `orm:"required"`
    CreatedAt time.Time
    UpdatedAt time.Time
}
```

## Anatomy of a generated file

The excerpt below is what `entities/UserEntity.go` looks like (the hex values are computed from the table and column names and differ for every entity; method bodies are omitted).

```go
// Code generated by fluxaorm; DO NOT EDIT.

package entities

type userEntityFields struct {
    ID        fluxaorm.UintField
    Category  fluxaorm.ReferenceField
    CreatedAt fluxaorm.TimeField
    UpdatedAt fluxaorm.TimeField
    Name      fluxaorm.StringField
    Email     fluxaorm.NullableStringField
    Age       fluxaorm.NullableUintField
    Status    fluxaorm.EnumField
}

type userEntityProvider struct {
    tableName        string
    dbCode           string
    redisCode        string
    cacheIndex       string
    redisCachePrefix string
    redisCacheStamp  string
    redisCacheTTL    int
    Fields           userEntityFields
}

var UserEntityProvider = userEntityProvider{
    tableName:        "UserEntity",
    dbCode:           "default",
    redisCode:        "default",
    cacheIndex:       "model.UserEntity",
    redisCachePrefix: "e11dd246:",
    redisCacheStamp:  "e69f360206e0533c",
    redisCacheTTL:    0,
    Fields: userEntityFields{
        ID:       fluxaorm.UintField{Column: "ID"},
        Category: fluxaorm.ReferenceField{Column: "Category"},
        // ...
    },
}

func (p userEntityProvider) TableName() string { return p.tableName }
func (p userEntityProvider) DBCode() string    { return p.dbCode }

func (p userEntityProvider) RedisCode() string        { return p.redisCode }
func (p userEntityProvider) RedisCachePrefix() string { return p.redisCachePrefix }
func (p userEntityProvider) ClearRedisCache(ctx fluxaorm.Context) (int, error)

type userEntitySQLRow struct {
    F0 uint64
    F1 uint64
    F2 time.Time
    F3 time.Time
    F4 string
    F5 sql.NullString
    F6 sql.NullInt64
    F7 string
}

func (p userEntityProvider) OnAfterInsert(engine fluxaorm.Engine, handler func(ctx fluxaorm.Context, entity *UserEntity) error)
func (p userEntityProvider) OnAfterUpdate(engine fluxaorm.Engine, handler func(ctx fluxaorm.Context, entity *UserEntity, changes map[string]any) error)
func (p userEntityProvider) OnAfterDelete(engine fluxaorm.Engine, handler func(ctx fluxaorm.Context, entity *UserEntity) error)

func RegisterUserEntityBeforeInsert(cb func(entity *UserEntity))
func RegisterUserEntityBeforeUpdate(cb func(entity *UserEntity))
func RegisterUserEntityBeforeDelete(cb func(entity *UserEntity))

func (p userEntityProvider) GetByID(ctx fluxaorm.Context, id uint64) (entity *UserEntity, found bool, err error)
func (p userEntityProvider) MustGetByID(ctx fluxaorm.Context, id uint64) (entity *UserEntity, err error)
func (p userEntityProvider) GetByIDs(ctx fluxaorm.Context, id ...uint64) ([]*UserEntity, error)
func (p userEntityProvider) New(ctx fluxaorm.Context) *UserEntity
func (p userEntityProvider) NewWithID(ctx fluxaorm.Context, id uint64) *UserEntity
func (p userEntityProvider) SearchOne(ctx fluxaorm.Context, query *fluxaorm.DBQuery) (*UserEntity, bool, error)
func (p userEntityProvider) SearchMany(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*UserEntity, error)
func (p userEntityProvider) SearchManyWithTotal(ctx fluxaorm.Context, query *fluxaorm.DBQuery) ([]*UserEntity, int, error)
func (p userEntityProvider) Count(ctx fluxaorm.Context, query *fluxaorm.DBQuery) (int, error)

type UserEntity struct {
    ctx                  fluxaorm.Context
    id                   uint64
    new                  bool
    deleted              bool
    removed              bool
    snapshot             bool
    originDatabaseValues *userEntitySQLRow
    databaseBind         map[string]any
    originRedisValues    []string
    flushType            uint8
    flushChanges         map[string]any
}

func (e *UserEntity) GetID() uint64

func (e *UserEntity) GetName() string
func (e *UserEntity) SetName(value string) *UserEntity
func (e *UserEntity) GetEmail() string
func (e *UserEntity) SetEmail(value string) *UserEntity
func (e *UserEntity) GetAge() *uint64
func (e *UserEntity) SetAge(value *uint64) *UserEntity
func (e *UserEntity) GetStatus() enums.UserStatus
func (e *UserEntity) SetStatus(value enums.UserStatus) *UserEntity
func (e *UserEntity) GetCategoryID() uint64
func (e *UserEntity) SetCategory(value uint64) *UserEntity
func (e *UserEntity) GetCategory(ctx fluxaorm.Context) (reference *CategoryEntity, found bool, err error)
func (e *UserEntity) MustGetCategory(ctx fluxaorm.Context) (reference *CategoryEntity, err error)
func (e *UserEntity) GetCreatedAt() time.Time
func (e *UserEntity) SetCreatedAt(value time.Time) *UserEntity
func (e *UserEntity) GetUpdatedAt() time.Time
func (e *UserEntity) SetUpdatedAt(value time.Time) *UserEntity
```

Methods whose name starts with `Private` (`PrivateFlush`, `PrivateFlushed`, `PrivateSnapshot`, `PrivateRollback`, `PrivateAdvance`, `PrivateIsSnapshot`, `PrivateIsDeleted`, `PrivateDatabasePool`, `PrivateReload`, `PrivateDelete`, `PrivateForceDelete` - only on `FakeDelete` entities, `PrivateFlushEvent`, `PrivateGetDatabaseBind`, `PrivateCacheIndex`, `PrivateIsNew`, `PrivateContext`) implement the `fluxaorm.Entity` interface or internal capabilities used by `ctx.Save`, `ctx.Delete`, `ctx.Reload` and transactions. They are exported only because the ORM lives in another package; never call them yourself.

## The Provider

### Field descriptors

`Provider.Fields` holds one typed descriptor per column. Descriptors build the conditions passed to `fluxaorm.NewQuery().Filter(...)` and the sort arguments of `SortByASC`/`SortByDESC`:

```go
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(
            entities.UserEntityProvider.Fields.Category.Eq(categoryID),
            entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active),
        ).
        SortByASC(entities.UserEntityProvider.Fields.Name).
        Pager(fluxaorm.NewPager(1, 20)),
)
```

| Go field | Descriptor |
|:---------|:-----------|
| `uint*` (including `ID`) | `fluxaorm.UintField` |
| `*uint*` | `fluxaorm.NullableUintField` |
| `int*` / `*int*` | `fluxaorm.IntField` / `fluxaorm.NullableIntField` |
| `float*` / `*float*` | `fluxaorm.FloatField` / `fluxaorm.NullableFloatField` |
| `bool` / `*bool` | `fluxaorm.BoolField` / `fluxaorm.NullableBoolField` |
| `time.Time` / `*time.Time` | `fluxaorm.TimeField` / `fluxaorm.NullableTimeField` |
| `string` with `required` | `fluxaorm.StringField` |
| `string` without `required` | `fluxaorm.NullableStringField` |
| `string` with `enum=` and `required` | `fluxaorm.EnumField` |
| `string` with `enum=` without `required` | `fluxaorm.NullableEnumField` |
| `fluxaorm.Reference[T]` with `required` | `fluxaorm.ReferenceField` |
| `fluxaorm.Reference[T]` without `required` | `fluxaorm.NullableUintField` |

`FakeDelete`, `[]uint8`, `set=` fields, `fluxaorm.References[T]` and JSON struct fields have **no** descriptor: they cannot be used in `Filter`. Fields of embedded or nested structs are flattened with the nested field name as prefix (`TestSubSize` for `TestSub.Size`), anonymous embedding adds no prefix. The available condition methods are documented in [Search](/guide/search.html).

### Metadata methods and interfaces

Every provider implements `fluxaorm.EntityProvider`:

```go
type EntityProvider interface {
    TableName() string
    DBCode() string
}
```

Entities with `orm:"redisCache"` **or** with `CachedUniqueIndexes()` additionally implement `fluxaorm.RedisCacheEntityProvider` (an entity that only caches unique index lookups still needs a way to clear those keys):

```go
type RedisCacheEntityProvider interface {
    RedisCode() string
    RedisCachePrefix() string
    ClearRedisCache(ctx Context) (int, error)
}
```

Entities with `searchable` fields implement `fluxaorm.RedisSearchEntityProvider`:

```go
type RedisSearchEntityProvider interface {
    ReindexRedisSearch(ctx Context) error
    RedisSearchCode() string
    RedisSearchIndexName() string
    RedisSearchHashPrefix() string
}
```

`providers.go` collects every provider so that tooling can iterate over them and pick the capabilities it needs:

```go
for _, provider := range entities.AllProviders {
    if cached, ok := provider.(fluxaorm.RedisCacheEntityProvider); ok {
        deleted, err := cached.ClearRedisCache(ctx)
        // ...
    }
}
```

### Loading, factory and search methods

| Method | Notes |
|:-------|:------|
| `GetByID(ctx, id) (*E, bool, error)` | Context cache, then Redis row cache, then MySQL. See [CRUD](/guide/crud.html). |
| `MustGetByID(ctx, id) (*E, error)` | Like `GetByID` but panics with `<Entity> with id <id> not found` when the row does not exist. |
| `GetByIDs(ctx, id ...uint64) ([]*E, error)` | Input order preserved, duplicates collapsed, missing ids skipped. |
| `New(ctx) *E` | New entity with a snowflake ID from `ctx.Engine().NextID()`; never fails. |
| `NewWithID(ctx, id) *E` | New entity with a caller-chosen ID. |
| `SearchOne(ctx, *DBQuery) (*E, bool, error)` | Uses the cached unique index fast path when the filter matches one exactly. |
| `SearchMany(ctx, *DBQuery) ([]*E, error)` | |
| `SearchManyWithTotal(ctx, *DBQuery) ([]*E, int, error)` | |
| `Count(ctx, *DBQuery) (int, error)` | |
| `SearchOneInRedis(ctx, *RedisSearchQuery) (*E, bool, error)` | Only with `searchable` fields. |
| `SearchManyInRedis(ctx, *RedisSearchQuery) ([]*E, error)` | Only with `searchable` fields. |
| `SearchManyInRedisWithTotal(ctx, *RedisSearchQuery) ([]*E, int, error)` | Only with `searchable` fields. |
| `ReindexRedisSearch(ctx) error` | Only with `searchable` fields. |

`GetByID`, `GetByIDs`, `New`, `NewWithID` are described in [CRUD](/guide/crud.html); the `Search*` and `Count` methods in [Search](/guide/search.html); the `*InRedis` methods and `ReindexRedisSearch` in [Redis Search](/guide/redis_search.html). There is no generated `Delete` on the provider and no `GetBy<Index>` methods: deleting goes through `ctx.Delete`, unique index lookups through `SearchOne`.

### Lifecycle registration

`OnAfterInsert`, `OnAfterUpdate` and `OnAfterDelete` register one post-commit handler per event on the `Engine`. The package-level `Register<Entity>BeforeInsert`, `Register<Entity>BeforeUpdate` and `Register<Entity>BeforeDelete` functions register synchronous callbacks that run before the SQL statement is built. Both families are documented in [Lifecycle Callbacks](/guide/lifecycle_callbacks.html).

## The Entity

An entity remembers the `Context` that created or loaded it, its ID, its latest loaded or successfully saved values (`originDatabaseValues` / `originRedisValues`) and the columns changed since (`databaseBind`). A successful `Save` advances that baseline immediately after SQL execution, even before a transaction commits. The ORM keeps separate snapshots for deferred events and rollback; see [Transactions](/guide/transactions.html). The entity can only be saved on its own context; see [CRUD](/guide/crud.html) for the write rules.

### Getters and setters

Every setter returns the entity, so calls chain:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetName("Alice").
    SetEmail("alice@example.com").
    SetStatus(enums.UserStatusList.Active).
    SetCategory(category.GetID())
```

| Go field | Getter | Setter |
|:---------|:-------|:-------|
| `uint*` | `Get<F>() uint64` | `Set<F>(value uint64)` |
| `int*` | `Get<F>() int64` | `Set<F>(value int64)` |
| `float*` | `Get<F>() float64` | `Set<F>(value float64)` |
| `bool` | `Get<F>() bool` | `Set<F>(value bool)` |
| `time.Time` | `Get<F>() time.Time` | `Set<F>(value time.Time)` — truncated to the second (`orm:"time"`) or to the day (date) |
| `string` with `required` | `Get<F>() string` | `Set<F>(value string)` |
| `string` without `required` | `Get<F>() string` — `""` for NULL | `Set<F>(value string)` — `""` stores NULL |
| `*uint*` | `Get<F>() *uint64` | `Set<F>(value *uint64)` — `nil` stores NULL |
| `*int*` | `Get<F>() *int64` | `Set<F>(value *int64)` |
| `*float*` | `Get<F>() *float64` | `Set<F>(value *float64)` |
| `*bool` | `Get<F>() *bool` | `Set<F>(value *bool)` |
| `*time.Time` | `Get<F>() *time.Time` | `Set<F>(value *time.Time)` |
| `[]uint8` | `Get<F>() []uint8` — `nil` for NULL | `Set<F>(value []uint8)` |
| enum with `required` | `Get<F>() enums.X` | `Set<F>(value enums.X)` |
| enum without `required` | `Get<F>() *enums.X` | `Set<F>(value *enums.X)` |
| set with `required` | `Get<F>() []enums.X` | `Set<F>(value ...enums.X)` — stored sorted, comma-joined |
| set without `required` | `Get<F>() []enums.X` — `nil` for NULL | `Set<F>(value ...enums.X)` — no arguments stores NULL |
| JSON struct `*pkg.T` | `Get<F>() *pkg.T` | `Set<F>(value *pkg.T)` — `nil` stores NULL |
| `fluxaorm.Reference[T]` | `Get<F>ID() uint64` (`0` for NULL), `Get<F>(ctx) (*T, bool, error)`, `MustGet<F>(ctx) (*T, error)` | `Set<F>(value uint64)` — `0` stores NULL on an optional reference |
| `fluxaorm.References[T]` | `Get<F>IDs() []uint64`, `Get<F>(ctx) ([]*T, error)` | `Set<F>IDs(ids []uint64)` — empty stores `[]`; `nil` stores NULL on an optional field |

Narrow Go integers widen in the API: a `uint32` column has `Get<F>() uint64`, a `*uint8` column has `Get<F>() *uint64`. The `ID` field has only `GetID()`.

Reference getters load lazily through the referenced provider: `Get<F>(ctx)` returns `nil, false, nil` when the ID is `0`, otherwise `<Ref>Provider.GetByID(ctx, id)`. `MustGet<F>(ctx)` panics with `<F> not found in <Entity>` when the referenced row is missing. `Get<F>(ctx)` on a `References[T]` field calls `<Ref>Provider.GetByIDs(ctx, ids...)`.

### Change events

Entities tagged `orm:"cdc"` also get a `<Entity>DirtyEvent` type (an alias of `fluxaorm.DirtyEvent[map[string]any]`) and the publisher registration that emits one event per committed write. See [Entity Events](/guide/entity_events.html).

## Enums

Every `enum=` or `set=` field produces a file in the `enums` package. The type name is the `enumName=` tag value; without it the generator derives one from the entity and field name. Several fields — in the same or in different entities — may share one enum by giving them the same `enumName`; a field may even reference an enum that is defined elsewhere with `orm:"enumName=UserStatus"` alone.

```go
// Code generated by fluxaorm; DO NOT EDIT.

package enums

type UserStatus string

var UserStatusList = struct {
    Active  UserStatus
    Blocked UserStatus
}{
    Active:  "active",
    Blocked: "blocked",
}

func (e UserStatus) Valid() bool {
    switch e {
    case "active", "blocked":
        return true
    }
    return false
}

func (e UserStatus) Values() []UserStatus {
    return []UserStatus{"active", "blocked"}
}
```

The constant names are the values with the first letter of every `_`-separated segment capitalised (`in_review` becomes `InReview`). A required enum or set field of a freshly created entity defaults to the first declared value, so `entities.UserEntityProvider.New(ctx).GetStatus()` is `enums.UserStatusList.Active`.
