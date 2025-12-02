# Distributed Lock

In some cases, you may need a mechanism to control access to a shared resource from multiple services. While it is easy to limit access to a resource within a single Go application using [sync.Mutex](https://tour.golang.org/concurrency/9), doing so across multiple instances of an application can be more challenging. FluxaORM's `Locker` feature can help you create a shared, distributed lock to solve this problem. Behind the scenes, Locker uses Redis, so as long as all your application instances have access to the same Redis instance, you can use Locker to implement a distributed lock:

```go{
locker := engine.Redis(orm.DefaultPoolCode).GetLocker()

func testLock(name string) {
    fmt.Printf("GETTING LOCK %s\n", name)
    // trying to obtain lock for one minute, do not wait if lock in in use already
    lock, obtained, err := locker.Obtain(orm, "test_lock", time.Minute, 0)
    if !obtained {
        fmt.Printf("UNABLE TO GET LOCK %s\n", name)
        return
    }
    defer lock.Release(orm)
    fmt.Printf("GOT LOCK %s\n", name)
    sleep(time.Second * 2)
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

:::warning
Be sure to use defer `locker.Unlock()` whenever you obtain a lock. Failing to do so will cause the distributed lock to remain in place until its Time to Live (TTL) expires.
:::

In the example above, we request a lock with the name `lock-name` that will expire after 60 seconds. The third argument to `Obtain()`, `waitTimeout`, is set to 0, which means that `Obtain()` will not wait for the lock and will return immediately with obtained set to false if the lock is not available.

Here is an example that demonstrates how to instruct the locker to wait up to 5 seconds for the lock to become available:

```go
locker := engine.Redis(orm.DefaultPoolCode).GetLocker()

func testLock(name string) {
    fmt.Printf("GETTING LOCK %s\n", name)
    lock, obtained, err := locker.Obtain(orm, "test_lock", time.Minute, time.Second * 5)
    if obtained {
        defer lock.Release(orm)
        fmt.Printf("GOT LOCK %s\n", name)
        sleep(time.Second * 2)
        fmt.Printf("RELEASING LOCK %s\n", name)
    }
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

You can also check when an obtained lock will expire and extend it if needed:

```go
locker := engine.Redis(orm.DefaultPoolCode).GetLocker()
lock, obtained, err := locker.Obtain(orm, "test", time.Second * 5, 0)
if obtained {
    defer lock.Release(orm)
    ttl, err := lock.TTL(orm)
    fmt.Printf("GOT LOCK FOR %d SECONDS\n", ttl.Seconds())
    sleep(time.Second)
    ttl, err = lock.TTL(orm)
    fmt.Printf("WILL EXPIRE IN %d SECONDS\n", ttl.Seconds())
    sleep(time.Second)
    ttl, err = lock.TTL(orm)
    fmt.Printf("WILL EXPIRE IN %d SECONDS\n", ttl.Seconds())
    if !lock.Refresh(orm, time.Second * 2) {
        fmt.Println("LOST LOCK")
        return
    }
    ttl, err = lock.TTL(orm)
    fmt.Printf("WILL EXPIRE IN %d SECONDS\n", ttl.Seconds())  
}
```

```
GOT LOCK FOR 5 SECONDS
WILL EXPIRE IN 4 SECONDS
WILL EXPIRE IN 3 SECONDS
WILL EXPIRE IN 5 SECONDS
```
