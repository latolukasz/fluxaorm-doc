# Local Cache

In this section, you will learn how to use the local cache to store data in the application's memory.

First, we need to configure the data pools and engine. In this example, we will create two pools: `default`,
without any limit, and `test`, which can hold up to 100 elements:

```go
import fluxaorm "github.com/latolukasz/fluxaorm/v2"

registry := fluxaorm.NewRegistry()
registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 0)
registry.RegisterLocalCache("test", 100)
engine, err := registry.Validate()
if err != nil {
    panic(err)
}
ctx := engine.NewContext(context.Background())
```

When `limit` is `0`, the cache has no size limit and will grow unbounded. When `limit` is greater than `0`, the cache uses an LRU (Least Recently Used) eviction policy -- once the limit is reached, the least recently used entry is evicted to make room for a new one.

## Accessing the Local Cache Data Pool

Access the local cache through the engine:

```go
cache := engine.LocalCache(fluxaorm.DefaultPoolCode)
config := cache.GetConfig()
config.GetCode()  // "default"
config.GetLimit() // 0

cache = engine.LocalCache("test")
config = cache.GetConfig()
config.GetCode()  // "test"
config.GetLimit() // 100
```

## LocalCache Interface

The `LocalCache` interface provides the following public methods:

| Method | Description |
|--------|-------------|
| `Get(ctx, key) (value, ok)` | Retrieves a value by key |
| `Set(ctx, key, value)` | Stores a value with the given key |
| `Remove(ctx, key)` | Removes a value by key |
| `Clear(ctx)` | Removes all values from the cache |
| `GetConfig() LocalCacheConfig` | Returns the cache configuration |
| `GetUsage() []LocalCacheUsage` | Returns current cache usage statistics |

## Retrieving a Value

Use the `Get()` method to retrieve a single value from the local cache:

```go
cache := engine.LocalCache(fluxaorm.DefaultPoolCode)
value, found := cache.Get(ctx, "test-key")
if found {
    fmt.Printf("Found: %v\n", value)
} else {
    fmt.Println("Not found")
}
```

## Storing a Value

Use the `Set()` method to store a value in the local cache. The value can be of any type:

```go
cache := engine.LocalCache(fluxaorm.DefaultPoolCode)
cache.Set(ctx, "test-key", "my value")

cache = engine.LocalCache("test")
cache.Set(ctx, "another-key", &SomeStruct{Field: "hello"})
```

When using a cache with a limit, if the cache is full, the least recently used entry is automatically evicted.

## Removing a Value

Use the `Remove()` method to remove a value from the local cache:

```go
cache.Remove(ctx, "key1")
```

## Clearing the Cache

Use the `Clear()` method to remove all values from the local cache:

```go
cache.Clear(ctx)
```

## Cache Usage Statistics

Use the `GetUsage()` method to inspect the current state of the cache. It returns a slice of `LocalCacheUsage` structs:

```go
cache := engine.LocalCache("test")
usages := cache.GetUsage()
for _, usage := range usages {
    fmt.Printf("Type: %s, Used: %d, Limit: %d, Evictions: %d\n",
        usage.Type, usage.Used, usage.Limit, usage.Evictions)
}
```

The `LocalCacheUsage` struct contains:

| Field | Type | Description |
|-------|------|-------------|
| `Type` | `string` | The type of cache partition (e.g. `"Global"`, `"Entities UserEntity"`) |
| `Limit` | `uint64` | The configured maximum number of entries (`0` means unlimited) |
| `Used` | `uint64` | The current number of entries stored |
| `Evictions` | `uint64` | The total number of entries evicted due to the LRU policy |

For a global (non-entity) local cache, `GetUsage()` returns a single entry with `Type` set to `"Global"`. For entity-bound caches, it returns separate entries for entities and each list reference.
