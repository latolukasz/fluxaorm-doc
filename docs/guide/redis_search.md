# Redis Search Engine

In the previous section, you learned how to search for entities using MySQL queries.
However, there is one major drawback when searching for data using a relational database such as MySQL — performance in high-traffic applications.
Fortunately, there is an option to use the Redis Search engine, which provides much better performance than MySQL.

## Defining Redis Search Fields

By default, an entity is not indexed in the Redis Search index. You must add a special tag searchable to a specific entity field to instruct FluxaORM to create a Redis hash index for that entity, keeping data from the tagged fields.
You can add this tag to more than one field. An entity is considered searchable via the Redis Search engine when at least one of its fields has the searchable tag.

Example — entity with two fields indexed in Redis Search:
```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache"`
	Age           uint8      `orm:"searchable"`
	Name          string     `orm:"searchable"`
}
```

## Sortable Fields

By default, fields are not sortable. You can make a field sortable by adding the sortable tag:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redisSearch=my_pool"`
	Age           uint8      `orm:"searchable;sortable"`
}
```

## Defining a Redis Pool for the Search Index

You must define a different Redis pool using the redisSearch tag on the ID field:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redisSearch=my_pool"`
	Age           uint8      `orm:"searchable;sortable"`
}
```

## Entity Field Mapping

The table below shows how entity field types are mapped to Redis Search index field types:
| go        | Redis Search Index         | Comments |
| ------------- |:-------------:|:-------------:|
| int..., uint..., float...      | NUMERIC  |
| *int..., *uint..., *float...      | NUMERIC  | nil is stored as 0 |
| string, *string      | TEXT      | nil is stored as NULL |
| bool, *bool      | TAG      | 0, 1, NULL |
| time.Time, *time.Time      | NUMERIC      | stored as unix timestamp, nil as 0 |
| fluxaome.Reference      | NUMERIC      | nil as 0 |
| fluxaome.ENUM, []fluxaome.ENUM      | TAG      | nil as NULL |

## Forcing Type TAG

You can force a field to be stored in Redis as a TAG by adding the rs_tag tag:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redisSearch=my_pool"`
	Age           uint8      `orm:"searchable;rs_tag"`
}
```

## NOSTEM

You can define the NOSTEM index option with the rs_no-stem tag:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redisSearch=my_pool"`
	Name          string      `orm:"searchable;rs_no-steam"`
}
```

## Running Index Alter

If at least one of your entities uses Redis Search, you must run fluxabee.GetRedisSearchAlters() when your application starts:

```go
redisSearchAlters, err := fluxabee.GetRedisSearchAlters(orm)
for _, alter := range redisSearchAlters {
    err = alter.Exec(ctx)
}
```

:::warning
If alter.Exec(ctx) modifies the current index (e.g., adds a new field), the previous index is dropped and a new one is created.
The new index is then filled with entity data from MySQL.
If the entity table contains many rows (hundreds of thousands or more), this operation can take some time.
:::

## Reindexing an Entity Index

FluxaORM automatically updates the index when you add, update, or delete an entity.
However, if your Redis index data was manually removed or MySQL data was manually updated and you need to refresh Redis, you can use the entity schema ReindexRedisIndex() method:

```go
schema, err := GetEntitySchema[UserEntity](orm)
schema.ReindexRedisIndex(ctx)
```

This operation can take some time (depending on how many entities are stored in MySQL).
You can monitor progress using the FTInfo() Redis command:

```go
schema, err := GetEntitySchema[UserEntity](orm)
r := ctx.Engine().Redis(schema.GetRedisSearchPoolCode())
info, _, err := r.FTInfo(orm, schema.GetRedisSearchIndexName())
fmt.Printf("Indexed: %d", info.PercentIndexed)
```

## Searching for Entities

The RedisSearch() function searches for entities using a Redis Search query condition.

Example:
```go
query = fluxaorm.NewRedisSearchQuery()
query.Query = "@Status:{active}"
query.AddSortBy("Age", false) // sort by Age ASC
query.AddFilter("Owner", 1, 1) // Owner = 1
query.AddSortBy("Age", 18, nil) // Age >= 18
iterator, total, err := fluxaorm.RedisSearch[UserEntity](orm, query, fluxaorm.NewPager(1, 100)
for iterator.Next() {
    user, err := iterator.Entity()
}
```

The Pager object is optional — if nil, FluxaORM searches all rows.

If you only need entity primary keys, use RedisSearchIDs():
```go
query = fluxaorm.NewRedisSearchQuery()
ids, total, err := fluxaorm.RedisSearchIDs[UserEntity](orm, nil, nil) // all rows
```

## Searching for a Single Entity

Use RedisSearchOne() to retrieve a single entity:

```go
user, found, err := fluxaorm.RedisSearchOne[UserEntity](orm, "@Email:{test@example.com}", nil)
```

::: tip
This function always adds LIMIT 1 to the query. If more than one row matches, only the first will be returned.
:::
