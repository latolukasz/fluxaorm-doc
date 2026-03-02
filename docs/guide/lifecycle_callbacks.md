# Entity Lifecycle Callbacks

FluxaORM supports registering callback functions that execute after successful INSERT, UPDATE, or DELETE operations. Callbacks fire after both the MySQL write and the Redis cache update have completed, inside `Flush()` only.

## Registering Callbacks

Callbacks are registered on the generated Provider singletons after calling `registry.Validate()`. Each registration method is type-safe -- the callback receives the concrete entity type, not a generic interface.

### AfterInsert

Register a callback that fires after a new entity is successfully inserted:

```go
engine, _ := registry.Validate()

entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    // entity has all saved values including auto-set timestamps
    fmt.Printf("Category %d created: %s\n", entity.GetID(), entity.GetName())
    return nil
})
```

The entity passed to the callback reflects the fully persisted state, including any auto-set fields such as `CreatedAt` and `UpdatedAt`.

### AfterUpdate

Register a callback that fires after an existing entity is successfully updated:

```go
entities.CategoryEntityProvider.OnAfterUpdate(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity, changes map[string]any) error {
    // entity getters return NEW values
    // changes["FieldName"] contains the OLD value for each changed field
    for field, oldValue := range changes {
        fmt.Printf("Field %s changed from %v to current value\n", field, oldValue)
    }
    return nil
})
```

The `entity` parameter reflects the new (post-update) state. The `changes` map contains only the fields that were modified, where each key is the field name (e.g., `"Name"`, `"Price"`) and each value is the **old** value before the update.

The values in the `changes` map are simple Go types:

| Type | Description |
|:-----|:------------|
| `string` | String fields |
| `uint64` | Unsigned integer fields |
| `int64` | Signed integer fields |
| `float64` | Float fields |
| `bool` | Boolean fields |
| `time.Time` | Time and date fields |
| `nil` | NULL values |

There are no pointer types in the `changes` map -- NULL values are represented as `nil`.

Auto-set timestamp fields (`CreatedAt` and `UpdatedAt`) are excluded from the `changes` map.

### AfterDelete

Register a callback that fires after an entity is successfully deleted:

```go
entities.CategoryEntityProvider.OnAfterDelete(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    // entity as it was before deletion
    fmt.Printf("Category %d deleted: %s\n", entity.GetID(), entity.GetName())
    return nil
})
```

The entity passed to the callback represents the state of the entity as it was before deletion.

### Error Propagation

All callback functions return an `error`. If a callback returns a non-nil error, it is propagated back through `Flush()` to the caller. Note that by the time callbacks execute, the database write and Redis cache update have already completed successfully -- the error only affects the return value of `Flush()`.

```go
entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    err := publishEvent("category_created", entity.GetID())
    if err != nil {
        return fmt.Errorf("failed to publish event: %w", err)
    }
    return nil
})

// Later...
err := ctx.Flush()
if err != nil {
    // Could be a DB error, Redis error, or a callback error
    log.Error(err)
}
```

## Key Behavior

### One Callback Per Event Type

Only one callback can be registered per event type per entity type. Re-registering a callback for the same event type overwrites the previous one:

```go
// This callback is overwritten by the one below
entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    fmt.Println("first handler")
    return nil
})

// This callback replaces the one above
entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    fmt.Println("second handler") // only this one fires
    return nil
})
```

### FakeDelete Triggers AfterDelete

When an entity has [Fake Delete](/guide/fake_delete) enabled, calling `entity.Delete()` (soft delete) triggers the `AfterDelete` callback, **not** `AfterUpdate`. This is true even though the underlying SQL operation is an UPDATE statement. Similarly, `entity.ForceDelete()` also triggers `AfterDelete`.

### FlushAsync Fires Callbacks in the Consumer

`ctx.FlushAsync(true)` and `ctx.FlushAsync(false)` do **not** fire lifecycle callbacks at the time they are called. Instead, callbacks are fired later by the `AsyncSQLConsumer` after the SQL has been executed against MySQL. This means callbacks always run after the database write has completed, whether synchronously via `Flush()` or asynchronously via `FlushAsync(true)` / `FlushAsync(false)` + consumer.

When `FlushAsync(true)` or `FlushAsync(false)` is used, the entity event metadata (entity type, ID, and changes map for updates) is serialized alongside the SQL queries in the Redis Stream. When the consumer processes the event:

1. The SQL is executed against MySQL.
2. The event is acknowledged (SQL is committed and safe).
3. The entity is loaded from the database using `GetByID`.
4. The registered callback is invoked with the loaded entity.

For **hard deletes**, the consumer pre-loads the entity from the database *before* executing the SQL (since the row will be gone after deletion). For **soft deletes** (FakeDelete), the entity is loaded after SQL execution since it still exists in the database.

If a callback returns an error during async consumption, the error is returned by `Consume()`. The SQL has already been committed and the event has been acknowledged, so the SQL will not be re-executed.

### Avoid Flush and Track Inside Callbacks

Callbacks fire inside the flush mutex. Calling `ctx.Flush()` or `ctx.Track()` on the same context from within a callback will cause a deadlock. If you need to perform additional persistence operations from a callback, create a new context:

```go
entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
    // DO NOT call ctx.Flush() or ctx.Track() here -- deadlock!

    // Instead, create a new context for any persistence operations
    newCtx := engine.NewContext(ctx.Context())
    auditLog := entities.AuditLogEntityProvider.New(newCtx)
    auditLog.SetAction("category_created")
    auditLog.SetEntityID(entity.GetID())
    return newCtx.Flush()
})
```

### Zero Overhead When Unused

If no callbacks are registered for an entity type, there is zero overhead. The flush path skips callback invocation entirely when no handlers are present.

## Use Cases

Lifecycle callbacks are useful for reacting to entity state changes without coupling the persistence logic to side effects. Common use cases include:

- **Audit logging** -- record who changed what and when
- **Event publishing** -- publish domain events to a message broker or Redis Stream after successful writes
- **Notifications** -- send emails, push notifications, or webhooks when entities change
- **Search index updates** -- update external search indexes (e.g., Elasticsearch) when entities are modified
- **Cache invalidation** -- invalidate or update external caches that depend on entity data

## Full Example

```go
package main

import (
    "context"
    "fmt"

    "github.com/latolukasz/fluxaorm/v2"
    "myapp/entities"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(&CategoryEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    // Register lifecycle callbacks
    entities.CategoryEntityProvider.OnAfterInsert(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
        fmt.Printf("INSERT: Category %d created with name %q\n", entity.GetID(), entity.GetName())
        return nil
    })

    entities.CategoryEntityProvider.OnAfterUpdate(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity, changes map[string]any) error {
        fmt.Printf("UPDATE: Category %d modified\n", entity.GetID())
        for field, oldValue := range changes {
            fmt.Printf("  %s: %v -> (new value via getter)\n", field, oldValue)
        }
        return nil
    })

    entities.CategoryEntityProvider.OnAfterDelete(engine, func(ctx fluxaorm.Context, entity *entities.CategoryEntity) error {
        fmt.Printf("DELETE: Category %d removed\n", entity.GetID())
        return nil
    })

    // Use the ORM as usual -- callbacks fire automatically on Flush
    ctx := engine.NewContext(context.Background())

    cat := entities.CategoryEntityProvider.New(ctx)
    cat.SetCode("electronics")
    cat.SetName("Electronics")
    _ = ctx.Flush() // prints: INSERT: Category 1 created with name "Electronics"

    cat.SetName("Consumer Electronics")
    _ = ctx.Flush() // prints: UPDATE: Category 1 modified
                     //           Name: Electronics -> (new value via getter)

    cat.Delete()
    _ = ctx.Flush() // prints: DELETE: Category 1 removed
}
```
