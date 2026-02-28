# Redis Operations

FluxaORM provides its own Redis client that wraps all standard [Redis commands](https://redis.io/commands) with built-in logging and metrics support.

## Registering Redis Pools

```go
import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"
)

registry := fluxaorm.NewRegistry()
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
registry.RegisterRedis("localhost:6379", 1, "cache", nil)
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

## Accessing the Redis Pool

Use `engine.Redis(poolCode)` to access a Redis pool:

```go
redisPool := engine.Redis(fluxaorm.DefaultPoolCode)
config := redisPool.GetConfig()
config.GetCode()           // "default"
config.GetDatabaseNumber() // 0
config.GetAddress()        // "localhost:6379"

cachePool := engine.Redis("cache")
cacheConfig := cachePool.GetConfig()
cacheConfig.GetCode()           // "cache"
cacheConfig.GetDatabaseNumber() // 1
```

You can also get the pool code directly:

```go
redisPool.GetCode() // "default"
```

## Key Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// SET - store a value with expiration
err := r.Set(ctx, "my-key", "my-value", 30*time.Second)

// GET - retrieve a value
value, has, err := r.Get(ctx, "my-key")
// value = "my-value", has = true

// SETNX - set only if key does not exist
wasSet, err := r.SetNX(ctx, "my-key", "value", time.Minute)

// DEL - delete one or more keys
err = r.Del(ctx, "key1", "key2")

// EXISTS - check if keys exist
count, err := r.Exists(ctx, "key1", "key2")

// TYPE - get the type of a key
keyType, err := r.Type(ctx, "my-key")

// EXPIRE - set expiration on a key
ok, err := r.Expire(ctx, "my-key", time.Hour)

// MSET - set multiple key-value pairs
err = r.MSet(ctx, "key1", "val1", "key2", "val2")

// MGET - get multiple keys
values, err := r.MGet(ctx, "key1", "key2")
// values[0] = "val1" (or nil if missing)

// GETSET - get from cache or compute and store
result, err := r.GetSet(ctx, "cache-key", time.Hour, func() any {
    return computeExpensiveValue()
})

// INCR - increment a key by 1
newVal, err := r.Incr(ctx, "counter")

// INCRBY - increment a key by a specific amount
newVal, err = r.IncrBy(ctx, "counter", 5)

// INCRWITHEXPIRE - increment and set expiration atomically
newVal, err = r.IncrWithExpire(ctx, "rate-limit", time.Minute)

// SCAN - iterate over keys matching a pattern
keys, nextCursor, err := r.Scan(ctx, 0, "prefix:*", 100)
```

## List Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// LPUSH - push values to the left of a list
length, err := r.LPush(ctx, "my-list", "val1", "val2")

// RPUSH - push values to the right of a list
length, err = r.RPush(ctx, "my-list", "val3")

// LPOP - pop from the left of a list
value, err := r.LPop(ctx, "my-list")

// RPOP - pop from the right of a list
value, found, err := r.RPop(ctx, "my-list")

// LLEN - get the length of a list
length, err = r.LLen(ctx, "my-list")

// LRANGE - get a range of elements
values, err := r.LRange(ctx, "my-list", 0, -1)

// LINDEX - get an element by index
value, found, err = r.LIndex(ctx, "my-list", 0)

// LSET - set an element at an index
err = r.LSet(ctx, "my-list", 0, "new-value")

// LREM - remove elements matching a value
err = r.LRem(ctx, "my-list", 1, "val1")

// LTRIM - trim a list to a range
err = r.Ltrim(ctx, "my-list", 0, 99)

// LMOVE - move an element between lists
value, err = r.LMove(ctx, "source", "dest", "LEFT", "RIGHT")

// BLMOVE - blocking move between lists
value, err = r.BLMove(ctx, "source", "dest", "LEFT", "RIGHT", 5*time.Second)
```

## Hash Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// HSET - set one or more hash fields
err := r.HSet(ctx, "my-hash", "field1", "val1", "field2", "val2")

// HSETNX - set a field only if it does not exist
wasSet, err := r.HSetNx(ctx, "my-hash", "field1", "val1")

// HGET - get a single hash field
value, has, err := r.HGet(ctx, "my-hash", "field1")

// HMGET - get multiple hash fields
values, err := r.HMGet(ctx, "my-hash", "field1", "field2")
// values["field1"] = "val1", values["field2"] = "val2" (nil if missing)

// HGETALL - get all fields and values
all, err := r.HGetAll(ctx, "my-hash")

// HDEL - delete hash fields
err = r.HDel(ctx, "my-hash", "field1")

// HLEN - get the number of fields
length, err := r.HLen(ctx, "my-hash")

// HINCRBY - increment a hash field by an integer
newVal, err := r.HIncrBy(ctx, "my-hash", "counter", 1)
```

## Set Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// SADD - add members to a set
added, err := r.SAdd(ctx, "my-set", "a", "b", "c")

// SMEMBERS - get all members
members, err := r.SMembers(ctx, "my-set")

// SISMEMBER - check if a value is a member
isMember, err := r.SIsMember(ctx, "my-set", "a")

// SCARD - get the number of members
count, err := r.SCard(ctx, "my-set")

// SPOP - remove and return a random member
value, found, err := r.SPop(ctx, "my-set")

// SPOPN - remove and return multiple random members
values, err := r.SPopN(ctx, "my-set", 3)
```

## Sorted Set Operations

```go
import "github.com/redis/go-redis/v9"

r := engine.Redis(fluxaorm.DefaultPoolCode)

// ZADD - add members with scores
added, err := r.ZAdd(ctx, "leaderboard", redis.Z{Score: 100, Member: "player1"}, redis.Z{Score: 200, Member: "player2"})

// ZCARD - get the number of members
count, err := r.ZCard(ctx, "leaderboard")

// ZCOUNT - count members with scores in a range
count, err = r.ZCount(ctx, "leaderboard", "100", "200")

// ZSCORE - get the score of a member
score, err := r.ZScore(ctx, "leaderboard", "player1")

// ZREVRANGE - get members in reverse order by rank
members, err := r.ZRevRange(ctx, "leaderboard", 0, 9)

// ZREVRANGEWITHSCORES - get members with scores in reverse order
membersWithScores, err := r.ZRevRangeWithScores(ctx, "leaderboard", 0, 9)

// ZRANGEWITHSCORES - get members with scores in order
membersWithScores, err = r.ZRangeWithScores(ctx, "leaderboard", 0, 9)

// ZRANGEARGSWITHSCORES - flexible range query
membersWithScores, err = r.ZRangeArgsWithScores(ctx, redis.ZRangeArgs{
    Key:   "leaderboard",
    Start: 0,
    Stop:  9,
})
```

## Stream Operations

```go
import "github.com/redis/go-redis/v9"

r := engine.Redis(fluxaorm.DefaultPoolCode)

// XLEN - get the length of a stream
length, err := r.XLen(ctx, "my-stream")

// XTRIM - trim a stream to a maximum length
deleted, err := r.XTrim(ctx, "my-stream", 1000)

// XRANGE - read messages in forward order
messages, err := r.XRange(ctx, "my-stream", "-", "+", 100)

// XREVRANGE - read messages in reverse order
messages, err = r.XRevRange(ctx, "my-stream", "+", "-", 100)

// XREAD - read from one or more streams
streams, err := r.XRead(ctx, &redis.XReadArgs{
    Streams: []string{"my-stream", "0"},
    Count:   100,
})

// XDEL - delete messages by ID
deleted, err = r.XDel(ctx, "my-stream", "1234567890-0")

// XACK - acknowledge messages in a consumer group
acked, err := r.XAck(ctx, "my-stream", "my-group", "1234567890-0")

// XINFOSTREAM - get stream information
info, err := r.XInfoStream(ctx, "my-stream")

// XINFOGROUPS - get consumer group information
groups, err := r.XInfoGroups(ctx, "my-stream")

// XGROUPCREATE - create a consumer group
key, exists, err := r.XGroupCreate(ctx, "my-stream", "my-group", "0")

// XGROUPCREATEMKSTREAM - create a group and stream if needed
key, exists, err = r.XGroupCreateMkStream(ctx, "my-stream", "my-group", "0")

// XGROUPDESTROY - destroy a consumer group
res, err := r.XGroupDestroy(ctx, "my-stream", "my-group")

// XGROUPDELCONSUMER - delete a consumer from a group
res, err = r.XGroupDelConsumer(ctx, "my-stream", "my-group", "consumer-1")

// XREADGROUP - read from a stream as part of a consumer group
streams, err = r.XReadGroup(ctx, &redis.XReadGroupArgs{
    Group:    "my-group",
    Consumer: "consumer-1",
    Streams:  []string{"my-stream", ">"},
    Count:    100,
    Block:    5 * time.Second,
})

// XPENDING - get pending message summary
pending, err := r.XPending(ctx, "my-stream", "my-group")

// XPENDINGEXT - get detailed pending messages
pendingExt, err := r.XPendingExt(ctx, &redis.XPendingExtArgs{
    Stream: "my-stream",
    Group:  "my-group",
    Start:  "-",
    End:    "+",
    Count:  100,
})

// XAUTOCLAIM - auto-claim idle pending messages
messages, start, err := r.XAutoClaim(ctx, &redis.XAutoClaimArgs{
    Stream:   "my-stream",
    Group:    "my-group",
    Consumer: "consumer-1",
    MinIdle:  5 * time.Second,
    Start:    "0-0",
    Count:    100,
})

// XCLAIM - claim specific pending messages
messages, err = r.XClaim(ctx, &redis.XClaimArgs{
    Stream:   "my-stream",
    Group:    "my-group",
    Consumer: "consumer-1",
    MinIdle:  5 * time.Second,
    Messages: []string{"1234567890-0"},
})

// XCLAIMJUSTID - claim and return only IDs
ids, err := r.XClaimJustID(ctx, &redis.XClaimArgs{
    Stream:   "my-stream",
    Group:    "my-group",
    Consumer: "consumer-1",
    MinIdle:  5 * time.Second,
    Messages: []string{"1234567890-0"},
})
```

## Scripting Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// EVAL - execute a Lua script
result, err := r.Eval(ctx, "return redis.call('get', KEYS[1])", []string{"my-key"})

// EVALSHA - execute a script by SHA1 hash
result, exists, err := r.EvalSha(ctx, "sha1hash", []string{"my-key"})

// SCRIPT LOAD - load a script into the script cache
sha1, err := r.ScriptLoad(ctx, "return redis.call('get', KEYS[1])")

// SCRIPT EXISTS - check if a script exists in the cache
exists, err := r.ScriptExists(ctx, "sha1hash")
```

## Search Operations (RediSearch)

```go
import "github.com/redis/go-redis/v9"

r := engine.Redis(fluxaorm.DefaultPoolCode)

// FT._LIST - list all indexes
indexes, err := r.FTList(ctx)

// FT.CREATE - create a search index
err = r.FTCreate(ctx, "my-index", &redis.FTCreateOptions{
    OnHash: true,
    Prefix: []any{"doc:"},
}, &redis.FieldSchema{
    FieldName: "title",
    FieldType: redis.SearchFieldTypeText,
})

// FT.SEARCH - search an index
result, err := r.FTSearch(ctx, "my-index", "hello world", nil)

// FT.INFO - get index information
info, found, err := r.FTInfo(ctx, "my-index")

// FT.DROPINDEX - drop an index
err = r.FTDrop(ctx, "my-index", false) // false = keep documents
```

## Server Operations

```go
r := engine.Redis(fluxaorm.DefaultPoolCode)

// INFO - get server information
info, err := r.Info(ctx, "memory")

// FLUSHDB - flush the current database
err = r.FlushDB(ctx)

// FLUSHALL - flush all databases
err = r.FlushAll(ctx)
```

## Accessing the Underlying Client

If you need access to the raw `redis.Client` from the `go-redis` library:

```go
client := engine.Redis(fluxaorm.DefaultPoolCode).Client()
```

## Using Redis Pipelines

Pipelines allow you to send multiple Redis commands in a single round trip, significantly reducing network overhead. Create a pipeline using `ctx.RedisPipeLine()`:

```go
pipeLine := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
pipeLine.Set("key-1", "value-1", time.Hour)
pipeLine.Set("key-2", "value-2", time.Hour)
pipeLine.Set("key-3", "value-3", time.Hour)
_, err := pipeLine.Exec(ctx) // sends 3 SET commands in one request
```

### Reading Values from a Pipeline

Pipeline read commands return result objects. Call `Result()` after `Exec()` to retrieve the values:

```go
pipeLine := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
c1 := pipeLine.Get("key-1")
c2 := pipeLine.Get("key-2")
c3 := pipeLine.Get("key-3")
c4 := pipeLine.Get("key-4")
_, err := pipeLine.Exec(ctx)
if err != nil {
    panic(err)
}
val, has, err := c1.Result() // "value-1", true, nil
val, has, err = c2.Result()  // "value-2", true, nil
val, has, err = c3.Result()  // "value-3", true, nil
val, has, err = c4.Result()  // "", false, nil
```

### Available Pipeline Commands

The pipeline supports the following commands:

**Key operations:**
- `Set(key string, value any, expiration time.Duration)`
- `Get(key string) *PipeLineGet` -- `Result()` returns `(string, bool, error)`
- `Del(key ...string)`
- `MSet(pairs ...any)`
- `Expire(key string, expiration time.Duration) *PipeLineBool` -- `Result()` returns `(bool, error)`

**List operations:**
- `LPush(key string, values ...any)`
- `RPush(key string, values ...any)`
- `LSet(key string, index int64, value any)`
- `LRange(key string, start, stop int64) *PipeLineSlice` -- `Result()` returns `([]string, error)`

**Hash operations:**
- `HSet(key string, values ...any)`
- `HDel(key string, values ...string)`
- `HIncrBy(key, field string, incr int64) *PipeLineInt` -- `Result()` returns `(int64, error)`

**Set operations:**
- `SAdd(key string, members ...any)`
- `SRem(key string, members ...any)`

**Stream operations:**
- `XAdd(stream string, values []string) *PipeLineString` -- `Result()` returns `(string, error)`
