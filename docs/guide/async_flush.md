# Async flush

In the [previous chapter](/guide/crud.html), you learned how to add, update, and delete entities using the `Flush()` method of the `orm.ORM`. 
`Flush()` executes both MySQL and cache (Redis, local cache) queries. Redis operations usually take a few milliseconds, and local cache changes are almost instantaneous. 
However, SQL queries can take a significant amount of time, typically more than 100 milliseconds. In high-traffic applications, SQL queries 
often become a performance bottleneck.

To address this issue, FluxaORM provides a powerful feature that allows you to run all SQL queries asynchronously. 
All you need to do is use the `FlushAsync()` method instead of `Flush() `and run the `BackgroundConsumer.Digest()` 
function in a separate thread or application.

See the example below:

```go{23}
package main

import "github.com/latolukasz/fluxaorm"

type CategoryEntity struct {
	ID          uint64      `orm:"localCahe;redisCache"`
	Name        string `orm:"required;length=100"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil) 
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(CategoryEntity{}) 
    engine, err := registry.Validate(0)
    if err != nil {
        panic(err)
    }
    orm := engine.NewContext(context.Background())
    
    categoryCars := fluxaorm.NewEntity[CategoryEntity](orm)
    categoryCars.Name = "Cars"
    err := fluxaorm.FlushAsync()
}  
```

In the example above, the `FlushAsync()` method pushes the `INSERT INTO ...` SQL query into a special Redis list and adds entity data into Redis or local cache.

## Consuming async queries

When you use `FlushAsync()` to commit your changes, it's essential to execute the `BackgroundConsumer.Digest()` function in your application, 
as demonstrated below:

```go
consumer := fluxaorm.NewBackgroundConsumer(ctx)
finished := consumer.Digest() // blocks and waits for new SQL queries to be processed
```

## Understanding Cache Updates

To ensure smooth operation of your application and prevent unexpected issues, it is crucial to have a solid grasp of how asynchronous cache flushing works in FluxaORM. When you execute the `FlushAsync()` function, FluxaORM updates entity data in the cache. This data is 
added to both Redis (when the entity uses the `redisCache` tag) and the local cache (when the `localCache` tag is used). SQL queries are executed at a later stage, typically a few milliseconds after the `FlushLazy()` call, thanks to the `consumer.Digest()` function. This is the reason why not all FluxaORM functions that retrieve entities from the database return updated data immediately after the execution of `FlushLazy()`.

Let's take a closer look at an example to help you understand how this process works:

```go{2,6}
type CategoryEntity struct {
	ID   uint64 `orm:"redisCache"` // utilizes cache
	Name string `orm:"required;unique=Name"`
}
type UserEntity struct {
	ID   uint64 // no cache
	Name string `orm:"required;unique=Name"`
}

category := fluxaorm.NewEntity[CategoryEntity](orm) // ID 1
category.Name = "cars"
user := fluxaorm.NewEntity[UserEntity](orm) // ID 1
categoryCars.Name = "Tom"
c.FlushAsync()

// The following code is executed in another thread just after the previous code
// but before consumer.Digest() consumes events:

// Returns valid data because it's saved in Redis
category, found := fluxaorm.GetByID[CategoryEntity](orm, 1)
categories := fluxaorm.GetByIDs[CategoryEntity](orm, 1)
category, found := fluxaorm.GetByUniqueIndex[CategoryEntity](orm, "Name", "cars")
// Returns nil because UserEntity does not use any cache
user, found := fluxaorm.GetByID[UserEntity](orm, 1)
users := fluxaorm.GetByIDs[UserEntity](orm, 1)
// Returns valid data because unique indexes are always cached in Redis
user, found := fluxaorm.GetByUniqueIndex[UserEntity](orm, "Name", "Tom")

// Returns nil because search functions never use cache
category, found = SearchOne[CategoryEntity](orm, fluxaorm.NewWhere("Name = ?", "cars"))
user, found = SearchOne[UserEntity](orm, fluxaorm.NewWhere("Name = ?", "Tom"))
```

Below, you'll find a list of functions that return updated entity data when `FlushAsync()` is executed:

* [GetByID](/guide/crud.html#getting-entity-by-id) when the entity uses cache
* [GetByIDs](/guide/crud.html#getting-entities-by-id) when the entity uses cache
* [GetByUniqueIndex](/guide/crud.html#getting-entities-by-unique-key) always
* [GetByReference](/guide/crud.html#getting-entities-by-reference) when the reference field has the `cached` tag
* [GetAll](/guide/crud.html#getting-all-entities) when the ID field has the `cached` tag

Please note that all [search functions](/guide/search.html) do not return updated entity data until `consumer.Digest()` processes the SQL queries.

## Handling Errors in Async Flush Consumption

The `consumer.Digest()` function plays a crucial role in processing SQL queries by reading them from a Redis set and executing them one by one. When an SQL query generates an error, FluxaORM undertakes the task of determining whether the error is temporary or not.

In cases of temporary errors, the `consumer.Digest()` function will panic, and it is the responsibility of the developer to report this error, address the underlying issue, and then re-run `consumer.Digest()`.

Temporary errors are typically characterized by issues such as:

* Error 1045: Access denied
* Error 1040: Too many connections
* Error 1213: Deadlock found when trying to get lock; try restarting the transaction
* Error 1031: Disk full, waiting for someone to free some space

As seen above, these errors should either be resolved by the developer (e.g., disk full) or re-executed (e.g., deadlock found).

On the other hand, non-temporary errors are skipped, and they are moved to a special Redis stream `fluxaorm.LazyErrorsChannelName`, which retains all problematic SQL queries along with their corresponding errors. Non-temporary errors are typically issues that cannot be fixed by simply re-executing the query. Instead, the developer must manually address and execute these queries and remove them from the list.

Here are examples of non-temporary errors:

* Error 1022: Can't write; duplicate key in table
* Error 1049: Unknown database
* Error 1051: Unknown table
* Error 1054: Unknown column
* Error 1064: Syntax error
