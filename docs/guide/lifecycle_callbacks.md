---
description: "FluxaORM lifecycle hooks: synchronous Before insert/update/delete callbacks and post-commit After handlers with change snapshots."
---

# Lifecycle Callbacks

FluxaORM offers two kinds of hooks around entity writes. **Before** callbacks run synchronously while the SQL statement is being prepared and may still change the entity. **After** handlers run once the rows are durable and are meant for side effects. Both are triggered by `ctx.Save`, `ctx.Delete` and `ctx.ForceDelete`.

## Before callbacks

For every entity the generator emits three package-level registration functions:

```go
func RegisterUserEntityBeforeInsert(cb func(entity *UserEntity))
func RegisterUserEntityBeforeUpdate(cb func(entity *UserEntity))
func RegisterUserEntityBeforeDelete(cb func(entity *UserEntity))
```

Callbacks are appended to a package-level list and called in registration order at the very start of the entity's `INSERT`, `UPDATE` or `DELETE` branch, before the statement is built. Anything a callback sets through the entity's setters lands in that same statement. They cannot return an error and cannot veto the write — panic if you must abort.

```go
func init() {
    entities.RegisterUserEntityBeforeInsert(func(user *entities.UserEntity) {
        user.SetEmail(strings.ToLower(user.GetEmail()))
    })
    entities.RegisterUserEntityBeforeUpdate(func(user *entities.UserEntity) {
        user.SetEmail(strings.ToLower(user.GetEmail()))
    })
}
```

Because the lists are package globals, register Before callbacks once (an `init` function is the natural place), not per `Engine` or per request.

Which callback fires:

| Write | Callback |
|:------|:---------|
| `ctx.Save` of a new entity | `BeforeInsert` |
| `ctx.Save` of an entity with changes | `BeforeUpdate` |
| `ctx.ForceDelete`, or `ctx.Delete` on an entity without `FakeDelete` | `BeforeDelete` |
| `ctx.Delete` on a [fake-delete](/guide/fake_delete.html) entity | `BeforeUpdate` — the statement is an `UPDATE` |

## After handlers

After handlers are registered through the provider on the `Engine` and receive the concrete entity type:

```go
engine, err := registry.Validate()

entities.UserEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, user *entities.UserEntity) error {
    log.Printf("user %d created: %s", user.GetID(), user.GetName())
    return nil
})

entities.UserEntityProvider.OnAfterUpdate(engine, func(ctx fluxaorm.Context, user *entities.UserEntity, changes map[string]any) error {
    for column, oldValue := range changes {
        log.Printf("user %d: %s changed from %v", user.GetID(), column, oldValue)
    }
    return nil
})

entities.UserEntityProvider.OnAfterDelete(engine, func(ctx fluxaorm.Context, user *entities.UserEntity) error {
    log.Printf("user %d deleted", user.GetID())
    return nil
})
```

The provider methods are thin typed wrappers over the engine-level functions, which you can call directly when writing generic code:

```go
func RegisterAfterInsertHandler(engine Engine, cacheIndex string, handler func(Context, Entity) error)
func RegisterAfterUpdateHandler(engine Engine, cacheIndex string, handler func(Context, Entity, map[string]any) error)
func RegisterAfterDeleteHandler(engine Engine, cacheIndex string, handler func(Context, Entity) error)
```

`cacheIndex` is the entity's fully qualified type name (`model.UserEntity`), the same value the provider stores.

### When they run

After handlers are part of the post-commit phase of `Save` (see [Transactions](/guide/transactions.html#post-commit-work-and-postcommiterror)). Outside a transaction that is right after the statement executed; inside one it is right after `COMMIT`, for every write performed in that transaction. Within the phase the order is: evict handles that remain deleted from the context cache, second cache invalidation, Redis pipelines (search hashes), [entity events](/guide/entity_events.html), then **After handlers**. The live entity's saved baseline is advanced after SQL execution, before this phase. Consequences:

- The rows are durable when a handler runs. A handler never sees a write that will be rolled back.
- The handler receives a separate snapshot of the entity for that write, not the live pointer held by the caller or context cache. Its getters return the values captured by that `Save`, even if the live entity was saved again or edited later.
- For updates, the `changes` map holds the **old** value of every changed column, keyed by column name, relative to the preceding load or successful save. `CreatedAt`, `UpdatedAt` and `FakeDelete` are never in `changes`. Values are plain `uint64`, `int64`, `float64`, `bool`, `string`, `time.Time`, or `nil` for NULL — never pointers.
- `ctx` is the very `Context` that performed the write, with its context cache and, at this point, no open transaction.

For example, saving a new entity with `Name="first"` and then saving `Name="second"` in the same transaction invokes `OnAfterInsert` with `"first"`, then `OnAfterUpdate` with `"second"` and `changes["Name"] == "first"`. Saving it again unchanged invokes no handler.

### Which handler fires

| Write | Handler |
|:------|:--------|
| `ctx.Save` of a new entity | `OnAfterInsert` |
| `ctx.Save` of an entity with changes | `OnAfterUpdate` |
| `ctx.Delete`, `ctx.ForceDelete` — including a fake delete, which is an `UPDATE` in SQL | `OnAfterDelete` |

### One handler per event

The engine keeps one handler per event per entity type; registering again replaces the previous one. Fan out inside your handler if several parties need the event. When no handler is registered for any entity the post-commit phase skips this step entirely.

### Errors

A handler error is returned by `Save`, `Delete`, `ForceDelete` or `Transaction` wrapped in `*fluxaorm.PostCommitError`, because the rows are already committed. Remaining handlers of that write are not run. `errors.Is` still matches the original error through the wrapper:

```go
var ErrNotify = errors.New("notification failed")

entities.UserEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, user *entities.UserEntity) error {
    if err := notify(user); err != nil {
        return fmt.Errorf("%w: %v", ErrNotify, err)
    }
    return nil
})

err := ctx.Save(user)
var postCommit *fluxaorm.PostCommitError
if errors.As(err, &postCommit) {
    // the user row is committed; errors.Is(err, ErrNotify) == true
}
```

### Writing from a handler

Handlers may use `ctx` to read and to save **other** entities — there is no lock held while they run, and their `Save` is a normal, immediate write:

```go
entities.UserEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, user *entities.UserEntity) error {
    audit := entities.AuditLogEntityProvider.New(ctx)
    audit.SetAction("user_created").SetEntityID(user.GetID())
    return ctx.Save(audit)
})
```

Treat the supplied snapshot as read-only event data: `Save`, `Delete`, `ForceDelete` and `Reload` reject it with `fluxaorm.ErrEntityReadOnly`. Setters only change that detached snapshot locally. Reference getters still work through its context. If you need to modify the same row, obtain its live entity through the provider on `ctx` and save that handle. A write from a handler can trigger another handler, so avoid recursive updates of the same row. Keep handlers short and fail-safe; for work that must survive a crash between commit and handler, use [entity events](/guide/entity_events.html) with the [outbox](/guide/outbox.html) instead of a handler.

## Full example

```go
package main

import (
    "context"
    "fmt"
    "strings"

    "github.com/latolukasz/fluxaorm/v2"

    "myapp/entities"
    "myapp/model"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(model.CategoryEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    entities.RegisterCategoryEntityBeforeInsert(func(cat *entities.CategoryEntity) {
        cat.SetCode(strings.ToLower(cat.GetCode()))
    })

    entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, cat *entities.CategoryEntity) error {
        fmt.Printf("INSERT: category %d %q\n", cat.GetID(), cat.GetName())
        return nil
    })
    entities.CategoryEntityProvider.OnAfterUpdate(engine, func(ctx fluxaorm.Context, cat *entities.CategoryEntity, changes map[string]any) error {
        fmt.Printf("UPDATE: category %d, old values %v\n", cat.GetID(), changes)
        return nil
    })
    entities.CategoryEntityProvider.OnAfterDelete(engine, func(ctx fluxaorm.Context, cat *entities.CategoryEntity) error {
        fmt.Printf("DELETE: category %d\n", cat.GetID())
        return nil
    })

    ctx := engine.NewContext(context.Background())

    cat := entities.CategoryEntityProvider.New(ctx)
    cat.SetCode("BOOKS").SetName("Books")
    _ = ctx.Save(cat)   // BeforeInsert lower-cases the code; prints INSERT: category ... "Books"

    cat.SetName("Books & Comics")
    _ = ctx.Save(cat)   // prints UPDATE: category ..., old values map[Name:Books]

    _ = ctx.Delete(cat) // prints DELETE: category ...
}
```
