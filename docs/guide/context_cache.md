# Context Cache

In this section, you will learn how to use context cache to speed up your application..

Without context cache every time you retrieve entities queries to MySQL or/and Redis are executed.
By default `fluxaorm.Context` does not use context (locac) cache to store retrieved entities.
So next time you retrieve the same entity from the database, it will be retrieved again from DB/Redis.
For example:

```go
orm := engine.NewContext(context.Background())
user, _ := orm.GetById[UserEntity](orm, 1) // executes request do DB/Redis
...
user, _ = orm.GetById[UserEntity](orm, 1) // executes request do DB/Redis

```

## Enabling Context Cache

You can enable context cache by running `EnableContextCache()`:

```go
orm := engine.NewContext(context.Background())
orm.EnableContextCache() // from now on, every entity will be stored and retrieved from context cache
```

## Clearing Context Cache

You can clear context cache by running `ClearCache()`:

```go
orm := engine.NewContext(context.Background())
orm.EnableContextCache()
user, _ := orm.GetById[UserEntity](orm, 1) // executes request do DB/Redis
orm.ClearCache()
user, _ := orm.GetById[UserEntity](orm, 1) // executes request do DB/Redis
```

You should clear context cache in case you are uisng context for a long time to avoid using data that is not up to date.
So you should use context cache only for short time such as a single API request.
In case of a long running process you should use a separate context for each scope of work.