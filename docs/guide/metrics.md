# Metrics

FluxaORM provides metrics for MySQL queries and Redis commands that you can use to monitor database and redis usage.

## Enabling metrics

By default metrics are disabled. To enable metrics you need to provide 
`github.com/prometheus/client_golang/prometheus/promauto.Proto` factory to registry:


```go{12}
import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

func main() {
    registry := fluxaorm.NewRegistry()
    
    registerer := prometheus.WrapRegistererWith(map[string]string{}, prometheus.DefaultRegisterer)
	factory := promauto.With(registerer)
	
	registry.EnableMetrics(factory)
}
```

## MySQL metrics

```
# HELP Total number of DB queries executed
# TYPE fluxaorm_db_queries_seconds histogram
fluxaorm_db_queries_seconds{le="0.005",operation="exec",pool="default",source="default"} 100
...
fluxaorm_db_queries_seconds_sum{operation="exec",pool="default",source="default"} 12.345
fluxaorm_db_queries_seconds_count{operation="exec",pool="default",source="default"} 500
```

Label `operation` can be one of: 
 - `transaction` (begin, commit, rollback)
 - `select` (SELECT)
 - `exec` (INSERT, UPDATE, DELETE)

## Redis metrics

```
# HELP Total number of Redis queries executed
# TYPE fluxaorm_redis_queries_seconds histogram
fluxaorm_redis_queries_seconds{le="0.005",operation="stream",pool="default",set="1",miss="0",pipeline="0",source="default"} 100
...
fluxaorm_redis_queries_seconds_sum{operation="stream",pool="default",set="1",miss="0",pipeline="0",source="default"} 12.345
fluxaorm_redis_queries_seconds_count{operation="stream",pool="default",set="1",miss="0",pipeline="0",source="default"} 500
```

Label `operation` can be one of:
- `key` (GET, SET, DEL, ...)
- `list` (LPOP, LPUSH, LLen, ...)
- `hash` (HSET, HDEL, ...)
- `set` (ZAdd, ZCARD, ...)
- `stream` (XADD, XTRIM, ...)
- `search` (FTLIST, FTSEARCH, ...)
- `lock` (LOCK OBRAIN, RELEASE, ...)
- `other` (INFO, FLUSHDB, ...)

Label `set` can be one of:
- `1` operations that add data to Redis (SET, MSET, HSET, XADD, ...) 
- `0` operations that read data from Redis (LPOP, GET, MGET, ...)
 
Label `miss` can be one of:
- `1` read operations that miss data in Redis (GET, MGET, ...)
- `0` other operations

Label `pipeline` can be one of:
- `1` operation executed in pipeline
- `0` operation executed outside pipeline

## Changing metrics source

As you can see every metric has `source` label. By default it is set to `default`.
You can change it by setting special [Context Meta](/guide/orm.html#orm-meta-data):

```go
ctx.SetMetaData(fluxaorm.MetricsMetaKey, "my_source")
```

```
fluxaorm_db_queries_seconds{le="0.005",operation="exec",pool="default",source="my_source"} 100
```


## Metrics for MySQL and Redis

All Database and Redis errors are reported in dedicated counter metrics.

```
# HELP Total number of DB queries errors
# TYPE fluxaorm_db_queries_errors counter
fluxaorm_db_queries_errors{pool="default",source="default"} 123

# HELP Total number of DB queries errors
# TYPE fluxaorm_redis_queries_errors counter
fluxaorm_redis_queries_errors{pool="default",source="default"} 123
```


 
