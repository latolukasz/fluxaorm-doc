---
description: "Using the FluxaORM RedisCache client: registering Redis pools, keys, hashes, lists, sets, streams, scripts and the RedisPipeLine."
---

# Redis Operations

FluxaORM wraps [go-redis](https://github.com/redis/go-redis) in its own `RedisCache` client. Every command executed through it is timed, reported to the [query log](/guide/queries_log.html) and to [metrics](/guide/metrics.html), and uses the `context.Context` carried by the `fluxaorm.Context` you pass in.

## Registering Redis Pools

```go
import (
    "context"

    "github.com/latolukasz/fluxaorm/v2"
)

registry := fluxaorm.NewRegistry()
registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
registry.RegisterRedis("localhost:6379", 1, "sessions", &fluxaorm.RedisOptions{
    User:     "app",
    Password: "secret",
})
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

```go
RegisterRedis(address string, db int, poolCode string, options *RedisOptions)
```

An `address` ending in `.sock` is dialled as a unix socket. `options` may be `nil`.

### RedisOptions

| Field | Type | Description |
|-------|------|-------------|
| `User` | `string` | Username (Redis ACL) |
| `Password` | `string` | Password |
| `Master` | `string` | Sentinel master name |
| `Sentinels` | `[]string` | Sentinel addresses. When non-empty the pool is created with `redis.NewFailoverClient` and `address` is ignored |
| `SentinelOptions` | `*redis.FailoverOptions` | Full go-redis failover options. When `nil`, they are built from `Master`, `Sentinels`, `db`, `User` and `Password` |

## Accessing a Pool

```go
r := engine.Redis(fluxaorm.DefaultPoolCode) // fluxaorm.RedisCache

r.GetCode()                     // "default"
cfg := r.GetConfig()            // fluxaorm.RedisPoolConfig
cfg.GetCode()                   // "default"
cfg.GetDatabaseNumber()         // 0
cfg.GetAddress()                // "localhost:6379" (or the sentinel list)

client := r.Client()            // *redis.Client for anything not wrapped below (not logged / metered)
```

The default data pool code is used by generated code for entities with `orm:"redisCache"` -- see [Redis Cache](/guide/redis_cache.html) and [Data Pools](/guide/data_pools.html).

## Keys and Strings

```go
err := r.Set(ctx, "k", "v", time.Hour)                // SET k v EX 3600 (0 = no expiration)
value, has, err := r.Get(ctx, "k")                    // has == false when the key is missing, err == nil
wasSet, err := r.SetNX(ctx, "k", "v", time.Minute)    // SET NX
err = r.MSet(ctx, "k1", "v1", "k2", "v2")
values, err := r.MGet(ctx, "k1", "k2", "missing")     // []any, nil for missing keys
err = r.Del(ctx, "k1", "k2")
n, err := r.Exists(ctx, "k1", "k2")
t, err := r.Type(ctx, "k")
ok, err := r.Expire(ctx, "k", time.Hour)
v, err := r.Incr(ctx, "counter")
v, err = r.IncrBy(ctx, "counter", 5)
v, err = r.IncrWithExpire(ctx, "rate:user:1", time.Minute) // INCR + EXPIRE in one round trip
keys, next, err := r.Scan(ctx, 0, "user:*", 100)      // SCAN cursor MATCH pattern COUNT n
```

### GetSet

`GetSet` reads a key and, on a miss, computes the value, stores it and returns it:

```go
GetSet(ctx Context, key string, expiration time.Duration, provider func() any) (any, error)
```

```go
val, err := r.GetSet(ctx, "settings", time.Hour, func() any {
    return loadSettings()
})
```

The value returned by `provider` is encoded with **msgpack** before it is stored. On a cache miss you get back exactly what `provider` returned; on a hit you get the msgpack-decoded value as `any` (e.g. `string`, `int64`, `map[string]any`), not your original Go type. Stick to primitive values, or serialise to a string yourself.

## Lists

```go
n, err := r.LPush(ctx, "queue", "a", "b")
n, err = r.RPush(ctx, "queue", "c")
v, err := r.LPop(ctx, "queue")                         // err == redis.Nil on an empty list
v, found, err := r.RPop(ctx, "queue")                  // found == false on empty list
n, err = r.LLen(ctx, "queue")
items, err := r.LRange(ctx, "queue", 0, -1)
v, found, err = r.LIndex(ctx, "queue", 0)
err = r.LSet(ctx, "queue", 0, "x")
err = r.LRem(ctx, "queue", 1, "x")                     // remove count occurrences
err = r.Ltrim(ctx, "queue", 0, 99)
v, err = r.LMove(ctx, "src", "dst", "LEFT", "RIGHT")
v, err = r.BLMove(ctx, "src", "dst", "LEFT", "RIGHT", 5*time.Second)
```

## Hashes

```go
err := r.HSet(ctx, "user:1", "name", "Alice", "age", 30)
ok, err := r.HSetNx(ctx, "user:1", "name", "Bob")
v, has, err := r.HGet(ctx, "user:1", "name")
m, err := r.HMGet(ctx, "user:1", "name", "age")       // map[string]any keyed by field, nil for missing
all, err := r.HGetAll(ctx, "user:1")                   // map[string]string
err = r.HDel(ctx, "user:1", "age")
n, err := r.HLen(ctx, "user:1")
n, err = r.HIncrBy(ctx, "user:1", "visits", 1)
```

## Sets and Sorted Sets

```go
import "github.com/redis/go-redis/v9"

added, err := r.SAdd(ctx, "tags", "a", "b")
members, err := r.SMembers(ctx, "tags")
is, err := r.SIsMember(ctx, "tags", "a")
n, err := r.SCard(ctx, "tags")
v, found, err := r.SPop(ctx, "tags")
vs, err := r.SPopN(ctx, "tags", 2)

added, err = r.ZAdd(ctx, "board", redis.Z{Score: 10, Member: "p1"}, redis.Z{Score: 20, Member: "p2"})
n, err = r.ZCard(ctx, "board")
n, err = r.ZCount(ctx, "board", "10", "20")
score, err := r.ZScore(ctx, "board", "p1")
top, err := r.ZRevRange(ctx, "board", 0, 9)
topZ, err := r.ZRevRangeWithScores(ctx, "board", 0, 9)
asc, err := r.ZRangeWithScores(ctx, "board", 0, 9)
custom, err := r.ZRangeArgsWithScores(ctx, redis.ZRangeArgs{Key: "board", Start: 0, Stop: 9, Rev: true})
```

There is no `SRem` on `RedisCache`; it is available on the [pipeline](#redis-pipelines).

## Streams

```go
n, err := r.XLen(ctx, "events")
deleted, err := r.XTrim(ctx, "events", 10000)                       // XTRIM MAXLEN
msgs, err := r.XRange(ctx, "events", "-", "+", 100)                // XRANGE ... COUNT 100
msgs, err = r.XRevRange(ctx, "events", "+", "-", 100)
streams, err := r.XRead(ctx, &redis.XReadArgs{Streams: []string{"events", "0"}, Count: 100})
deleted, err = r.XDel(ctx, "events", "1700000000000-0")
info, err := r.XInfoStream(ctx, "events")
groups, err := r.XInfoGroups(ctx, "events")                        // empty slice, nil error when the stream does not exist
```

### Consumer groups

```go
_, exists, err := r.XGroupCreate(ctx, "events", "workers", "0")
_, exists, err = r.XGroupCreateMkStream(ctx, "events", "workers", "$")
```

`XGroupCreate` / `XGroupCreateMkStream` return `(key string, exists bool, err error)`. When the group already exists (Redis `BUSYGROUP`), they return `("OK", true, nil)` instead of an error.

```go
streams, err := r.XReadGroup(ctx, &redis.XReadGroupArgs{
    Group:    "workers",
    Consumer: "worker-1",
    Streams:  []string{"events", ">"},
    Count:    100,
    Block:    5 * time.Second,
})
acked, err := r.XAck(ctx, "events", "workers", "1700000000000-0")
res, err := r.XAckDel(ctx, "events", "workers", "1700000000000-0")  // XACKDEL ... KEEPREF (Redis 8.2+)
pending, err := r.XPending(ctx, "events", "workers")
pendingExt, err := r.XPendingExt(ctx, &redis.XPendingExtArgs{Stream: "events", Group: "workers", Start: "-", End: "+", Count: 100})
msgs, start, err := r.XAutoClaim(ctx, &redis.XAutoClaimArgs{Stream: "events", Group: "workers", Consumer: "worker-1", MinIdle: time.Minute, Start: "0-0", Count: 100})
msgs, err = r.XClaim(ctx, &redis.XClaimArgs{Stream: "events", Group: "workers", Consumer: "worker-1", MinIdle: time.Minute, Messages: []string{"1700000000000-0"}})
ids, err := r.XClaimJustID(ctx, &redis.XClaimArgs{Stream: "events", Group: "workers", Consumer: "worker-1", MinIdle: time.Minute, Messages: []string{"1700000000000-0"}})
n, err = r.XGroupDelConsumer(ctx, "events", "workers", "worker-1")
n, err = r.XGroupDestroy(ctx, "events", "workers")
```

::: tip
`XReadGroup` treats `Block >= 0` (including the zero value) as a blocking read: the call is not timed or logged, only counted in `fluxaorm_redis_queries_block`. Pass a negative `Block` for a non-blocking read. `redis.Nil` (no messages), `context.Canceled` and `context.DeadlineExceeded` are returned as `nil` error with an empty result.
:::

## Scripting

```go
res, err := r.Eval(ctx, "return redis.call('get', KEYS[1])", []string{"k"})
sha, err := r.ScriptLoad(ctx, "return redis.call('get', KEYS[1])")
exists, err := r.ScriptExists(ctx, sha)
res, exists, err = r.EvalSha(ctx, sha, []string{"k"})
```

`EvalSha` returns `(res any, exists bool, err error)`. When `EVALSHA` fails, the client checks `ScriptExists`: if the script is simply not loaded you get `(nil, false, nil)` so you can fall back to `ScriptLoad` + retry; if the `ScriptExists` lookup itself fails that error is returned. When the script **is** loaded but the `EVALSHA` call failed (e.g. a runtime error inside the script), the call returns `(nil, true, nil)` -- the script error is not propagated.

## Redis Search

The `FT.*` wrappers are what generated code uses for [Redis Search](/guide/redis_search.html); you can use them directly for custom indexes:

```go
indexes, err := r.FTList(ctx)
err = r.FTCreate(ctx, "idx:docs", &redis.FTCreateOptions{OnHash: true, Prefix: []any{"doc:"}},
    &redis.FieldSchema{FieldName: "title", FieldType: redis.SearchFieldTypeText})
result, err := r.FTSearch(ctx, "idx:docs", "hello", nil)  // nil options => &redis.FTSearchOptions{DialectVersion: 1}
info, found, err := r.FTInfo(ctx, "idx:docs")           // found == false, err == nil when the index does not exist
err = r.FTDrop(ctx, "idx:docs", false)                    // true = FT.DROPINDEX ... DD (also delete the documents)
```

`FTSearch` returns a `redis.FTSearchResult` with `Total` and `Docs` (`ID`, `Fields`, `Score`, `Payload`) parsed from the RESP3 reply.

## Server

```go
info, err := r.Info(ctx, "memory")   // INFO [section ...]
err = r.FlushDB(ctx)
err = r.FlushAll(ctx)
```

## Distributed Lock

`r.GetLocker()` returns the pool's `*Locker`. See [Distributed Lock](/guide/distributed_lock.html).

## Redis Pipelines

A pipeline sends many commands in one round trip. Create one from the context:

```go
pipe := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
pipe.Set("k1", "v1", time.Hour)
pipe.Set("k2", "v2", time.Hour)
pipe.HSet("user:1", "name", "Alice")
_, err := pipe.Exec(ctx)
```

```go
RedisPipeLine(pool string) *RedisPipeLine
```

**Every call to `ctx.RedisPipeLine()` creates a new pipeline** and registers it on the context. Read commands return a result object whose `Result()` must be called **after** `Exec`:

```go
pipe := ctx.RedisPipeLine(fluxaorm.DefaultPoolCode)
c1 := pipe.Get("k1")
c2 := pipe.Get("missing")
count := pipe.HIncrBy("user:1", "visits", 1)
_, err := pipe.Exec(ctx)
if err != nil {
    panic(err)
}
v, has, err := c1.Result()      // "v1", true, nil
v, has, err = c2.Result()       // "", false, nil
n, err := count.Result()        // 1, nil
```

### Pipeline commands

| Method | Returns |
|--------|---------|
| `Set(key string, value any, expiration time.Duration)` | -- |
| `Get(key string)` | `*PipeLineGet` -- `Result() (value string, has bool, err error)` |
| `MSet(pairs ...any)` | -- |
| `Del(key ...string)` | -- |
| `Expire(key string, expiration time.Duration)` | `*PipeLineBool` -- `Result() (bool, error)` |
| `LPush(key string, values ...any)` | -- |
| `RPush(key string, values ...any)` | -- |
| `LRange(key string, start, stop int64)` | `*PipeLineSlice` -- `Result() ([]string, error)` |
| `LRangeValue(key string, start, stop int64)` | `PipeLineSlice` by value (same `Result()`); used by generated code to avoid one allocation per key |
| `LRangeBatchInto(results []PipeLineSlice, keys []string, start, stop int64)` | -- ; queues one `LRANGE` per key and fills the caller-owned `results` slice (must have `len(keys)` elements, panics otherwise) |
| `HSet(key string, values ...any)` | -- |
| `HDel(key string, values ...string)` | -- |
| `HIncrBy(key, field string, incr int64)` | `*PipeLineInt` -- `Result() (int64, error)` |
| `SAdd(key string, members ...any)` | -- |
| `SRem(key string, members ...any)` | -- |
| `Exec(ctx Context)` | `([]redis.Cmder, error)` |

`Exec` returns an empty slice and `nil` when the pipeline holds no commands, maps `redis.Nil` to `nil`, and resets the pipeline so it can be reused. It is logged as a single `PIPELINE EXEC` entry and every command is observed in metrics with `pipeline="1"`.

### Pipelines and `ctx.Save()`

Pipelines created on a context are tied to that context's unit of work:

- `ctx.Save(...)` executes **all pipelines registered on the context that have not been executed yet**, after the rows are written -- outside a transaction immediately after the SQL statements, inside `ctx.Transaction()` only after the commit succeeds. Generated code relies on this to publish Redis cache and Redis Search writes post-commit.
- When a transaction is rolled back, every pending pipeline is **discarded** without being sent.
- `Exec` drains a pipeline, so calling it yourself is always safe; if you never call it, the next `Save` on the same context will. A `Save` called with no entities returns immediately and leaves the pipelines untouched.

This means you can stage Redis writes that must only become visible when the surrounding transaction commits:

```go
err := ctx.Transaction(func(tx fluxaorm.Context) error {
    user := entities.UserEntityProvider.New(tx)
    user.SetName("Alice")
    if err := tx.Save(user); err != nil {
        return err
    }
    pipe := tx.RedisPipeLine(fluxaorm.DefaultPoolCode)
    pipe.SAdd("users:new", user.GetID())
    return nil // pipe is executed after COMMIT; discarded on rollback
})
```

::: warning
A pipeline registered on a context but never executed (no `Exec`, no `Save`) is never sent. Pipelines are also **not** inherited by `ctx.Clone()`.
:::

See [Transactions](/guide/transactions.html) for the post-commit semantics.

## Database Pipeline

`ctx.DatabasePipeLine(pool)` is the MySQL counterpart: it batches SQL statements and, like Redis pipelines, is executed as part of `ctx.Save()` (inside the same transaction when one is open) and discarded on rollback. It is documented in [MySQL Queries](/guide/mysql_queries.html).
