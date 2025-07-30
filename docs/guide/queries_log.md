# Queries Log

You can log all MySQL, Redis, and local cache queries by registering a logger using the `RegisterQueryLogger()` method of `orm.ORM`:

```go{7}
type MyLogger struct{}

func (l *MyLogger) Handle(log map[string]interface{}) {
	fmt.Printf("QUERY %s in %s", log["query"], log["source"])
}

c.RegisterQueryLogger(&MyLogger{}, true, true, true)
```

This method requires an implementation of the `orm.LogHandler` interface:

```go
type LogHandler interface {
	Handle(log map[string]interface{})
}
```

The `log` map attribute provides the following fields:

| key        | value type         | description  |
| :------------- |:-------------| :-----|
| source      | string  | `mysql` or `redis` or `local_cache`  |
| pool      | string  | [data pool](/guide/data_pools.html#mysql-pool) name  |
| query      | string  | full query  |
| operation      | string  | short label of query  |
| microseconds      | int64  | query time  |
| started      | int64  | Unix timestamp (nanoseconds) when the query started  |
| finished      | int64  | Unix timestamp (nanoseconds) when the query finished  |
| error      | string  | query error, if the query returned an error  |

Queries to the [local cache](/guide/local_cache.html) are very fast, which is why the query log for this cache layer does not provide the microseconds, started, and finished keys.

You can specify which queries should be logged by setting the respective boolean arguments in the `engine.RegisterQueryLogger()` method:

```go
// only queries to MySQL
c.RegisterQueryLogger(&MyLogger{}, true, false, false)
// only queries to redis
c.RegisterQueryLogger(&MyLogger{}, false, true, false)
// only queries to local cache
c.RegisterQueryLogger(&MyLogger{}, false, false, true)
```