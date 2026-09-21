---
description: "Soft delete in FluxaORM: add a FakeDelete bool field to hide rows from searches while keeping them loadable by ID."
---

# Fake Delete

Fake delete (soft delete) marks rows as deleted instead of removing them. Deleted rows disappear from searches but stay in the table and can still be loaded by id.

## Declaring it

Add a field named exactly `FakeDelete` of type `bool` to the entity. No tag or interface is needed:

```go
type UserEntity struct {
    ID         uint64 `orm:"redisCache"`
    Name       string `orm:"required;length=100"`
    Email      string `orm:"length=255"`
    FakeDelete bool
}
```

Although the Go field is a `bool`, the column is created with the same type as `ID` — `bigint unsigned NOT NULL DEFAULT '0'` — and a deleted row stores **its own ID** in it, `0` meaning alive. During [schema update](/guide/schema_update.html) FluxaORM also:

- appends `FakeDelete` as the last column to every index (unique or not) that does not already contain it;
- adds a standalone index on `FakeDelete` if none starts with it.

Storing the ID rather than `1` is what keeps extended unique indexes unique: two deleted users with the same e-mail are `(alice@example.com, 17)` and `(alice@example.com, 42)`, while the live one is `(alice@example.com, 0)`.

The generated entity has the normal `GetFakeDelete() bool` / `SetFakeDelete(value bool)` accessors. `FakeDelete` has no descriptor in `Provider.Fields`, so it cannot appear in `Filter(...)`; the query methods handle it for you.

## Deleting

```go
user, found, err := entities.UserEntityProvider.GetByID(ctx, 3)
if err != nil || !found {
    return err
}

err = ctx.Delete(user)      // UPDATE `UserEntity` SET `FakeDelete`=? WHERE `ID`=3   (FakeDelete = 3)
err = ctx.ForceDelete(user) // DELETE FROM `UserEntity` WHERE `ID` = ?
```

- `ctx.Delete` sets `FakeDelete` and saves: the statement is an `UPDATE`, but the write is reported as a **delete**. The `OnAfterDelete` handler fires (not `OnAfterUpdate`), the entity is evicted from the [context cache](/guide/context_cache.html), the Redis Search hash is removed and the cached unique index keys are invalidated. Because it is technically an update, the synchronous `Register<Entity>BeforeUpdate` callbacks run, not `BeforeDelete`; see [Lifecycle Callbacks](/guide/lifecycle_callbacks.html).
- `ctx.ForceDelete` removes the row with a real `DELETE`; `BeforeDelete` callbacks and `OnAfterDelete` fire.
- Both are immediate and transactional exactly like `ctx.Save`; see [CRUD](/guide/crud.html#deleting).

To restore a row, set the flag back and save — this is a regular update:

```go
user.SetFakeDelete(false)
err = ctx.Save(user)
```

## Reading deleted rows

`SearchOne`, `SearchMany`, `SearchManyWithTotal` and `Count` append `` `FakeDelete` = 0 `` to their `WHERE` clause, so deleted rows are excluded by default. `GetByID`, `MustGetByID` and `GetByIDs` do **not** filter: they return the row with `GetFakeDelete() == true`.

```go
user, found, err := entities.UserEntityProvider.GetByID(ctx, 3) // found == true after ctx.Delete
if user.GetFakeDelete() {
    fmt.Println("deleted")
}
```

To include deleted rows in a search, attach a raw where clause with `WithFakeDeletes()`. Only `FilterWhere` can switch the filter off — `Filter` conditions cannot:

```go
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Name.Like("A%")).
        FilterWhere(fluxaorm.NewWhere("1").WithFakeDeletes()).
        Pager(fluxaorm.NewPager(1, 100)),
)
```

### Redis Search

Fake-deleted rows are removed from the Redis Search hash when they are deleted, never written when inserted as deleted, and skipped by `ReindexRedisSearch`. `SearchOneInRedis`, `SearchManyInRedis` and `SearchManyInRedisWithTotal` therefore never return them, and `WithFakeDeletes()` has no effect on them. Restoring a row writes its hash again. See [Redis Search](/guide/redis_search.html).

### Cached unique indexes

The cached lookup in `SearchOne` (see [Redis Cache](/guide/redis_cache.html#cached-unique-indexes)) treats a deleted row as a miss: a cache hit is only accepted when the loaded row has `FakeDelete == 0`, and the SQL fallback adds `AND FakeDelete = 0`. Soft-deleting a row invalidates all of its cached unique keys.

## Example

```go
user := entities.UserEntityProvider.New(ctx)
user.SetName("Alice").SetEmail("alice@example.com")
err := ctx.Save(user)

err = ctx.Delete(user) // soft delete

// Excluded from searches...
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().Pager(fluxaorm.NewPager(1, 100)),
) // does not contain Alice

// ...unless asked for...
all, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().
        FilterWhere(fluxaorm.NewWhere("1").WithFakeDeletes()).
        Pager(fluxaorm.NewPager(1, 100)),
) // contains Alice

// ...but still loadable by id.
user, found, err := entities.UserEntityProvider.GetByID(ctx, user.GetID())
// found == true, user.GetFakeDelete() == true

err = ctx.ForceDelete(user) // the row is gone
```
