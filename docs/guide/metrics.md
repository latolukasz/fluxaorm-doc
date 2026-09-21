---
description: "Prometheus metrics in FluxaORM for MySQL, Redis, ClickHouse, NATS and consumers: enabling them, metric names, labels and buckets."
---

# Metrics

FluxaORM exposes Prometheus metrics for MySQL queries, Redis commands, ClickHouse queries, NATS operations and stream consumers. Metrics are disabled by default and cost nothing until you enable them.

## Enabling Metrics

Pass a `promauto.Factory` to the registry with `EnableMetrics` **before** calling `Validate()`. The metric vectors are created inside `Validate()`, so enabling metrics afterwards has no effect.

```go
import (
    "net/http"

    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"
    "github.com/prometheus/client_golang/prometheus/promhttp"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, &fluxaorm.MySQLOptions{})
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)

    factory := promauto.With(prometheus.DefaultRegisterer)
    registry.EnableMetrics(factory)

    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }

    // expose everything registered in prometheus.DefaultRegisterer
    http.Handle("/metrics", promhttp.Handler())
    _ = engine
}
```

The signature is:

```go
EnableMetrics(factory promauto.Factory)
```

Use `promauto.With(registerer)` to target a custom registerer, e.g. `prometheus.WrapRegistererWith(prometheus.Labels{"app": "api"}, prometheus.DefaultRegisterer)` to add constant labels to every FluxaORM metric.

## The `source` Label

Every metric except the consumer ones carries a `source` label. It defaults to `"default"` and is read from the context metadata key `fluxaorm.MetricsMetaKey`:

```go
ctx.SetMetaData(fluxaorm.MetricsMetaKey, "checkout_api")
```

All queries executed through `ctx` (and through contexts created with `ctx.Clone()` / `ctx.CloneWithContext()`, which copy the metadata) are then tagged `source="checkout_api"`.

Task consumers set the tag automatically: before a task handler runs, the consumer calls `SetMetaData(MetricsMetaKey, taskName)` on the handler's context, so every MySQL, Redis, ClickHouse and NATS metric emitted while handling a task carries `source="<task name>"`. See [Tasks](/guide/tasks.html).

## MySQL Metrics

### `fluxaorm_db_queries_seconds` (Histogram)

Help: `Total number of DB queries executed`. Default Prometheus buckets.

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `transaction`, `exec`, `select` | `transaction` = `START TRANSACTION`, `COMMIT`, `ROLLBACK`; `exec` = `DB.Exec` (and every generated INSERT/UPDATE/DELETE); `select` = `DB.QueryRow` and `DB.Query` |
| `pool` | MySQL pool code | e.g. `"default"` |
| `source` | source tag | see above |

### `fluxaorm_db_queries_errors` (Counter)

Help: `Total number of DB queries errors`. Incremented when a MySQL query returns an error.

| Label | Description |
|-------|-------------|
| `pool` | MySQL pool code |
| `source` | source tag |

## Redis Metrics

### `fluxaorm_redis_queries_seconds` (Histogram)

Help: `Total number of Redis queries executed`. Default Prometheus buckets. One observation per command executed through the [FluxaORM Redis client](/guide/redis_operations.html), including commands issued by generated code (Redis cache, Redis Search) and by the [distributed lock](/guide/distributed_lock.html).

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `key`, `list`, `hash`, `set`, `stream`, `search`, `lock`, `other` | Command category (see table below) |
| `pool` | Redis pool code | e.g. `"default"` |
| `set` | `0`, `1` | `1` for write commands |
| `miss` | `0`, `1` | `1` when a read did not find the key/field |
| `pipeline` | `0`, `1` | `1` when the command was executed through `ctx.RedisPipeLine()` |
| `source` | source tag | see above |

Operation categories and which methods report `set="1"`:

| `operation` | Methods | `set="1"` for |
|-------------|---------|---------------|
| `key` | `Get`, `Set`, `SetNX`, `MSet`, `MGet`, `Del`, `Exists`, `Type`, `Expire`, `Incr`, `IncrBy`, `IncrWithExpire` | `Set`, `SetNX`, `MSet`, `Del`, `Expire`, `Incr`, `IncrBy`, `IncrWithExpire` |
| `list` | `LPush`, `RPush`, `LPop`, `RPop`, `LLen`, `LRange`, `LIndex`, `LSet`, `LRem`, `Ltrim`, `LMove`, `BLMove` | `LPush`, `RPush`, `LSet`, `LMove`, `BLMove` |
| `hash` | `HSet`, `HSetNx`, `HDel`, `HGet`, `HMGet`, `HGetAll`, `HLen`, `HIncrBy` | `HSet`, `HSetNx`, `HDel`, `HIncrBy` |
| `set` | `SAdd`, `SMembers`, `SIsMember`, `SCard`, `SPop`, `SPopN`, `ZAdd`, `ZCard`, `ZCount`, `ZScore`, `ZRevRange`, `ZRevRangeWithScores`, `ZRangeWithScores`, `ZRangeArgsWithScores` | `SAdd`, `ZAdd` |
| `stream` | `XTrim`, `XRange`, `XRevRange`, `XRead`, `XReadGroup` (only with `Block < 0`), `XLen`, `XInfoStream`, `XInfoGroups`, `XPending`, `XPendingExt`, `XClaim`, `XClaimJustID`, `XAutoClaim`, `XGroupCreate`, `XGroupCreateMkStream`, `XGroupDestroy`, `XGroupDelConsumer`, `XDel`, `XAck`, `XAckDel` | `XGroupCreate`, `XGroupCreateMkStream`, `XGroupDestroy`, `XGroupDelConsumer`, `XDel`, `XAck`, `XAckDel` |
| `search` | `FTList`, `FTSearch`, `FTInfo`, `FTCreate`, `FTDrop` | `FTCreate`, `FTDrop` |
| `lock` | `Locker.Obtain`, `Lock.Release`, `Lock.TTL`, `Lock.Refresh` | always `1` |
| `other` | `Info`, `Eval`, `EvalSha`, `ScriptLoad`, `ScriptExists`, `Scan`, `FlushDB`, `FlushAll` | `FlushDB`, `FlushAll` |

`miss="1"` is reported by `Get` when the key does not exist, by `HGet` when the field does not exist, and by `MGet` / `HMGet` when at least one requested value is `nil`. All other reads report `miss="0"`.

::: warning
For `operation="lock"` the `miss` label is inverted compared to the other categories: a successful `Obtain`, `Release`, `TTL` or `Refresh` is recorded with `miss="1"`, and an `Obtain` that did **not** get the lock is recorded with `miss="0"`. Take this into account when writing alerts on lock contention.
:::

`GetSet` is recorded as a `Get` plus, on a miss, a `Set`. `IncrWithExpire` is recorded once as `key` / `set="1"`. `XReadGroup` with `Block >= 0` is **not** observed here at all (see `fluxaorm_redis_queries_block`).

#### Pipelines

When a [Redis pipeline](/guide/redis_operations.html#redis-pipelines) is executed, every command in it gets **one observation** with `pipeline="1"` and a duration equal to the whole `Exec` time divided by the number of commands. The category is derived from the command name:

| Command | `operation` | `set` |
|---------|-------------|-------|
| `get` | `key` | `0` (`miss="1"` when the key was absent) |
| `set`, `del`, `mset`, `expire` | `key` | `1` |
| `lpush`, `rpush` | `list` | `1` |
| `lrange` | `list` | `0` |
| `sadd`, `srem` | `set` | `1` |
| `hset`, `hdel`, `hincrby` | `hash` | `1` |
| anything else | `key` | `0` |

### `fluxaorm_redis_queries_block` (Counter)

Help: `Total number of Redis blocking queries executed`. Incremented **only** by `XReadGroup` when `XReadGroupArgs.Block >= 0` (note that the zero value of `Block` counts as blocking). Such calls are not timed and do not appear in `fluxaorm_redis_queries_seconds`.

| Label | Values |
|-------|--------|
| `operation` | always `stream` |
| `pool` | Redis pool code |
| `source` | source tag |

### `fluxaorm_redis_queries_errors` (Counter)

Help: `Total number of Redis queries errors`. Incremented when a Redis command (including a pipeline `Exec` or a lock operation) returns an error.

| Label | Description |
|-------|-------------|
| `pool` | Redis pool code |
| `source` | source tag |

## ClickHouse Metrics

### `fluxaorm_clickhouse_queries_seconds` (Histogram)

Help: `Total number of ClickHouse queries executed`. Default Prometheus buckets.

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `exec`, `select` | `exec` = `Clickhouse.Exec`; `select` = `Clickhouse.QueryRow` and `Clickhouse.Query` |
| `pool` | ClickHouse pool code | e.g. `"analytics"` |
| `source` | source tag | see above |

### `fluxaorm_clickhouse_queries_errors` (Counter)

Help: `Total number of ClickHouse queries errors`.

| Label | Description |
|-------|-------------|
| `pool` | ClickHouse pool code |
| `source` | source tag |

## NATS Metrics

See [NATS](/guide/nats.html) for the publisher and consumer API.

### `fluxaorm_nats_operations_seconds` (Histogram)

Help: `Total number of NATS operations executed`. Default Prometheus buckets.

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `publish`, `publish_async`, `fetch` | `publish` = `Publish`, `PublishWithAck` and `PublishBatch` (one observation per batch); `publish_async` = `PublishAsync` (observed when the ack arrives, or immediately on a publish error); `fetch` = consumer `Fetch` |
| `pool` | NATS pool code | |
| `source` | source tag | |
| `consumer` | durable consumer name, or `""` | Empty for publish operations, the consumer name for `fetch` |

### `fluxaorm_nats_operations_errors` (Counter)

Help: `Total number of NATS operation errors`.

| Label | Description |
|-------|-------------|
| `pool` | NATS pool code |
| `source` | source tag |
| `consumer` | durable consumer name, `""` for publish operations |

### `fluxaorm_nats_publish_batch_size` (Histogram)

Help: `Number of messages per batched NATS publish`. Buckets: `prometheus.ExponentialBuckets(1, 2, 12)` (1, 2, 4, ... 2048). Observed once per `PublishBatch` call with the number of messages in the batch. Use it to check whether batching actually amortises round trips.

| Label | Description |
|-------|-------------|
| `pool` | NATS pool code |
| `source` | source tag |

## Consumer Metrics

These are emitted by [consumers](/guide/consumers.html) reading [entity events](/guide/entity_events.html) from JetStream. They have no `source` label.

### `fluxaorm_cdc_messages_total` (Counter)

Help: `Total number of entity change events fetched from JetStream`. Incremented once per entity-change message fetched by a consumer, before the handler runs.

| Label | Values | Description |
|-------|--------|-------------|
| `consumer` | `ConsumerDef.Name` | The consumer that fetched the message |
| `entity` | entity name | The entity the change belongs to |
| `op` | `insert`, `update`, `delete`, `unknown` | Parsed from the message's dirty-op header; `unknown` when the header is missing or malformed |

### `fluxaorm_stream_consume_lag_seconds` (Histogram)

Help: `Time from publish (JetStream broker timestamp) to consume, per consumer`. Buckets: `prometheus.ExponentialBuckets(0.001, 4, 10)` (1ms to about 262s). Observed per fetched entity-change message as `time.Since(msg.Timestamp)`, skipped when the broker timestamp is zero.

| Label | Description |
|-------|-------------|
| `consumer` | `ConsumerDef.Name` |

## Summary

| Metric | Type | Labels |
|--------|------|--------|
| `fluxaorm_db_queries_seconds` | Histogram | `operation`, `pool`, `source` |
| `fluxaorm_db_queries_errors` | Counter | `pool`, `source` |
| `fluxaorm_redis_queries_seconds` | Histogram | `operation`, `pool`, `set`, `miss`, `pipeline`, `source` |
| `fluxaorm_redis_queries_block` | Counter | `operation`, `pool`, `source` |
| `fluxaorm_redis_queries_errors` | Counter | `pool`, `source` |
| `fluxaorm_clickhouse_queries_seconds` | Histogram | `operation`, `pool`, `source` |
| `fluxaorm_clickhouse_queries_errors` | Counter | `pool`, `source` |
| `fluxaorm_nats_operations_seconds` | Histogram | `operation`, `pool`, `source`, `consumer` |
| `fluxaorm_nats_operations_errors` | Counter | `pool`, `source`, `consumer` |
| `fluxaorm_nats_publish_batch_size` | Histogram | `pool`, `source` |
| `fluxaorm_cdc_messages_total` | Counter | `consumer`, `entity`, `op` |
| `fluxaorm_stream_consume_lag_seconds` | Histogram | `consumer` |
