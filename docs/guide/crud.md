---
description: "Creating, loading, updating, deleting and reloading FluxaORM entities: New, Save, GetByID, GetByIDs, Delete, ForceDelete and the persistence contract."
---

# CRUD Operations

All reads and writes go through the generated code described in [Code Generation](/guide/code_generation.html): the provider loads and creates entities, the entity records what you change, and the `Context` persists it. There is no unit-of-work to flush at the end of a request — `ctx.Save` writes exactly the entities you pass and nothing else.

The examples use the `model.CategoryEntity` / `model.UserEntity` structs from the code generation page, generated into a package `entities`, with the `enums` package next to it:

```go
import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
    "myapp/entities/enums"
)

ctx := engine.NewContext(context.Background())
```

## Creating entities

`Provider.New(ctx)` returns a new entity with its ID already assigned:

```go
category := entities.CategoryEntityProvider.New(ctx)
category.SetCode("books").SetName("Books")

user := entities.UserEntityProvider.New(ctx)
user.SetName("Alice").
    SetEmail("alice@example.com").
    SetStatus(enums.UserStatusList.Active).
    SetCategory(category.GetID())

err := ctx.Save(category, user)
```

- The ID comes from `ctx.Engine().NextID()`, an in-process snowflake generator (41 bits of milliseconds since 2024-01-01, 11 bits of node, 11 bits of sequence). It needs neither Redis nor MySQL and never fails, which is why `New` returns only `*Entity`. Because the ID exists before the INSERT, you can reference a new entity from another one (`SetCategory(category.GetID())`) and save both in one call. When several processes create rows of the same table, give each one a distinct node with `engine.SetNodeID(node int64)`; see [Engine](/guide/engine.html).
- The new entity is put into the [context cache](/guide/context_cache.html) immediately, so `GetByID` on the same context returns the same pointer even before it is saved.
- Required `enum` and `set` fields start with their first declared value; everything else starts as the Go zero value (NULL for nullable columns).
- Nothing is written until `ctx.Save`.

`Provider.NewWithID(ctx, id)` does the same with an ID you choose.

## Setters and dirty tracking

Setters return the entity, so calls chain. Before the first successful `Save`, a setter on a new entity simply writes the value. After loading or saving an entity, setters compare against the most recently loaded or saved values: setting a column back to that value removes its pending change; a different value is recorded in the entity's change set. Only recorded columns end up in the `UPDATE` statement. This baseline advances after each successful `Save`, including inside a transaction before `COMMIT`.

```go
user, found, err := entities.UserEntityProvider.GetByID(ctx, id)
originalName := user.GetName()
user.SetName("Alice")          // no-op if Name already is "Alice"
user.SetEmail("")              // nullable string: "" stores NULL
user.SetName(originalName)     // undoes the pending Name change
```

Floats are compared after rounding to the column's precision, times are truncated to the second (`orm:"time"`) or to the day (date columns) before comparison and storage. There is no validation of `required` fields on save: `required` only decides whether a column is `NOT NULL`; saving a required string as `""` is allowed.

## Saving

```go
Save(entities ...Entity) error
```

`Save` writes the entities you pass, in the order you pass them. A clean entity (no changes, not new, not deleted) generates no SQL of its own, duplicates of the same pointer are collapsed, and `nil` entries are skipped. Passing a single entity executes its statement directly; passing **more than one** wraps the write in a [transaction](/guide/transactions.html) automatically, so entities that belong together commit together. Inside an explicit `ctx.Transaction` every `Save` joins that transaction. Any database pipelines already queued on the context still execute, even when the entity is unchanged; see [Pipelines and Save](/guide/mysql_queries.html#pipelines-and-save).

What happens, in order:

1. For each entity the generated code runs the `Before*` [callbacks](/guide/lifecycle_callbacks.html), builds its `INSERT`, `UPDATE` or `DELETE` into the database pipeline of its pool, registers the Redis keys the write makes stale and queues Redis Search hash writes. `CreatedAt` and `UpdatedAt` are set to `time.Now().UTC().Truncate(time.Second)` on insert (only when still zero, so a value you set yourself is kept), and `UpdatedAt` is refreshed on every update.
2. The registered Redis keys are deleted (see [Redis Cache](/guide/redis_cache.html)).
3. The SQL statements run — through the open transaction when there is one, otherwise directly on the pool. After successful execution, each entity folds the values just written into its saved baseline and clears those pending changes. An inserted entity is now eligible for `UPDATE`, including before `COMMIT`. Each write keeps a separate snapshot for its deferred events and handlers.
4. Post-commit work runs once the rows are durable: entities that remain deleted leave the context cache, the same Redis keys are deleted a second time, Redis pipelines (search hashes) execute, [entity events](/guide/entity_events.html) are published, and `After*` handlers run. Inside a transaction this step is deferred until `COMMIT`.

The same live pointer now tracks changes against the values just written: keep using it, change it, save it again. An inserted entity is no longer new. Inside a transaction, another `Save` writes any changes made since the previous one; without new changes it emits no entity statement. `COMMIT` does not save or clear edits made after the last `Save`. See [Saving the same entity again](/guide/transactions.html#saving-the-same-entity-again) for an example and rollback behaviour.

```go
user.SetName("Alice Smith")
err = ctx.Save(user) // UPDATE `UserEntity` SET `Name`=?,`UpdatedAt`=? WHERE `ID`=<id>
```

Errors you can get from `Save`:

- the SQL error of the failing statement (rows not written; inside a transaction the transaction is rolled back);
- `entity <type> <id> belongs to a different context; save it on the context that created or loaded it` — an entity can only be saved on the `Context` that created or loaded it;
- `*fluxaorm.PostCommitError` — a step of the post-commit phase failed **after** the rows were committed. The entity's saved baseline already reflects the SQL write; a later `Save` cannot replay the failed side effect. See [Transactions](/guide/transactions.html).
- `fluxaorm.ErrEntityReadOnly` when passing an [After-handler snapshot](/guide/lifecycle_callbacks.html#when-they-run) instead of a live entity.
- `fluxaorm.ErrEntityNeedsRegeneration` when the generated entities lack the snapshot support required by this ORM version. Regenerate them with the updated dependency; see [Code Generation](/guide/code_generation.html#upgrading-fluxaorm).

There is no API to discard pending changes: drop the handle, or `ctx.Reload` it (which refuses while changes are pending, see below).

## Reading

### GetByID

```go
user, found, err := entities.UserEntityProvider.GetByID(ctx, 12345)
if err != nil {
    return err
}
if !found {
    return errors.New("user does not exist")
}
fmt.Println(user.GetName())
```

`GetByID` consults, in this order:

1. the [context cache](/guide/context_cache.html) of `ctx` — a hit returns the very pointer you already hold;
2. the [Redis row cache](/guide/redis_cache.html), when the entity has `orm:"redisCache"` and `ctx` is **not** inside a transaction — a negative entry (row known to be missing) returns `found == false` without touching MySQL;
3. MySQL: one `SELECT <all columns> FROM <table> WHERE ID = <id> LIMIT 1` through `ctx.DB(pool)`, so inside a transaction the read sees that transaction's writes. Generated readers use the decimal `uint64` ID directly; schemas containing MySQL `FLOAT` columns keep the `ID = ?` parameter to preserve floating-point decoding. The result (or a negative entry) is written to the Redis row cache and the entity is put in the context cache.

`GetByID` returns [fake-deleted](/guide/fake_delete.html) rows. Regenerate your providers with the updated ORM dependency to adopt its allocation improvements; see [Upgrading FluxaORM](/guide/code_generation.html#upgrading-fluxaorm).

#### Measuring allocations for one entity

`BenchmarkGetByID1` measures one existing entity using the same fully populated, 27-column fixtures and [service setup](#measuring-allocations-for-10-entities) as `BenchmarkGetByIDs10`. Its cases are `ContextCacheHit` (warm context cache), `RedisCacheHit` (context cache disabled, one `LRANGE`), and `MySQL` (context cache disabled, fixture without Redis caching). With the same generated providers and `FLUXAORM_BENCH_*` environment variables, run from the ORM repository:

```bash
go test -run '^$' -bench '^BenchmarkGetByID1$' -benchmem -count=5 ./test_generate
```

Here, `B/op` and `allocs/op` describe fetching **one entity**. The shared setup seeds 10 rows, but each measured call fetches only the first ID. Setup, context creation, warmup, getters, logging, and correctness checks are outside the measurement.

### MustGetByID

```go
user, err := entities.UserEntityProvider.MustGetByID(ctx, 12345)
```

Same as `GetByID` without the `found` flag: a missing row **panics** with `UserEntity with id 12345 not found`. Errors are still returned. Use it where a missing row is a programming error, not user input.

### GetByIDs

```go
users, err := entities.UserEntityProvider.GetByIDs(ctx, 3, 1, 2, 1)
```

Returns the found entities in the order of the (de-duplicated) input, silently skipping ids that do not exist — the result may be shorter than the input. Ids already in the context cache are served from it; the rest are looked up in the Redis row cache with one pipelined round trip (outside transactions), and whatever is still missing is loaded with a single `SELECT ... WHERE ID IN (...)`. Every loaded row is written to both caches; ids that turn out not to exist get a negative cache entry.

Regenerate your providers with the updated ORM dependency to pick up the `GetByIDs` allocation improvements; see [Upgrading FluxaORM](/guide/code_generation.html#upgrading-fluxaorm).

#### Measuring allocations for 10 entities

The ORM repository includes `BenchmarkGetByIDs10` in `test_generate`. It fetches the same 10 existing, unique IDs per operation using the generated `generateEntity` fixture and its matching `generateEntityNoRedis` fixture for MySQL.

| Sub-benchmark | Read path |
| --- | --- |
| `ContextCacheHit` | All 10 entities are already in the context cache. |
| `RedisCacheHit` | The Redis row cache is warm and `DisableContextCache` is enabled. |
| `MySQL` | `DisableContextCache` is enabled and the fixture has no `redisCache` tag, so every call loads the rows from MySQL. |

First generate the ignored `test_generate/entities` providers from the ORM repository with `go run ./test_generate/genboot`. This helper requires MySQL, Redis, and NATS and applies fixture schema changes. Configure the addresses in `test_generate/genboot/main.go` for disposable test services; they are separate from the benchmark environment variables below.

Run the benchmark from the ORM repository with dedicated MySQL and Redis test databases. The setup creates missing fixture tables and removes its inserted rows and row-cache entries after the run; created tables remain. An incompatible existing fixture schema causes a failure. Set `FLUXAORM_BENCH_MYSQL_DSN` and `FLUXAORM_BENCH_REDIS_ADDR` to your test services; without both, the benchmark is skipped. `FLUXAORM_BENCH_REDIS_DB` defaults to `0`:

```bash
FLUXAORM_BENCH_MYSQL_DSN='root:root@tcp(localhost:13397)/test' \
FLUXAORM_BENCH_REDIS_ADDR='localhost:16395' \
FLUXAORM_BENCH_REDIS_DB=0 \
go test -run '^$' -bench '^BenchmarkGetByIDs10$' -benchmem -count=5 ./test_generate
```

`B/op` is the number of allocated bytes and `allocs/op` is the number of heap allocations for the **whole batch of 10 entities**. Context creation, table setup, seeding, correctness checks, and cache warmup are outside the measurement. The benchmark measures `GetByIDs` itself; it does not include decoding deferred until field getters are called. Results depend on the fixture's fields and payload, the read path, and the Go version.

### Searching

`SearchOne`, `SearchMany`, `SearchManyWithTotal` and `Count` take a `*fluxaorm.DBQuery` built from the provider's `Fields` descriptors. They select ids only and then hydrate through `GetByIDs`, so search results also come from and go into the context cache. They are documented in [Search](/guide/search.html); full-text and numeric search in Redis in [Redis Search](/guide/redis_search.html).

```go
users, total, err := entities.UserEntityProvider.SearchManyWithTotal(ctx,
    fluxaorm.NewQuery().
        Filter(entities.UserEntityProvider.Fields.Status.Is(enums.UserStatusList.Active)).
        SortByASC(entities.UserEntityProvider.Fields.Name).
        Pager(fluxaorm.NewPager(1, 20)),
)
```

## Updating

Load, change, save. Every entity returned by `GetByID`, `GetByIDs` or a `Search*` method can be saved on the context it came from:

```go
users, err := entities.UserEntityProvider.SearchMany(ctx,
    fluxaorm.NewQuery().Filter(entities.UserEntityProvider.Fields.Category.Eq(oldCategoryID)),
)
if err != nil {
    return err
}
saveList := make([]fluxaorm.Entity, len(users))
for i, user := range users {
    user.SetCategory(newCategoryID)
    saveList[i] = user
}
err = ctx.Save(saveList...) // one transaction, one UPDATE per changed user
```

The generated `UPDATE` lists only the changed columns and addresses the row by its literal id: ``UPDATE `UserEntity` SET `Category`=?,`UpdatedAt`=? WHERE `ID`=12345``.

## Deleting

```go
Delete(entities ...Entity) error
ForceDelete(entities ...Entity) error
```

Both write immediately (they call `Save` internally, so several entities are deleted in one transaction and the same post-commit steps run):

```go
user, found, err := entities.UserEntityProvider.GetByID(ctx, 12345)
if err != nil || !found {
    return err
}
err = ctx.Delete(user) // DELETE FROM `UserEntity` WHERE `ID` = ?
```

- `Delete` honours [fake delete](/guide/fake_delete.html): on an entity with a `FakeDelete` field it issues an `UPDATE` that marks the row deleted instead of removing it.
- `ForceDelete` always removes the row. On an entity without `FakeDelete` it behaves exactly like `Delete`.
- Deleting an entity that was never saved fails with `ErrEntityNotPersisted` (`entity was never persisted: *entities.UserEntity 12345`). After a successful `Save` inside a transaction, that newly inserted entity can be deleted in the same transaction.
- All arguments are validated before any of them is marked for deletion. An entity is rejected when it is new (`ErrEntityNotPersisted`), is an [After-handler snapshot](/guide/lifecycle_callbacks.html#when-they-run) (`ErrEntityReadOnly`), needs regeneration (`ErrEntityNeedsRegeneration`), belongs to a `Context` other than the one that created or loaded it, or was generated without delete support. Whichever argument it is, the call returns that error and **no** entity of the batch is modified: nothing is written and none of them stays marked for deletion, so a later `Save` on any of them does not delete its row.
- After commit, a handle that remains deleted is removed from the context cache before events and handlers run, so a later `GetByID` goes to the database (and, for a hard delete, returns not found). A queued delete does not evict a later restored entity or a replacement handle. Saving the deleted entity again does not re-issue the `DELETE`.

## Reloading

```go
Reload(entities ...Entity) error
```

`Reload` re-reads each entity from MySQL **in place**: the pointer does not change, so every holder of that entity — including the context cache — sees the fresh row. It always reads MySQL (never the Redis row cache) through `ctx.DB(pool)`, so inside a transaction it sees the transaction's own writes. A reloaded entity is clean, and setters afterwards compare against the new values. A new entity can be reloaded after its first successful `Save` in the same transaction, provided it has no pending changes.

```go
if err := ctx.Reload(user); err != nil {
    switch {
    case errors.Is(err, fluxaorm.ErrEntityUnsavedChanges):
        // save or drop the pending changes first
    case errors.Is(err, fluxaorm.ErrEntityVanished):
        // the row was deleted by someone else
    default:
        return err
    }
}
```

Entities are processed in order and the first failure stops the loop. The three state errors below are wrapped as `reload entity <id>: <cause>`; a MySQL error from the `SELECT` itself is returned unwrapped. A read-only handler snapshot is rejected directly with `ErrEntityReadOnly`, before any query runs:

| Error | Meaning |
|:------|:--------|
| `ErrEntityNotPersisted` | The entity is new; there is no row to read. |
| `ErrEntityUnsavedChanges` | The entity has pending setter changes. Reloading would silently discard them, so it is refused before any query runs. |
| `ErrEntityVanished` | The row no longer exists in MySQL. |
| `ErrEntityReadOnly` | The argument is an After-handler snapshot; reload the live entity from its provider instead. |

## Error reference

| Variable | Text | Returned by |
|:---------|:-----|:------------|
| `fluxaorm.ErrEntityNotPersisted` | `entity was never persisted` | `Delete`, `ForceDelete`, `Reload` |
| `fluxaorm.ErrEntityUnsavedChanges` | `entity has unsaved changes` | `Reload` |
| `fluxaorm.ErrEntityVanished` | `entity row no longer exists` | `Reload` |
| `fluxaorm.ErrEntityNeedsRegeneration` | `generated entity needs regeneration with fluxaorm.Generate to support transactional write snapshots` | `Save`, `Delete`, `ForceDelete` |
| `fluxaorm.ErrEntityReadOnly` | `entity is a read-only write snapshot` | `Save`, `Delete`, `ForceDelete`, `Reload` |
| `fluxaorm.ErrTxRollbackOnly` | `transaction is rollback-only` | `Transaction` (see [Transactions](/guide/transactions.html)) |
| `*fluxaorm.PostCommitError` | `post-commit failure (database changes are committed): <cause>` | `Save`, `Delete`, `ForceDelete`, `Transaction` |

All of them are matched with `errors.Is` / `errors.As` through the wrapping.

::: tip One context per unit of work
An entity belongs to the `Context` that created or loaded it and can only be saved there. Create a `Context` per request or job, and use `ctx.Clone()` when you need an independent unit of work with its own [context cache](/guide/context_cache.html); see [Context](/guide/context.html).
:::
