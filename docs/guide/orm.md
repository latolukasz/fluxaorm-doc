# ORM

In this section, we will explore the fundamental element of FluxaORM: the `orm.ORM` object, and discover how to create and effectively employ it.

In the previous chapter, you gained insight into creating the `Engine` object, an essential component for accessing data pools and managing registered entities. 
The `orm.ORM` plays a pivotal role in all FluxaORM methods, typically serving as the initial argument, facilitating data retrieval and modification in your databases, which forms the cornerstone of every ORM's functionality.

## Creating the ORM

To instantiate a `orm.ORM` object, you should invoke the `NewORM()` method on a `orm.Engine` object. 
Here's a comprehensive example illustrating how to create a `orm.ORM`:

```go{15}
package main

import (
	"context"
    "github.com/latolukasz/fluxaorm"
)

func main() {
    registry := fluxaorm.NewRegistry()
    // ... register data pools and entities
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    orm := engine.NewORM(context.Background())
}  
```

## ORM Query Debug

You have the option to activate debug mode for each `ORM` in order to observe all the queries executed for MySQL, Redis, and the local cache.

```go
// all queries
orm.EnableQueryDebug()
// only queries to MySQL
orm.EnableQueryDebugCustom(true, false, false)
// only queries to MySQL and Redis
orm.EnableQueryDebugCustom(true, true, false)
```

Here is an example of how the debug output looks:

![An image](/query_debug_1.png)

Every query is displayed in two lines. The first line (with a white background) contains the following fields:

* FluxaORM logo
* query source (MySQL, redis, local cache)
* data pool name
* operation
* query time in milliseconds

The length of the white bar is correlated with the query time. If a query takes more time, the bar is longer and more red. This helps you to identify slow queries. The full query is displayed on the second line.

## ORM Meta Data

You can use `orm.ORM` to store extra parameters using `SetMetadata` and `GetMetaData` methods:

```go
orm.SetMetaData("source": "cron_A")
orm.GetMetaData() // {"source": "cron_A"}
```

## ORM clone

You can generate as many `orm.ORM` instances in your code as needed. 
Nevertheless, if you wish to share context settings like metadata or debug mode across multiple contexts, you should configure them for each created `Context`, 
as demonstrated in the example below:

```go{6,7}
orm := engine.NewORM(context.Background())
orm.SetMetaData("admin_user_id", 34)
orm.EnableQueryDebug()

orm2 := engine.NewORM(context.Background())
orm2.SetMetaData(orm.GetMetaData())
orm2.EnableQueryDebug()
```

To address this issue, the `orm.ORM` provides a specialized method called `Clone()`, which generates a new instance of the `ORM` containing a copy of the metadata and inherits the metadata and debug mode is the same as in cloned Context:

```go{5}
orm := engine.NewORM(context.Background())
orm.SetMetaData("admin_user_id", "34")
orm.EnableQueryDebug()
go func() {
    orm2 := fluxaorm.Clone()
    orm2.GetMetaData() // {"admin_user_id", "34"}
}()
```

Alternatively, you can clone a `ORM` and provide a new context.Context as an argument using the `CloneWithContext()` method:

```go{2}
orm := engine.NewORM(context.Background())
orm2 := engine.CloneWithContext(context.WithDeadline(c.Ctx(), time.Now().Add(time.Second * 5)))
```