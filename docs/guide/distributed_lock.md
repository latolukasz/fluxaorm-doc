# Distributed Lock

In some cases, you may need a mechanism to control access to a shared resource from multiple services. While it is easy to limit access to a resource within a single Go application using [sync.Mutex](https://tour.golang.org/concurrency/9), doing so across multiple instances of an application can be more challenging. FluxaORM's `Locker` feature provides a distributed lock backed by Redis. As long as all your application instances have access to the same Redis instance, you can use `Locker` to synchronize access.

## Obtaining a Lock

Get a `Locker` from a Redis pool, then call `Obtain` to acquire a lock:

```go
import (
    "fmt"
    "time"

    "github.com/latolukasz/fluxaorm/v2"
)

locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()

lock, obtained, err := locker.Obtain(ctx, "my-lock", time.Minute, 0)
if err != nil {
    panic(err)
}
if !obtained {
    fmt.Println("lock is already held by another process")
    return
}
defer lock.Release(ctx)

// critical section
fmt.Println("lock acquired, doing work...")
```

The `Obtain` method accepts four arguments:

| Argument | Type | Description |
|----------|------|-------------|
| `ctx` | `fluxaorm.Context` | The FluxaORM context |
| `key` | `string` | Unique name for the lock |
| `ttl` | `time.Duration` | Time to live -- the lock automatically expires after this duration |
| `waitTimeout` | `time.Duration` | How long to wait for the lock. `0` means return immediately if the lock is not available |

`Obtain` returns:
- `lock` -- a `*Lock` object used to release, refresh, or check the lock
- `obtained` -- `true` if the lock was successfully acquired
- `err` -- any error that occurred

::: warning
Always use `defer lock.Release(ctx)` after obtaining a lock. Failing to release a lock will cause it to remain held until its TTL expires, blocking other processes.
:::

::: tip
The `waitTimeout` must not exceed the `ttl`. If it does, `Obtain` returns an error.
:::

## Non-Blocking Lock

When `waitTimeout` is `0`, `Obtain` returns immediately if the lock is already held:

```go
locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()

func testLock(name string) {
    fmt.Printf("GETTING LOCK %s\n", name)
    lock, obtained, err := locker.Obtain(ctx, "test_lock", time.Minute, 0)
    if err != nil {
        panic(err)
    }
    if !obtained {
        fmt.Printf("UNABLE TO GET LOCK %s\n", name)
        return
    }
    defer lock.Release(ctx)
    fmt.Printf("GOT LOCK %s\n", name)
    time.Sleep(time.Second * 2)
    fmt.Printf("RELEASING LOCK %s\n", name)
}
go testLock("A")
go testLock("B")
```

```
GETTING LOCK A
GETTING LOCK B
GOT LOCK A
UNABLE TO GET LOCK B
RELEASING LOCK A
```

## Waiting for a Lock

Pass a non-zero `waitTimeout` to have `Obtain` retry with linear backoff until the lock becomes available or the timeout elapses:

```go
locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()

func testLock(name string) {
    fmt.Printf("GETTING LOCK %s\n", name)
    lock, obtained, err := locker.Obtain(ctx, "test_lock", time.Minute, 5*time.Second)
    if err != nil {
        panic(err)
    }
    if !obtained {
        fmt.Printf("TIMED OUT WAITING FOR LOCK %s\n", name)
        return
    }
    defer lock.Release(ctx)
    fmt.Printf("GOT LOCK %s\n", name)
    time.Sleep(time.Second * 2)
    fmt.Printf("RELEASING LOCK %s\n", name)
}
go testLock("A")
go testLock("B")
```

```
GETTING LOCK A
GETTING LOCK B
GOT LOCK A
RELEASING LOCK A
GOT LOCK B
RELEASING LOCK B
```

## Checking TTL and Refreshing

You can check when a lock will expire using `TTL`, and extend it using `Refresh`:

```go
locker := engine.Redis(fluxaorm.DefaultPoolCode).GetLocker()
lock, obtained, err := locker.Obtain(ctx, "test", 5*time.Second, 0)
if err != nil {
    panic(err)
}
if !obtained {
    return
}
defer lock.Release(ctx)

ttl, err := lock.TTL(ctx)
fmt.Printf("GOT LOCK FOR %d SECONDS\n", int(ttl.Seconds()))

time.Sleep(time.Second)
ttl, err = lock.TTL(ctx)
fmt.Printf("WILL EXPIRE IN %d SECONDS\n", int(ttl.Seconds()))

time.Sleep(time.Second)
ttl, err = lock.TTL(ctx)
fmt.Printf("WILL EXPIRE IN %d SECONDS\n", int(ttl.Seconds()))

// Extend the lock by 2 more seconds
ok, err := lock.Refresh(ctx, 2*time.Second)
if err != nil {
    panic(err)
}
if !ok {
    fmt.Println("LOST LOCK")
    return
}

ttl, err = lock.TTL(ctx)
fmt.Printf("WILL EXPIRE IN %d SECONDS\n", int(ttl.Seconds()))
```

```
GOT LOCK FOR 5 SECONDS
WILL EXPIRE IN 4 SECONDS
WILL EXPIRE IN 3 SECONDS
WILL EXPIRE IN 5 SECONDS
```

## Lock API Reference

### `Locker`

Obtained via `engine.Redis(poolCode).GetLocker()`.

| Method | Signature | Description |
|--------|-----------|-------------|
| `Obtain` | `Obtain(ctx Context, key string, ttl time.Duration, waitTimeout time.Duration) (*Lock, bool, error)` | Attempt to acquire a distributed lock |

### `Lock`

Returned by a successful `Obtain` call.

| Method | Signature | Description |
|--------|-----------|-------------|
| `Release` | `Release(ctx Context)` | Release the lock. Safe to call even if the lock has already been released or lost. |
| `TTL` | `TTL(ctx Context) (time.Duration, error)` | Get the remaining time to live of the lock |
| `Refresh` | `Refresh(ctx Context, ttl time.Duration) (bool, error)` | Extend the lock's TTL. Returns `false` if the lock was already lost. |
