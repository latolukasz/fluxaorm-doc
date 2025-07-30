# Redis Operations

BeeORM provides its own Redis client that can be used to execute all [Redis commands](https://redis.io/commands).

```go
registry := orm.NewRegistry()
registry.RegisterRedis("localhost:6379", 0, orm.DefaultPoolCode, nil)
registry.RegisterRedis("localhost:6379", 1, "test", nil)
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
orm := engine.NewORM(context.Background())
```

## Accessing the Redis Data Pool

Now that we have configured the Redis data pool and engine, we can use the `GetRedis()` method to access the pool and execute Redis operations. This pool also provides a few useful methods:

```go
redisPool := engine.Redis(orm.DefaultPoolCode) // or c.Engine().Redis(orm.DefaultPoolCode)
config := redisPool.GetConfig()
config.GetCode() // "default"
config.GetDatabaseNumber() // 0
config.GetAddress() // "localhost:6379"

config = engine.Redis("test").GetConfig()
config.GetCode() // "test"
config.GetDatabase() // 3
config.GetAddress() // "localhost:6379"
```

## Standard Redis Operations

Using the BeeORM Redis data pool, you can execute all Redis commands except [SELECT](https://redis.io/commands/select), as the database number for each Redis data pool is already defined.

```go
redisPool := engine.Redis(orm.DefaultPoolCode)
redisPool.Set(orm, "my-key", "some-value", 30) // cache for 30 seconds
value, has := redisPool.Get(orm, "my-key")
pushed := redisPool.LPUsh(orm, "another-key", "value-1", "value-2")

testPool := engine.Redis("test")
testPool.FlushDB(orm) // flush redis DB 3
```

## Using Redis Pipelines

To send Redis commands in a [pipeline](https://redis.io/topics/pipelining), create a `RedisPipeLine` object using the `RedisPipeLine()` method of `orm.ORM`, register the commands you want to send, and then call the `Execute()` method to send all the commands to Redis at once.

```go{1,5,12}
pipeLine := c.RedisPipeLine(orm.DefaultPoolCode)
pipeLine.Set("key-1", "value-1", time.Hour)
pipeLine.Set("key-2", "value-2", time.Hour)
pipeLine.Set("key-3", "value-3", time.Hour)
pipeLine.Exec() // sends 3 set commands in one request

pipeLine = c.RedisPipeLine(orm.DefaultPoolCode)
c1 := pipeLine.Get("key-1")
c2 := pipeLine.Get("key-2")
c3 := pipeLine.Get("key-3")
c4 := pipeLine.Get("key-4")
pipeLine.Exec()
val, has := c1.Result() // "value-1", true
val, has = c2.Result() // "value-2", true
val, has = c3.Result() // "value-3", true
val, has = c4.Result() // "", false
```