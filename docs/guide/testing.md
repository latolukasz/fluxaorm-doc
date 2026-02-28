# Testing

FluxaORM provides several utilities in the `fluxaorm` package to simplify writing integration and unit tests for applications that use the ORM.

## Setting Up a Test Environment

### PrepareTables

The primary test helper is `fluxaorm.PrepareTables`, which sets up a clean database environment for each test. It registers MySQL, Redis, and local cache pools, validates the registry, runs any pending schema migrations, truncates all entity tables, and flushes Redis:

```go
import (
    "testing"

    fluxaorm "github.com/latolukasz/fluxaorm/v2"
)

type UserEntity struct {
    ID    uint64
    Name  string
    Email string `orm:"unique=Email"`
}

func TestCreateUser(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    ctx := fluxaorm.PrepareTables(t, registry, &UserEntity{})

    // ctx is a fully initialized fluxaorm.Context
    // All entity tables are clean and ready to use
    // Use generated Provider code for CRUD operations
}
```

`PrepareTables` performs the following steps:

1. Registers a MySQL pool (`default`) pointing to `root:root@tcp(localhost:3397)/test`
2. Registers two Redis pools (`default` on db 0 and `second` on db 1) at `localhost:6395`
3. Registers a local cache pool (`default`)
4. Registers the provided entities
5. Calls `registry.Validate()` to build the `Engine`
6. Creates a new `fluxaorm.Context`
7. Flushes both Redis databases
8. Runs all pending schema alters (`GetAlters`)
9. Truncates all entity tables and updates their schemas
10. Clears all local caches

The function returns a ready-to-use `fluxaorm.Context`.

### PrepareTablesBeta

`PrepareTablesBeta` works identically to `PrepareTables` but configures the MySQL connection with the `Beta` option enabled (which uses `parseTime=true&loc=UTC` in the DSN):

```go
func TestWithBetaMySQL(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    ctx := fluxaorm.PrepareTablesBeta(t, registry, &UserEntity{})

    // Use ctx as normal — MySQL is configured with Beta options
}
```

### Manual Setup

If you need more control over the test configuration (custom ports, additional Redis pools, etc.), set up the registry manually:

```go
func TestCustomSetup(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("root:root@tcp(localhost:3306)/testdb", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterRedis("localhost:6379", 0, fluxaorm.DefaultPoolCode, nil)
    registry.RegisterLocalCache(fluxaorm.DefaultPoolCode, 1000)
    registry.RegisterEntity(&UserEntity{}, &ProductEntity{})

    engine, err := registry.Validate()
    if err != nil {
        t.Fatal(err)
    }

    ctx := engine.NewContext(context.Background())

    // Run alters, truncate tables, etc. as needed
    alters, err := fluxaorm.GetAlters(ctx)
    if err != nil {
        t.Fatal(err)
    }
    for _, alter := range alters {
        err = alter.Exec(ctx)
        if err != nil {
            t.Fatal(err)
        }
    }
}
```

## MockDBClient

`MockDBClient` lets you intercept and mock MySQL database calls without a real database connection. It implements the `DBClient` interface and delegates to the original client for any method that does not have a mock function set:

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

### Using MockDBClient

To install a mock, get the `DB` instance from the engine and call `SetMockDBClient`:

```go
func TestWithMockDB(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    ctx := fluxaorm.PrepareTables(t, registry, &UserEntity{})

    db := ctx.Engine().DB(fluxaorm.DefaultPoolCode)
    originalClient := db.GetDBClient()

    mock := &fluxaorm.MockDBClient{
        OriginDB: originalClient,
        ExecMock: func(query string, args ...any) (sql.Result, error) {
            // Inspect or modify behavior
            if strings.Contains(query, "INSERT") {
                return nil, fmt.Errorf("simulated insert failure")
            }
            // Fall through to the real database for other queries
            return originalClient.Exec(query, args...)
        },
    }

    db.SetMockDBClient(mock)
    defer db.SetMockDBClient(originalClient) // restore after test

    // Operations that call Exec will now hit the mock
}
```

Any mock function field left as `nil` causes that method to delegate to `OriginDB`, so you only need to set the specific methods you want to intercept.

## MockLogHandler

`MockLogHandler` captures all query log entries so you can assert on them in tests. It implements the `LogHandler` interface:

```go
type MockLogHandler struct {
    Logs []map[string]any
}
```

The `Handle` method receives a `fluxaorm.Context` and a log entry map:

```go
func (h *MockLogHandler) Handle(ctx fluxaorm.Context, log map[string]any) {
    h.Logs = append(h.Logs, log)
}
```

### Using MockLogHandler

```go
func TestQueryLogging(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    ctx := fluxaorm.PrepareTables(t, registry, &UserEntity{})

    logger := &fluxaorm.MockLogHandler{}
    ctx.RegisterQueryLogger(logger, true, true, false) // MySQL + Redis

    // Perform operations using generated Providers...
    // e.g., UserEntityProvider.New(ctx), entity.SetName("Alice"), ctx.Flush()

    // Inspect captured logs
    for _, entry := range logger.Logs {
        fmt.Printf("source=%s operation=%s query=%s\n",
            entry["source"], entry["operation"], entry["query"])
    }

    // Clear logs between test phases
    logger.Clear()
}
```

Each entry in `logger.Logs` is a `map[string]any` containing the same fields documented in the [Queries Log](/guide/queries_log.html) page (`source`, `pool`, `query`, `operation`, `microseconds`, etc.).

## Example: Full Integration Test

Here is a complete example that combines `PrepareTables` with generated entity code. Assume that `UserEntity` has been defined and code generation has been run, producing `UserEntityProvider`:

```go
package myapp_test

import (
    "testing"

    fluxaorm "github.com/latolukasz/fluxaorm/v2"
    "github.com/stretchr/testify/assert"
    "myapp/entities" // generated entity code
)

func TestUserCRUD(t *testing.T) {
    registry := fluxaorm.NewRegistry()
    ctx := fluxaorm.PrepareTables(t, registry, &entities.UserEntityDefinition{})

    // Set up query logging
    logger := &fluxaorm.MockLogHandler{}
    ctx.RegisterQueryLogger(logger, true, false, false)

    // Create a user via generated Provider
    user := entities.UserEntityProvider.New(ctx)
    user.SetName("Alice")
    user.SetEmail("alice@example.com")
    err := ctx.Flush()
    assert.NoError(t, err)
    assert.Greater(t, user.GetID(), uint64(0))

    // Read the user back
    loaded, found, err := entities.UserEntityProvider.GetByID(ctx, user.GetID())
    assert.NoError(t, err)
    assert.True(t, found)
    assert.Equal(t, "Alice", loaded.GetName())

    // Update
    loaded.SetName("Bob")
    err = ctx.Flush()
    assert.NoError(t, err)

    // Verify update
    updated, found, err := entities.UserEntityProvider.GetByID(ctx, loaded.GetID())
    assert.NoError(t, err)
    assert.True(t, found)
    assert.Equal(t, "Bob", updated.GetName())

    // Delete
    updated.Delete()
    err = ctx.Flush()
    assert.NoError(t, err)

    // Verify log captured queries
    assert.Greater(t, len(logger.Logs), 0)
}
```
