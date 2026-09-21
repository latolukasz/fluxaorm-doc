---
description: "Redis-backed distributed locks in FluxaORM: Obtain, Refresh, TTL and Release with retry strategy, logging and metrics."
---

# Distributed Lock

A `sync.Mutex` only protects a resource inside one process. When several instances of your application must coordinate, FluxaORM provides a distributed lock backed by Redis (implemented with [bsm/redislock](https://github.com/bsm/redislock)). Every instance that shares the same Redis pool can use it.

## Obtaining a Lock

Get the `Locker` of a Redis pool and call `Obtain`:

```go
import (
    "fmt"
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()

lock, obtained, err := locker.Obtain(ctx, "report:daily", time.Minute, 0)
if err != nil {
    panic(err)
}
if !obtained {
    fmt.Println("another instance holds the lock")
    return
}
defer lock.Release(ctx)

// critical section
```

```go
Obtain(ctx Context, key string, ttl time.Duration, waitTimeout time.Duration) (lock *Lock, obtained bool, err error)
```

| Argument | Description |
|----------|-------------|
| `key` | Redis key of the lock. Use a unique name per protected resource |
| `ttl` | Lifetime of the lock. It expires automatically after this duration unless refreshed |
| `waitTimeout` | How long to keep retrying when the lock is held by someone else. `0` = a single attempt |

| Return | Description |
|--------|-------------|
| `lock` | `*Lock` used to release, refresh or inspect the lock. `nil` when `obtained` is `false` |
| `obtained` | `true` when the lock was acquired |
| `err` | Validation error or Redis error. A lock held by another process is **not** an error: `Obtain` returns `(nil, false, nil)` |

`Obtain` validates its arguments before touching Redis:

| Condition | Error |
|-----------|-------|
| `ttl == 0` | `ttl must be higher than zero` |
| `waitTimeout > ttl` | `waitTimeout can't be higher than ttl` |

::: warning
Always check `obtained` before using `lock`, and always `defer lock.Release(ctx)` once you have it. An unreleased lock blocks every other instance until the `ttl` elapses.
:::

`GetLocker()` is part of the `RedisCache` interface; one `Locker` is created lazily per Redis pool and reused.

## Non-Blocking Lock

With `waitTimeout == 0` the lock is attempted exactly once:

```go
locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()

func work(name string) {
    lock, obtained, err := locker.Obtain(ctx, "job", time.Minute, 0)
    if err != nil {
        panic(err)
    }
    if !obtained {
        fmt.Printf("%s: lock busy\n", name)
        return
    }
    defer lock.Release(ctx)
    fmt.Printf("%s: got lock\n", name)
    time.Sleep(2 * time.Second)
}
go work("A")
go work("B")
```

```
A: got lock
B: lock busy
```

## Waiting for a Lock

With `waitTimeout > 0`, `Obtain` retries at a fixed interval until it succeeds or the retries are exhausted:

- `waitTimeout < 1s`: one retry after `waitTimeout`.
- `waitTimeout >= 1s`: a retry every **1 second**, `int(waitTimeout / time.Second)` times (the fraction of a second is dropped: `1500 * time.Millisecond` gives a single retry after 1s).

```go
lock, obtained, err := locker.Obtain(ctx, "job", time.Minute, 5*time.Second)
if err != nil {
    panic(err)
}
if !obtained {
    fmt.Println("gave up after 5 retries")
    return
}
defer lock.Release(ctx)
```

With two goroutines competing as in the previous example, the second one obtains the lock about a second after the first releases it:

```
A: got lock
B: got lock
```

## TTL and Refresh

`TTL` returns how long the lock still lives; `Refresh` **sets** the remaining lifetime to the given value (it does not add to it):

```go
lock, obtained, err := locker.Obtain(ctx, "job", 5*time.Second, 0)
if err != nil || !obtained {
    return
}
defer lock.Release(ctx)

ttl, _ := lock.TTL(ctx)
fmt.Printf("expires in %d seconds\n", int(ttl.Seconds())) // expires in 4 seconds (rounded down)

time.Sleep(2 * time.Second)

// the lock now has ~3s left; set it back to 10s
ok, err := lock.Refresh(ctx, 10*time.Second)
if err != nil {
    panic(err)
}
if !ok {
    fmt.Println("lock lost")
    return
}
ttl, _ = lock.TTL(ctx)
fmt.Printf("expires in %d seconds\n", int(ttl.Seconds())) // expires in 9 seconds
```

`Refresh` returns `false, nil` when the lock has already expired or been released (Redis no longer holds our token); the `Lock` is then marked as lost and further `Refresh` calls return `false` immediately.

## API Reference

### `Locker`

Returned by `engine.Redis(poolCode).GetLocker()`.

| Method | Description |
|--------|-------------|
| `Obtain(ctx Context, key string, ttl time.Duration, waitTimeout time.Duration) (lock *Lock, obtained bool, err error)` | Acquire the lock, see above |

### `Lock`

| Method | Description |
|--------|-------------|
| `Release(ctx Context)` | Releases the lock. Idempotent: the second and later calls do nothing, and releasing a lock that already expired is silently ignored. The `DEL` is sent with a background context, so it still runs when `ctx.Context()` is already cancelled |
| `TTL(ctx Context) (time.Duration, error)` | Remaining lifetime. `0` when the lock is not held any more |
| `Refresh(ctx Context, ttl time.Duration) (bool, error)` | Sets the remaining lifetime to `ttl`. Returns `false, nil` when the lock was lost or already released |

## Logging and Metrics

Lock operations go through the Redis [query log](/guide/queries_log.html) with operations `LOCK OBTAIN`, `LOCK RELEASE`, `LOCK TTL` and `LOCK REFRESH` (`miss="TRUE"` when a lock was not obtained, not held or lost), and are recorded in the `fluxaorm_redis_queries_seconds` histogram with `operation="lock"` -- see [Metrics](/guide/metrics.html) for the label semantics.
