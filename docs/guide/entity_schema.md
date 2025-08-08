# Entity Schema

The `EntitySchema` object holds information about every registered entity. There are many ways to get the entity schema for an entity:

Using ` GetEntitySchema()` function:

```go{2}
orm := engine.NewORM(context.Background())
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
```

Using `Registry` and the entity name:

```go
entitySchema := engine.Registry().EntitySchema("main.CarEntity")
```

Using `Registry` and the entity instance:

```go
entitySchema := engine.Registry().EntitySchema(CarEntity{})
```

Using `Registry` and the entity type:

```go
entitySchema := engine.Registry().EntitySchema(reflect.TypeOf(CarEntity{}))
```

If the entity is not registered in the `orm.Registry`, above methods will return nil.

### Entity Schema Getters

Once you have the `orm.EntitySchema` object, you can use the following methods to get useful information about the entity:

```go
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
entitySchema.GetTableName() // "CarEntity"
entitySchema.GetType() // Returns the reflect.Type of the CarEntity
entitySchema.GetColumns() // []string{"ID", "Color", "Owner"}
entitySchema.GetUniqueIndexes() // []string{"IndexName"} // Returns names of all Unique indexes
```

### Accessing Entity Tags

`EntitySchema` provides methods that helps you read orm struct tags:

```go
type CarEntity struct {
	ID    uint64 `orm:"my-tag-1=value-1"` 
	Color string `orm:"my-tag-2=value-2;my-tag-3"` 
}
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
entitySchema.GetTag("ORM", "my-tag-1", "", "") // value-1
entitySchema.GetTag("Color", "my-tag-2", "", "") // value-2
entitySchema.GetTag("Color", "my-tag-3", "yes", "") // yes
entitySchema.GetTag("Color", "missing-tag", "", "") // ""
entitySchema.GetTag("Color", "missing-tag", "", "default value") // default value
```

## Entity MySQL pool

To retrieve entity MySQL pool, you can use the `GetDB()` method:

```go
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
db := entitySchema.GetDB()
```

## Entity Redis pool

To retrieve entity Redis cache pool, you can use the `GetRedisCache()` method:

```go
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
redisPool, hasRedisCache := entitySchema.GetRedisCache()
```

## Entity local cache pool


To retrieve entity local cache pool, you can use the `GetLocalCache()` method:

```go
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
localCache, hasLocalCache := entitySchema.GetLocalCache()
```

## Disabling cache

You can disable redis and local cache for specific Entity using `DisableCache()` method:

```go{6}
type CarEntity struct {
	ID    uint64 `orm:"localCache;redisCache"` 
	Color string 
}
entitySchema := fluxaorm.GetEntitySchema[CarEntity](orm)
entitySchema.DisableCache(true, true) // disables both redis and local cache
```