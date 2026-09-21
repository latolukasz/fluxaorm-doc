---
description: "Declaring MySQL indexes, unique indexes and Redis-cached unique indexes on FluxaORM entities, and how SearchOne uses them for fast lookups."
---

# MySQL Indexes

Indexes are declared by implementing small interfaces on the entity struct. FluxaORM creates and maintains them through [schema alters](/guide/schema_update.html), and the generated `SearchOne` uses unique indexes for fast, optionally Redis-cached, lookups.

```go
type EntityIndexes interface            { Indexes() [][]string }
type EntityUniqueIndexes interface      { UniqueIndexes() [][]string }
type EntityCachedUniqueIndexes interface{ CachedUniqueIndexes() [][]string }
```

Each inner slice is one index, listing its columns in order. The methods may use a value or a pointer receiver.

## Index Names

Names are not chosen by you: an index is named by joining its column names with `_`. `{"Name", "Age"}` becomes `Name_Age`, `{"Email"}` becomes `Email`. The same name is used in MySQL and in Redis keys.

## Unique Indexes

```go
type UserEntity struct {
    ID    uint64
    Name  string `orm:"required"`
    Age   uint8
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{
        {"Email"},
        {"Name", "Age"},
    }
}
```

This produces the following definitions in `CREATE TABLE` / `ALTER TABLE`:

```sql
UNIQUE INDEX `Email` (`Email`),
UNIQUE INDEX `Name_Age` (`Name`,`Age`)
```

### Looking up by a unique index

There is no dedicated `GetBy...` method. Use `SearchOne` with an equality condition per index column; the query is a normal `SELECT ... LIMIT 1` that MySQL answers from the unique index. See [Search](/guide/search.html) for the query API.

```go
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserEntityProvider.Fields.Name.Is("Alice"),
        entities.UserEntityProvider.Fields.Age.Eq(30),
    ),
)
```

## Non-Unique Indexes

```go
type UserEntity struct {
    ID   uint64
    Name string `orm:"required"`
    Age  uint32
}

func (e UserEntity) Indexes() [][]string {
    return [][]string{{"Age"}, {"Name", "Age"}}
}
```

```sql
INDEX `Age` (`Age`),
INDEX `Name_Age` (`Name`,`Age`)
```

## Cached Unique Indexes

A unique index listed in `CachedUniqueIndexes()` additionally caches the *values -> ID* mapping in Redis, so a `SearchOne` on those columns can skip MySQL. Every cached index must also be present in `UniqueIndexes()`.

```go
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Age   uint8
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{{"Name", "Age"}, {"Email"}}
}

func (e UserEntity) CachedUniqueIndexes() [][]string {
    return [][]string{{"Name", "Age"}, {"Email"}}
}
```

### How the lookup works

`SearchOne` inspects the query conditions. When **all** of them are equality conditions and their column set equals a cached unique index, it takes the cached path:

1. Inside a transaction (`ctx.InTransaction()`) the cache is bypassed and the query goes to MySQL.
2. Otherwise Redis is asked for the key `<prefix>u:<indexName>@<8 hex>:<16 hex>` (see below).
3. On a hit the entity is loaded with `GetByID` (which itself uses the row cache when `redisCache` is on). The loaded row is then **verified**: every looked-up value must equal the row's value and, for entities with `FakeDelete`, the row must not be soft-deleted. A stale hit falls through to step 4.
4. On a miss MySQL is queried with `SELECT ID ... WHERE <cols> = ? [AND FakeDelete = 0] LIMIT 1`, the key is set to the ID with the `EntityCacheTTL` (one hour) expiry, and the entity is loaded with `GetByID`.

```go
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.UserEntityProvider.Fields.Email.Is("alice@example.com")),
)
```

Any other query shape - extra conditions, `Like`, only a subset of the index columns - is executed as a regular SQL query.

### Cache keys

Keys live in the entity's Redis key space (the same prefix as the [row cache](/guide/redis_cache.html)) and are built from two exported helpers:

```go
fluxaorm.UniqueIndexKeySegment(indexName string, columns []string) string // "u:" + name + "@" + sha256(columns joined by ",")[:4 bytes as hex] + ":"
fluxaorm.UniqueIndexKeyHash(values ...any) string                        // sha256(values formatted with %v, joined by "\x00")[:8 bytes as hex]
```

The column list is folded into the segment so that changing an index's columns never resolves old keys. The value is the entity ID as a decimal string.

Because these keys share the entity's prefix, an entity with cached unique indexes claims that prefix even without `redisCache`, and takes part in the Redis key namespace check described in [Entities](/guide/entities.html).

### Invalidation

Writes never populate these keys; they only delete them, and the next `SearchOne` repopulates:

- INSERT deletes the keys for the new values;
- UPDATE that changes an indexed column deletes both the old and the new keys;
- `Delete` (including soft delete) and `ForceDelete` delete all keys of the row.

Deletion happens before the statement and again after commit, together with the row-cache key (see [Redis Cache](/guide/redis_cache.html)).

### Without `redisCache`

Cached unique indexes work on entities without the row cache: the *values -> ID* key still goes to Redis (the `redisCache` pool if set, otherwise `default`), and the row itself is read from MySQL. A Redis pool named `default` must therefore be registered for such an entity; `Validate()` does not check this.

```go
type ProductEntity struct {
    ID    uint64
    Code  string `orm:"required"`
    Value int32
}

func (e ProductEntity) UniqueIndexes() [][]string       { return [][]string{{"Code", "Value"}} }
func (e ProductEntity) CachedUniqueIndexes() [][]string { return [][]string{{"Code", "Value"}} }
```

## FakeDelete and Indexes

When an entity has a `FakeDelete bool` field, `FakeDelete` is appended as the last column of every index that does not already contain it, and a standalone index `FakeDelete` on `(FakeDelete)` is added unless an index already starts with that column. Because the column stores the row's own ID when soft-deleted (and `0` otherwise), unique indexes stay unique among deleted rows while still enforcing uniqueness among live rows. See [Fake Delete](/guide/fake_delete.html).

## Validation Rules

`Validate()` rejects the following:

| Rule | Error |
|------|-------|
| Two unique indexes with the same columns | `duplicate unique index name '<n>' in entity '<e>'` |
| Two plain indexes with the same columns | `duplicate index name '<n>' in entity '<e>'` |
| Cached index missing from `UniqueIndexes()` | `cached unique index '<n>' in entity '<e>' is not defined in UniqueIndexes()` |
| Unknown column | `unique index column '<c>' not found in entity '<e>'` / `index column '<c>' not found in entity '<e>'` |
| An index whose columns are a leading prefix of another index (across unique and plain) | `duplicated index <a> with <b> in <e>` |

The prefix rule means `{"Age"}` together with `{"Age", "Name"}` is rejected - MySQL would use the composite index for both. `{"Name", "Age"}` and `{"Age"}` are fine.

## Indexes and Schema Alters

`GetAlters` classifies index changes as follows (see [Schema Update](/guide/schema_update.html)):

| Change | Kind | Safety |
|--------|------|--------|
| New plain index | `add_index` | safe |
| New unique index | `add_unique_index` | destructive - applied mid-rollout it fails the old version's inserts, deferred it lets duplicates in |
| Same name, different columns or uniqueness | `rebuild_index` | destructive, one statement `DROP INDEX` + `ADD ...` |
| Index no longer declared (except `PRIMARY`) | `drop_index` | destructive |
| Plain index over a column that was itself added as NOT NULL without default | `add_index` | destructive |

Reference fields (`fluxaorm.Reference[T]`) do not get an index or a foreign key automatically; declare one in `Indexes()` if you filter by them.

## Complete Example

```go
package model

import "github.com/latolukasz/fluxaorm/v2"

type CategoryEntity struct {
    ID   uint64 `orm:"redisCache"`
    Name string `orm:"required"`
    Slug string `orm:"required"`
}

func (e CategoryEntity) UniqueIndexes() [][]string       { return [][]string{{"Name"}, {"Slug"}} }
func (e CategoryEntity) CachedUniqueIndexes() [][]string { return [][]string{{"Name"}, {"Slug"}} }

type UserEntity struct {
    ID      uint64 `orm:"redisCache"`
    Email   string `orm:"required"`
    Name    string `orm:"required"`
    Country string
    Age     uint32
}

func (e UserEntity) UniqueIndexes() [][]string       { return [][]string{{"Email"}, {"Name", "Country"}} }
func (e UserEntity) CachedUniqueIndexes() [][]string { return [][]string{{"Email"}} }
func (e UserEntity) Indexes() [][]string             { return [][]string{{"Age"}} }

type ProductEntity struct {
    ID       uint64
    SKU      string                             `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity] `orm:"required"`
    Slug     string                             `orm:"required"`
}

func (e ProductEntity) UniqueIndexes() [][]string { return [][]string{{"SKU"}, {"Category", "Slug"}} }
func (e ProductEntity) Indexes() [][]string       { return [][]string{{"Category"}} }
```

```go
// cached lookup: Redis first, MySQL on miss
cat, found, err := entities.CategoryEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(entities.CategoryEntityProvider.Fields.Slug.Is("electronics")),
)

// unique but not cached: plain SQL using the Name_Country index
user, found, err := entities.UserEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.UserEntityProvider.Fields.Name.Is("Alice"),
        entities.UserEntityProvider.Fields.Country.Is("US"),
    ),
)

// composite unique index with a reference column
product, found, err := entities.ProductEntityProvider.SearchOne(ctx,
    fluxaorm.NewQuery().Filter(
        entities.ProductEntityProvider.Fields.Category.Eq(cat.GetID()),
        entities.ProductEntityProvider.Fields.Slug.Is("wireless-mouse"),
    ),
)
```
