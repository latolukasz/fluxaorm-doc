# Data pools

It's time to learn how to set up connections to your databases in BeeORM.

Each connection pool in BeeORM requires a unique name that will be used in your code to identify the source of data. This name will be used later to access the data in your code. 
Make sure to choose a clear and descriptive name for each connection pool to avoid confusion and make your code easy to read and maintain.

## MySQL pool

To connect to a MySQL database, you can use the `RegisterMySQL` method, which takes a MySQL golang sql driver [data source name](https://github.com/go-sql-driver/mysql#dsn-data-source-name) as an first argument. 
The method is defined as follows:

```go
registry := orm.NewRegistry()

//MySQL pool with name "default" with default options:
registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", orm.DefaultPoolCode, nil)

//pool with name "logs" and custom options:
registry.RegisterMySQL("user:password@tcp(localhost:3306)/logs", "logs", *orm.MySQLOptions{MaxOpenConnections: 100})
```

```yml
default:
  mysql: 
   uri: user:password@tcp(localhost:3306)/db
logs:
  mysql: 
    uri: user:password@tcp(localhost:3306)/logs
    maxOpenConnections: 100
```

### MySQL options

With `MySQLOptions` argument yon can configure very important [MySQL golang driver important setting](https://github.com/go-sql-driver/mysql#important-settings):

```go
options := orm.MySQLPoolOptions{
    MaxOpenConnections: 30, 
    MaxIdleConnections: 20, 
    ConnMaxLifetime: 3 * time.Minute,
    DefaultEncoding: "greek", // utf8mb4 by default
    DefaultCollate: "greek_general_ci", // 0900_ai_ci by default
    IgnoredTables: []string{"table1", "table2"}}
    
registry.RegisterMySQLPool("user:password@tcp(localhost:3306)/db", "global", options)
```

```yml
global:
  mysql: 
   uri: user:password@tcp(localhost:3306)/db
   maxOpenConnections: 30
   maxIdleConnections: 20
   connMaxLifetime: 180 // seconds
   defaultEncoding: greek
   defaultCollate: greek_general_ci
   ignoredTables:
     - table1
     - table2 
```

::: tip
You can configure MySQL connection settings, including parameters like `maxOpenConnections` and `maxIdleConnections`, 
but it's advisable to retain the default values (empty). BeeORM can automatically determine and set the optimal settings based on your MySQL database configuration.
:::

### Ignored tables


BeeORM's default behavior is to attempt to [remove all MySQL tables](/guide/schema_update.html#schema-update)  that are not explicitly defined in your application code. 
However, you have the option to retain these tables by specifying their names in the `IgnoredTables` option.


## Local cache pool

BeeORM offers a simple and extremely fast in-memory key-value cache for storing values. The cache uses the least recently used ([LRU](https://en.wikipedia.org/wiki/Cache_replacement_policies#Least_recently_used_(LRU))) algorithm to manage its size and automatically evicts the least frequently used values when it reaches capacity.

To use the cache, you simply need to specify the pool name and the maximum number of cached keys:

```go
// default pool with max 100 000 values
registry.RegisterLocalCache(orm.DefaultPoolCode, 100000)
// pool "last_searches" with no limits
registry.RegisterLocalCache("last_searches", 0)
```

```yml
default:
  local_cache: 100000
last_searches:
  local_cache: 0
```

::: tip
When using BeeORM's in-memory key-value cache, it's important to carefully consider the cache size. If the cache is too small, data will be evicted frequently, resulting in a low hit rate. On the other hand, if the cache is too large, it will use up a lot of memory and may contain data that is no longer needed.

To optimize the use of the cache, you can define multiple pools with different cache sizes. For example, you can keep frequently accessed data in larger pools, while less frequently used data can be stored in smaller pools. This will help to ensure that the most relevant data is always available and that the cache is used efficiently.
:::

## Redis server pool

BeeORM allows you to connect to Redis or DragonflyDB server or sentinel servers using the RegisterRedis method. This method requires a connection URI in the format HOST:PORT, followed by a Redis keys namespace and the database number (0-15).

Here are some examples of how to use the RegisterRedis method:

```go
// pool with name "default", default options, pointing to Redis database #0:
registry.RegisterRedis("localhost:6379", 0, orm.DefaultPoolCode, nil)

// pool with name "users", pointing to Redis database #1 with connection credentials:
registry.RegisterRedis("/var/redis.sock", 1, "users", &orm.RedisOptions{User: "user", Password: "password"})

// pool with name "cluster", pointing to Redis database #3 connected to Redis sentinel:
options := &orm.RedisOptions{Master: "master_name", Sentinels: []string{":26379", "192.156.23.11:26379", "192.156.23.12:26379"}}
registry.RegisterRedis("", 3, "cluster", options)

```

```yml
default:
  redis:localhost:6379:0
users:
  redis:/var/redis.sock:1?user=user&password=pass
cluster:
  sentinel:
    master_name:3?user=test&password=test2:
      - :26379
      - 192.156.23.11:26379
      - 192.156.23.12:26379
```

::: tip
We strongly recommend using Redis Sentinel pools instead of a single server pool in your production environment.
:::
