# Engine

In previous sections, you learned how to create a `Registry` object and register entities with it. You should also know how to configure database connections by now. In this section, you will learn about the `Engine`, which is the heart of FluxaORM.

## Validating the Registry

To create an Engine, you first need to create a `Registry` object and register the necessary database connections and entities with it. Then, you can call the `registry.Validate()` method to create a `Engine` object.

Here is an example:

```go{16}
package main

import "github.com/latolukasz/fluxaorm"

type UserEntity struct {
	ID   uint64
	Name string `orm:"required"`
}

func main() {
    registry := fluxaorm.NewRegistry(0)
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(UserEntity{}) 
    
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
}  
```


::: tip
It is recommended to create the `Registry` object and call `registry.Validate()` only once in your application, when it starts. For example, if you are running an HTTP server, you should run the above code before the `http.ListenAndServe(":8080", nil)` line.
:::

The `Engine` object should be shared across all goroutines in your application. It serves as a read-only, validated source of FluxaORM settings, including connection credentials and entity structures. You cannot use it to register more entities or connections - this should be done using a `Registry` object. In other words, the `Registry` is where you configure FluxaORM, while the `Engine` is a read-only source of the resulting configuration.

## Engine Registry

The `Engine` object provides method `Registry()` for accessing information about registered entities and data pools:

```go{22,27,32,37}
package main

import "github.com/latolukasz/fluxaorm"

type CarEntity struct {
	ID    uint64
	Color string
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(orm.DefaultPoolCode, 0)
    registry.RegisterEntity(CarEntity{}) 
    engine, err := registry.Validate()
    if err != nil {
      panic(err)
    }
    
    // Returns all registered entities
    for _, schema := range engine.Registry().GetEntities() {
        fmt.Printf("%s = %s\n", schema.Type().Name, schema.GetTableName())
    }
    
    // Returns all MySQL pools
     for code, db := range := engine.Registry().DBPools() {
        fmt.Printf("%s = %s\n", code, db.GetConfig().GetDatabaseName())
    }
    
     // Returns all Redis pools
     for code, redisPool := range := engine.Registry().RedisPools() {
        fmt.Printf("%s = %d\n", code, redisPool.GetConfig().GetDatabaseNumber())
    }
    
     // Returns all local cache pools
     for code, localCache := range := engine.Registry().LocalCachePools() {
        fmt.Printf("%s = %d\n", code, localCache.GetConfig().GetLimit())
    }
}  
```

## Getting MySQL pool

To retrieve a MySQL pool by code, you can use the `DB()` method:

```go
db := engine.DB(orm.DefaultPoolCode)
```

## Getting Redis pool

To retrieve a Redis pool by code, you can use the `Redis()` method:

```go
redisPool := engine.Redis(orm.DefaultPoolCode)
```

## Getting local cache pool

To retrieve a local cache pool by code, you can use the `LocalCache()` method:

```go
localCache := engine.LocalCache(orm.DefaultPoolCode)
```