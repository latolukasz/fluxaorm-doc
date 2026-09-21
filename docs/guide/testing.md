---
description: "Testing with FluxaORM: local Docker services, PrepareTables helpers that reset schema and data, MockDBClient for intercepting SQL and MockLogHandler."
---

# Testing

FluxaORM tests run against real MySQL, Redis and (optionally) NATS services. The `fluxaorm` package ships helpers that wire a registry to the local Docker services, reset the schema and data between tests, and let you intercept SQL calls and query logs.

## Local Services

The ORM repository contains `docker/docker-compose.yml` with MySQL 8.0, Redis 8 (`Validate()` rejects anything older than 8.2), ClickHouse and NATS (JetStream enabled). Ports are taken from environment variables; `docker/.env` provides the defaults the test helpers expect:

```
LOCAL_IP=0.0.0.0
MYSQL_PORT=3397
REDIS_PORT=6395
CLICKHOUSE_PORT=9942
CLICKHOUSE_HTTP_PORT=9943
NATS_PORT=9944
NATS_HTTP_PORT=9945
```

```bash
cd docker
docker compose up -d
```

MySQL is created with user `root` / password `root` and database `test`. Run the test suite with the race detector and without package parallelism (the packages share the same database):

```bash
go test -race -p 1 ./...
# a single test
go test -race -p 1 -run TestUserCRUD ./...
```

## PrepareTables

```go
func PrepareTables(t *testing.T, registry Registry, entities ...any) (orm Context)
```

`PrepareTables` takes a registry you have already customised (metrics, tasks, extra pools) and completes it with the local test services, then resets everything the test touches:

1. `registry.RegisterMySQL("root:root@tcp(localhost:3397)/test", DefaultPoolCode, &MySQLOptions{})`
2. `registry.RegisterRedis("localhost:6395", 0, DefaultPoolCode, nil)`
3. `registry.RegisterRedis("localhost:6395", 1, "second", nil)`
4. `registry.RegisterEntity(entities...)`
5. `registry.Validate()` (the test fails on error)
6. creates a context with `engine.NewContext(context.Background())`
7. `FlushDB` on both Redis pools
8. runs every pending [schema alter](/guide/schema_update.html) (`GetAlters` + `Exec`)
9. for every registered entity: `TruncateTable` and `UpdateSchema`

It returns a ready-to-use `fluxaorm.Context`. Entities are passed exactly as you pass them to `RegisterEntity` -- values (`UserEntity{}`) or pointers both work.

```go
import (
    "testing"

    "github.com/latolukasz/fluxaorm/v2"
)

func TestSomething(t *testing.T) {
    ctx := fluxaorm.PrepareTables(t, fluxaorm.NewRegistry(), UserEntity{}, ProductEntity{})
    // ...
}
```

## PrepareTablesWithNats

```go
func PrepareTablesWithNats(t *testing.T, registry Registry, entities ...any) (orm Context)
```

Same as `PrepareTables`, plus:

- `registry.RegisterNats([]string{"nats://localhost:9944"}, "nats", nil)` -- a NATS pool with code `"nats"`
- after the tables are prepared, all pending [NATS alters](/guide/nats.html) are applied (`GetNatsAlters` + `Exec`), so registered streams and durable consumers exist before the test publishes.

## PrepareTablesWithConsumers

```go
func PrepareTablesWithConsumers(t *testing.T, registry Registry, consumers []ConsumerDef, entities ...any) (orm Context)
```

For tests of [entity events](/guide/entity_events.html), [consumers](/guide/consumers.html) and [tasks](/guide/tasks.html). In addition to `PrepareTablesWithNats` it:

- registers the entity stream and the task stream on the `"nats"` pool (`RegisterEntityStream(EntityStreamOptions{NatsPool: "nats"})`, `RegisterTaskStream(TaskStreamOptions{NatsPool: "nats"})`)
- registers every `ConsumerDef` with `NatsPool` forced to `"nats"`
- purges the entity stream and the task stream after the alters, so messages from a previous run never leak into the test.

Tasks must be registered on the registry **before** calling the helper (a consumer draining a queue with no tasks is a validation error), entities listed in `ConsumerDef.Entities` must be tagged `orm:"cdc"`, and `fluxaorm.JobRunEntity{}` must be registered when tasks are used:

```go
type OrderEntity struct {
    ID     uint64 `orm:"cdc"`
    Number string `orm:"required"`
}

type SendWelcomeEmail struct {
    UserID uint64
}

func TestConsumers(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    registry.RegisterTask(SendWelcomeEmail{}, fluxaorm.TaskOptions{})

    consumers := []fluxaorm.ConsumerDef{
        {Name: "indexer", Entities: []any{OrderEntity{}}},
        {Name: "emails-worker", Queues: []fluxaorm.Queue{fluxaorm.DefaultQueue}},
    }
    ctx := fluxaorm.PrepareTablesWithConsumers(t, registry, consumers, OrderEntity{}, fluxaorm.JobRunEntity{})
    defer ctx.Engine().Nats("nats").Close()
    // ...
}
```

::: tip
Close the NATS pool at the end of a test that opened one (`defer ctx.Engine().Nats("nats").Close()`), otherwise connections accumulate across the package's tests.
:::

## Redis-only Setup

When a test needs only Redis (e.g. the [distributed lock](/guide/distributed_lock.html)), skip the helpers and use a dedicated database number:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterRedis("localhost:6395", 15, fluxaorm.DefaultPoolCode, nil)
engine, err := registry.Validate()
require.NoError(t, err)
ctx := engine.NewContext(context.Background())
require.NoError(t, engine.Redis(fluxaorm.DefaultPoolCode).FlushDB(ctx))
```

## MockDBClient

`MockDBClient` sits between FluxaORM and `database/sql`. It implements `DBClient`; every method whose mock function is `nil` delegates to `OriginDB`, so you only override what you want to intercept:

```go
type MockDBClient struct {
    OriginDB            DBClient
    PrepareMock         func(query string) (*sql.Stmt, error)
    ExecMock            func(query string, args ...any) (sql.Result, error)
    ExecContextMock     func(context context.Context, query string, args ...any) (sql.Result, error)
    QueryRowMock        func(query string, args ...any) *sql.Row
    QueryRowContextMock func(context context.Context, query string, args ...any) *sql.Row
    QueryMock           func(query string, args ...any) (*sql.Rows, error)
    QueryContextMock    func(context context.Context, query string, args ...any) (*sql.Rows, error)
    BeginMock           func() (*sql.Tx, error)
    CommitMock          func() error
    RollbackMock        func() error
}
```

`Begin` delegates to `OriginDB.(DBClientNoTX).Begin()`, so `OriginDB` must be the real pool client returned by `GetDBClient()` -- the mock wraps a live connection, it does not replace it. `PrepareMock`, `CommitMock` and `RollbackMock` are currently not consulted by any method.

Install it with `SetMockDBClient` on the pool's `DB` and restore the original client when the test ends:

```go
func TestInsertFailure(t *testing.T) {
    ctx := fluxaorm.PrepareTables(t, fluxaorm.NewRegistry(), UserEntity{})

    db := ctx.Engine().DB(fluxaorm.DefaultPoolCode)
    origin := db.GetDBClient()
    defer db.SetMockDBClient(origin)

    db.SetMockDBClient(&fluxaorm.MockDBClient{
        OriginDB: origin,
        ExecMock: func(query string, args ...any) (sql.Result, error) {
            if strings.HasPrefix(query, "INSERT") {
                return nil, errors.New("simulated insert failure")
            }
            return origin.Exec(query, args...)
        },
    })

    user := entities.UserEntityProvider.New(ctx)
    user.SetName("Alice")
    err := ctx.Save(user)
    assert.EqualError(t, err, "simulated insert failure")
}
```

The mock also applies inside `ctx.Transaction()`: transactions are opened through the mocked `Begin`, and statements run on the returned `*sql.Tx`.

## MockLogHandler

`MockLogHandler` implements [`LogHandler`](/guide/queries_log.html) and keeps every log entry:

```go
type MockLogHandler struct {
    Logs []map[string]any
}

func (h *MockLogHandler) Handle(_ Context, log map[string]any) // appends to Logs
func (h *MockLogHandler) Clear()                               // Logs = nil
```

It is the easiest way to assert *how* the ORM talked to MySQL or Redis -- for example that a cached read did not hit the database:

```go
logs := &fluxaorm.MockLogHandler{}
ctx.RegisterQueryLogger(logs, fluxaorm.QueryLoggerOptions{MySQL: true})

_, _, err := entities.UserEntityProvider.GetByID(ctx, id)
assert.NoError(t, err)

selects := 0
for _, entry := range logs.Logs {
    if entry["operation"] == "SELECT" {
        selects++
    }
}
assert.Equal(t, 0, selects, "expected the row to come from Redis")
logs.Clear()
```

Because the [context cache](/guide/context_cache.html) answers repeated reads on the same context, use `reader := ctx.Clone(); reader.DisableContextCache()` when you want to prove a read goes to Redis or MySQL.

## Full Example

Assume `UserEntity` is defined in your application package and [code generation](/guide/code_generation.html) produced the `entities` package with `entities.UserEntity` and `entities.UserEntityProvider`:

```go
package myapp

import (
    "testing"

    "github.com/latolukasz/fluxaorm/v2"
    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"

    "myapp/entities"
)

type UserEntity struct {
    ID    uint64 `orm:"redisCache"`
    Name  string `orm:"required"`
    Email string `orm:"required"`
}

func (e UserEntity) UniqueIndexes() [][]string {
    return [][]string{{"Email"}}
}

func TestUserCRUD(t *testing.T) {
    ctx := fluxaorm.PrepareTables(t, fluxaorm.NewRegistry(), UserEntity{})

    logs := &fluxaorm.MockLogHandler{}
    ctx.RegisterQueryLogger(logs, fluxaorm.QueryLoggerOptions{MySQL: true, Redis: true})

    // create
    user := entities.UserEntityProvider.New(ctx)
    user.SetName("Alice").SetEmail("alice@example.com")
    require.NoError(t, ctx.Save(user))
    assert.NotZero(t, user.GetID())

    // read on a fresh context so the identity map is not involved
    reader := ctx.Clone()
    loaded, found, err := entities.UserEntityProvider.GetByID(reader, user.GetID())
    require.NoError(t, err)
    require.True(t, found)
    assert.Equal(t, "Alice", loaded.GetName())

    // update
    loaded.SetName("Bob")
    require.NoError(t, reader.Save(loaded))

    again, err := entities.UserEntityProvider.MustGetByID(ctx.Clone(), user.GetID())
    require.NoError(t, err)
    assert.Equal(t, "Bob", again.GetName())

    // delete
    require.NoError(t, ctx.Delete(again))
    _, found, err = entities.UserEntityProvider.GetByID(ctx.Clone(), user.GetID())
    require.NoError(t, err)
    assert.False(t, found)

    assert.NotEmpty(t, logs.Logs)
}
```

See [CRUD Operations](/guide/crud.html) for the generated API used above.
