# Entity Schema

The `entitySchema` object holds metadata about every registered entity -- its table name, columns, indexes, cache configuration, and more. In v2, `entitySchema` is an internal (unexported) type. You do not use it for CRUD operations; those are handled by the generated [Provider](/guide/crud.html). Instead, `entitySchema` is used for **introspection** and **schema management**.

## Accessing Entity Schema

Entity schemas are registered internally when you call `registry.Validate()`. You can access schema information through the generated Provider or through the engine's registry.

For most use cases, the generated Provider already exposes the entity's table name, DB pool code, and Redis pool code as internal fields used by query methods. If you need to inspect schema metadata programmatically (e.g., for tooling or migrations), you can use the `GetAlters()` and `GetRedisSearchAlters()` functions described in the [Schema Update](/guide/schema_update.html) guide.

## Schema Introspection Methods

The `entitySchema` provides the following methods for inspecting entity metadata:

### GetTableName

Returns the MySQL table name for the entity:

```go
entitySchema.GetTableName() // e.g. "UserEntity"
```

### GetType

Returns the `reflect.Type` of the entity struct:

```go
entitySchema.GetType() // reflect.Type for UserEntity
```

### GetColumns

Returns a slice of all column names in the entity table, in order:

```go
entitySchema.GetColumns() // []string{"ID", "Name", "Email", "Age"}
```

### GetUniqueIndexes

Returns a map of unique index names to their column lists:

```go
entitySchema.GetUniqueIndexes() // map[string][]string{"Email": {"Email"}, "NameAge": {"Name", "Age"}}
```

## Data Pool Methods

### GetDB

Returns the MySQL `DB` pool assigned to the entity:

```go
db := entitySchema.GetDB()
```

### GetRedisCache

Returns the Redis cache pool for the entity, if configured:

```go
redisCache, hasRedisCache := entitySchema.GetRedisCache()
```

### GetLocalCache

Returns the local in-memory cache pool for the entity, if configured:

```go
localCache, hasLocalCache := entitySchema.GetLocalCache()
```

## Accessing Entity Tags

`entitySchema` provides a method to read `orm` struct tags:

```go
type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required;length=100"`
    Email string `orm:"required;unique=Email"`
}

entitySchema.GetTag("Name", "required", "yes", "")   // "yes"
entitySchema.GetTag("Name", "length", "", "")         // "100"
entitySchema.GetTag("Email", "unique", "", "")        // "Email"
entitySchema.GetTag("Email", "missing", "", "default") // "default"
```

The method signature is `GetTag(field, key, trueValue, defaultValue string) string`. When the tag value is `"true"`, it returns `trueValue` instead. If the tag is not found, it returns `defaultValue`.

## Cache Management

### DisableCache

You can disable Redis and/or local cache for a specific entity at runtime:

```go
entitySchema.DisableCache(true, true) // disables both local and Redis cache
entitySchema.DisableCache(true, false) // disables only local cache
entitySchema.DisableCache(false, true) // disables only Redis cache
```

### ClearCache

Clears Redis and local cache entries for the entity. Returns the number of removed Redis keys:

```go
removedKeys, err := entitySchema.ClearCache(ctx)
```

::: warning
If the entity has millions of records in Redis, clearing cache can take some time because Redis scans all keys.
:::

## Schema Management

### GetSchemaChanges

Compares the entity definition against the current MySQL table and returns any pending alterations:

```go
alters, hasChanges, err := entitySchema.GetSchemaChanges(ctx)
if hasChanges {
    for _, alter := range alters {
        err = alter.Exec(ctx)
    }
}
```

### UpdateSchema

Convenience method that retrieves and executes all pending schema changes:

```go
err := entitySchema.UpdateSchema(ctx)
```

### UpdateSchemaAndTruncateTable

Updates the schema and then truncates the table (deletes all rows and resets auto-increment):

```go
err := entitySchema.UpdateSchemaAndTruncateTable(ctx)
```

### DropTable

Drops the entire MySQL table:

```go
err := entitySchema.DropTable(ctx)
```

### TruncateTable

Truncates the MySQL table (removes all rows):

```go
err := entitySchema.TruncateTable(ctx)
```

## Custom Options

You can attach arbitrary key-value options to an entity schema:

```go
entitySchema.SetOption("myKey", "myValue")
value := entitySchema.Option("myKey") // returns "myValue"
```

## Important Notes

- `entitySchema` is used for **introspection and schema management only**. All CRUD operations (create, read, update, delete) are performed through the generated [Provider](/guide/crud.html).
- Entity schemas are created automatically during `registry.Validate()`. You do not instantiate them directly.
- For applying schema changes across all entities at once, use the top-level `fluxaorm.GetAlters(ctx)` function described in [Schema Update](/guide/schema_update.html).
