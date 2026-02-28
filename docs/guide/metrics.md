# Metrics

FluxaORM provides Prometheus metrics for MySQL queries and Redis commands that you can use to monitor database and Redis usage.

## Enabling Metrics

By default, metrics are disabled. To enable metrics, provide a `promauto.Factory` from the Prometheus client library to the registry:

```go
import (
    "github.com/prometheus/client_golang/prometheus"
    "github.com/prometheus/client_golang/prometheus/promauto"

    "github.com/latolukasz/fluxaorm/v2"
)

func main() {
    registry := fluxaorm.NewRegistry()

    registerer := prometheus.WrapRegistererWith(map[string]string{}, prometheus.DefaultRegisterer)
    factory := promauto.With(registerer)

    registry.EnableMetrics(factory)
}
```

## MySQL Metrics

### `fluxaorm_db_queries_seconds` (Histogram)

Tracks the duration of all DB queries.

```
# HELP Total number of DB queries executed
# TYPE fluxaorm_db_queries_seconds histogram
fluxaorm_db_queries_seconds{le="0.005",operation="exec",pool="default",source="default"} 100
...
fluxaorm_db_queries_seconds_sum{operation="exec",pool="default",source="default"} 12.345
fluxaorm_db_queries_seconds_count{operation="exec",pool="default",source="default"} 500
```

**Labels:**

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `transaction`, `select`, `exec` | Type of SQL operation |
| `pool` | pool code string | The MySQL pool code (e.g. `"default"`) |
| `source` | source string | Metrics source tag (default: `"default"`) |

The `operation` label values:
- `transaction` -- BEGIN, COMMIT, ROLLBACK
- `select` -- SELECT queries
- `exec` -- INSERT, UPDATE, DELETE queries

### `fluxaorm_db_queries_errors` (Counter)

Counts the total number of DB query errors.

```
# HELP Total number of DB queries errors
# TYPE fluxaorm_db_queries_errors counter
fluxaorm_db_queries_errors{pool="default",source="default"} 123
```

**Labels:**

| Label | Values | Description |
|-------|--------|-------------|
| `pool` | pool code string | The MySQL pool code |
| `source` | source string | Metrics source tag |

## Redis Metrics

### `fluxaorm_redis_queries_seconds` (Histogram)

Tracks the duration of all Redis queries.

```
# HELP Total number of Redis queries executed
# TYPE fluxaorm_redis_queries_seconds histogram
fluxaorm_redis_queries_seconds{le="0.005",operation="key",pool="default",set="1",miss="0",pipeline="0",source="default"} 100
...
fluxaorm_redis_queries_seconds_sum{operation="key",pool="default",set="1",miss="0",pipeline="0",source="default"} 12.345
fluxaorm_redis_queries_seconds_count{operation="key",pool="default",set="1",miss="0",pipeline="0",source="default"} 500
```

**Labels:**

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | `key`, `list`, `hash`, `set`, `stream`, `search`, `lock`, `other` | Category of Redis command |
| `pool` | pool code string | The Redis pool code (e.g. `"default"`) |
| `set` | `0`, `1` | `1` if the operation writes data, `0` if it reads |
| `miss` | `0`, `1` | `1` if a read operation missed (key not found), `0` otherwise |
| `pipeline` | `0`, `1` | `1` if executed inside a pipeline, `0` otherwise |
| `source` | source string | Metrics source tag (default: `"default"`) |

The `operation` label values:
- `key` -- GET, SET, MSET, MGET, DEL, EXISTS, SETNX, INCR, INCRBY, EXPIRE, ...
- `list` -- LPUSH, RPUSH, LPOP, RPOP, LLEN, LRANGE, LINDEX, LSET, LMOVE, BLMOVE, LREM, LTRIM, ...
- `hash` -- HSET, HDEL, HGET, HMGET, HGETALL, HLEN, HINCRBY, HSETNX, ...
- `set` -- ZADD, ZCARD, ZCOUNT, ZSCORE, ZREVRANGE, ZRANGEWITHSCORES, SADD, SMEMBERS, SISMEMBER, SCARD, SPOP, ...
- `stream` -- XADD, XTRIM, XRANGE, XREVRANGE, XLEN, XREAD, XREADGROUP, XACK, XDEL, XINFO, XPENDING, XCLAIM, XAUTOCLAIM, ...
- `search` -- FT.LIST, FT.SEARCH, FT.CREATE, FT.INFO, FT.DROPINDEX, ...
- `lock` -- LOCK OBTAIN, LOCK RELEASE, LOCK TTL, LOCK REFRESH
- `other` -- INFO, EVAL, EVALSHA, SCRIPTLOAD, SCRIPTEXISTS, FLUSHALL, FLUSHDB, SCAN, ...

### `fluxaorm_redis_queries_block` (Counter)

Counts the total number of blocking Redis queries (e.g. blocking `XREADGROUP` calls with a positive block time).

```
# HELP Total number of Redis blocking queries executed
# TYPE fluxaorm_redis_queries_block counter
fluxaorm_redis_queries_block{operation="stream",pool="default",source="default"} 42
```

**Labels:**

| Label | Values | Description |
|-------|--------|-------------|
| `operation` | operation string | The operation type (e.g. `"stream"`) |
| `pool` | pool code string | The Redis pool code |
| `source` | source string | Metrics source tag |

### `fluxaorm_redis_queries_errors` (Counter)

Counts the total number of Redis query errors.

```
# HELP Total number of Redis queries errors
# TYPE fluxaorm_redis_queries_errors counter
fluxaorm_redis_queries_errors{pool="default",source="default"} 123
```

**Labels:**

| Label | Values | Description |
|-------|--------|-------------|
| `pool` | pool code string | The Redis pool code |
| `source` | source string | Metrics source tag |

## Changing the Metrics Source

Every metric includes a `source` label. By default it is set to `"default"`.
You can change it by setting the `MetricsMetaKey` metadata on the context:

```go
ctx.SetMetaData(fluxaorm.MetricsMetaKey, "my_source")
```

After setting this, all subsequent queries executed through `ctx` will be tagged with `source="my_source"`:

```
fluxaorm_db_queries_seconds{le="0.005",operation="exec",pool="default",source="my_source"} 100
```

## Summary of All Metrics

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `fluxaorm_db_queries_seconds` | Histogram | `operation`, `pool`, `source` | Duration of DB queries |
| `fluxaorm_db_queries_errors` | Counter | `pool`, `source` | Count of DB query errors |
| `fluxaorm_redis_queries_seconds` | Histogram | `operation`, `pool`, `set`, `miss`, `pipeline`, `source` | Duration of Redis queries |
| `fluxaorm_redis_queries_block` | Counter | `operation`, `pool`, `source` | Count of blocking Redis queries |
| `fluxaorm_redis_queries_errors` | Counter | `pool`, `source` | Count of Redis query errors |
