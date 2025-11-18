# Entities

In FluxaORM, an Entity is a struct that represents data stored in a database. In this section, you will learn how to define golang structs as Entity types.

## Defining an Entity

To define an Entity struct, you must follow one rule - the first field of the struct should be called `ID` and be type of uint (8, 16, 32 or 64).

Here is an example of a simple Entity struct:

```go
import "github.com/latolukasz/fluxaorm"

type SimpleEntity struct {
	ID uint64
}
```

## Registering Entity

In order to use an entity in orm, it must be registered in the Registry:

```go{2}
registry := fluxaorm.NewRegistry()
registry.RegisterEntity(&entity.UserEntity{}) 
```

## Defining data pools

### Mysql pool

By default, Entity is connected to `default` [data pool](/guide/datapools.html#mysql-pool).
You can define different pool with special setting **mysql=pool_name** put in tag `orm` 
for `orm.ORM` field:

```go{6,10}
package main

import "github.com/latolukasz/fluxaorm"

type UserEntity struct {
	ID  uint64  // equal to `orm:"mysql=default"`
}

type OrderEntity struct {
	ID  uint64 `orm:"mysql=sales"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterMySQL("user:password@tcp(localhost:3307)/db", "sales", nil)
    registry.RegisterEntity(OrderEntity{}) 
}  
```

### Redis pool

To protect MySQL from unnecessary queries, entities can be automatically cached in Redis. To enable Redis cache for an entity, use the setting redisCache=pool_name in the orm tag of the fluxaorm.ORM field. This specifies which Redis server or Sentinel pool should be used to store the data.

For a pool with the name default, you can use the short version orm:"redisCache" without specifying the pool name.

Here is an example in Go code:

```go{6,10}
package main

import "github.com/latolukasz/fluxaorm"

type UserEntity struct {
	ID uint64 `orm:"redisCache"`
}

type OrderEntity struct {
	ID uint64 `orm:"redisCache=sales"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    RegisterRedis("localhost:6390", 0, "sales", nil)
    registry.RegisterEntity(UserEntity{}, &OrderEntity{}) 
}  
```

::: tip
To optimize Redis as a cache for entities, it is recommended to set the maxmemory setting to a value below the machine's memory size, and enable the allkeys-lru policy. This will prevent Redis from using too much memory and potentially crashing the application.

Additionally, it is a good idea to disable persistence storage in Redis. If data is lost, FluxaORM will automatically refill it from MySQL, ensuring top performance and preventing the application from going down.
:::

### Local in-memory pool

To cache Entity data in memory locally, you can use the setting `localCache` in the same way as registering a Redis pool (see the example above). This will enable a local in-memory cache to store the data.
Optionally you can define local cache size.

```go{6,10}
package main

import "github.com/latolukasz/fluxaorm"

type CategoryEntity struct {
	ID uint16 `orm:"localCache"` // equal to localcache=0
}

type BrandEntity struct {
	ID uint16 `orm:"localCache=1000"` // cache size is 1000 elements
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(CategoryEntity{}, &BrandEntity{}) 
}  
```


### Using Both Redis and Local Cache Simultaneously

It is possible to cache an Entity in both a local cache and Redis using FluxaORM. To do so, you can use the following syntax:

```go{2}
type CategoryEntity struct {
	ID uint64 `orm:"localCache;redisCache"`
}
```

This allows you to take advantage of the benefits of both types of caching in your application. The local cache can provide faster access to frequently used data, while Redis can store larger amounts of data and be accessed by multiple servers.

::: tip
It is highly recommended to enable both local caching and Redis caching for Entity in your application. This can greatly improve the performance of your system by reducing the number of queries made to the MySQL database.

When data is requested and not found in the local cache, FluxaORM will try to load it from the Redis cache. If the data is still not available, it will be retrieved from MySQL, stored in Redis, and then also stored in the local cache. This means that subsequent requests for the same data from the same machine will be served from the local cache, while requests from other machines will be served from the Redis cache.

Enabling both local caching and Redis caching helps to distribute the load on the MySQL database and can be especially useful when your code is running on multiple physical servers or when you are using autoscaling based on traffic.
:::


### Customizing the Entity Table Name

By default, FluxaORM will use the name of the Entity struct as the name of the corresponding MySQL table. However, you can specify a custom table name by using the table tag setting:

```go{2}
type UserEntity struct {
	ID uint64 `orm:"table=users"`
}
```

This allows you to specify a table name that may be more descriptive or follow a naming convention that you have established for your database tables.

### Setting Entity Redis Cache TTL

By default the Redis cache TTL for an Entity is set to 0, which means data is cached forever. You can change this by using the ttl tag setting:

```go{2}
type UserEntity struct {
	ID uint64 `orm:"ttl=30"` // Cache for 30 seconds
}
```

TTL expiration time is reset every time the data is updated. This ensures that stale data is not served to clients, improving the accuracy and freshness of cached data.