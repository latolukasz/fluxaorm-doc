# Virtual Entities

By default every FluxaORM Entity is stored in MySQL. However, you can define entity as virtual and store it only in Redis or local cache.

## Defining Virtual Entities

To mark Entity as virtual, you must add the `virtual` tag to the entity definition:

```go
type MyVirtualEntity struct {
	ID            uint64     `orm:"virtual;redisCache"`
	Age           uint8      
	Name          string     
}
```

:::warning
Don't forget to add the redisCache or localCache tag to the entity definition. Otherwise an error will be thrown.
:::

## Primary Key

You must define a primary key (ID) for virtual entities by setting ID value in your code when virtual entity is created.

```go
row, err := fluxaorm.NewEntity[MyVirtualEntity](ctx)
row.ID // zero
row.ID = 1
err = ctx.Flush()

// OR
row, err := fluxaorm.NewEntityWithID[MyVirtualEntity](ctx, 1)
err = ctx.Flush()
```

## Virtual Entity with Redis Search

Virtual entities can be indexed in Redis Search:

```go
type MyVirtualEntity struct {
	ID            uint64     `orm:"virtual;redisCache;redisSearch=default"`
	Age           uint8      `orm:"searchable;sortable"`
	Name          string     `orm:"searchable"`
}
```

And later you can search for entities using Redis Search:

```go
query = fluxaorm.NewRedisSearchQuery()
query.AddFilterNumber("Age", 18)
rows, total, err := fluxaorm.RedisSearch[MyVirtualEntity](ctx, query, nil)
```

Indexing virtual entities is not supported using built-in [schema.ReindexRedisIndex](/guide/redis_search.html#reindexing-an-entity-index)
mechanism. This code will throw an error:

```go
schema, err:= GetEntitySchema[MyVirtualEntity](orm)
err = schema.ReindexRedisIndex(ctx) // throws error
```

You must fill index by yourself using fluxaorm.NewEntity() method.

