# Redis Search Engine

In the previous section, you learned how to search for entities using MySQL queries.
However, there is one major drawback when searching for data using a relational database such as MySQL — performance in high-traffic applications.
Fortunately, there is an option to use the Redis Search engine, which provides much better performance than MySQL.

## Defining Redis Search Fields

By default, an entity is not indexed in the Redis Search index. You must add a special tag redis_search to a specific entity field to instruct FluxaORM to create a Redis hash index for that entity, keeping data from the tagged fields.
You can add this tag to more than one field. An entity is considered searchable via the Redis Search engine when at least one of its fields has the redis_search tag.

Example — entity with two fields indexed in Redis Search:
```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache"`
	Age           uint8      `orm:"redis_search"`
	Name          string     `orm:"redis_search"`
}
```

## Sortable Fields

By default, fields are not sortable. You can make a field sortable by adding the rs_sortable tag:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redis_search_pool=my_pool"`
	Age           uint8      `orm:"redis_search;rs_sortable"`
}
```

## Defining a Redis Pool for the Search Index

You must define a different Redis pool using the redis_search_pool tag on the ID field:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redis_search_pool=my_pool"`
	Age           uint8      `orm:"redis_search;rs_sortable"`
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
	ID            uint64     `orm:"localCache;redisCache;redis_search_pool=my_pool"`
	Age           uint8      `orm:"redis_search;rs_tag"`
}
```

## NOSTEM

You can define the NOSTEM index option with the rs_no-stem tag:

```go
type PersonEntity struct {
	ID            uint64     `orm:"localCache;redisCache;redis_search_pool=my_pool"`
	Name          string      `orm:"redis_search;rs_no-steam"`
}
```

## Running Index Alter

If at least one of your entities uses Redis Search, you must run fluxabee.GetRedisSearchAlters() when your application starts:

```go
redisSearchAlters := fluxabee.GetRedisSearchAlters(orm)
for _, alter := range redisSearchAlters {
    alter.Exec(ctx)
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
schema := GetEntitySchema[UserEntity](orm)
schema.ReindexRedisIndex(ctx)
```

This operation can take some time (depending on how many entities are stored in MySQL).
You can monitor progress using the FTInfo() Redis command:

```go
schema := GetEntitySchema[UserEntity](orm)
r := ctx.Engine().Redis(schema.GetRedisSearchPoolCode())
info, _ := r.FTInfo(orm, schema.GetRedisSearchIndexName())
fmt.Printf("Indexed: %d", info.PercentIndexed)
```

## Searching for Entities

The RedisSearch() function searches for entities using a Redis Search query condition.

Example:
```go
options = &fluxaorm.RedisSearchOptions{}
options.Pager = fluxaorm.NewPager(1, 100)
options.AddSortBy("Age", false) // sort by Age ASC
options.AddFilter("Owner", 1, 1) // Owner = 1
options.AddSortBy("Age", 18, nil) // Age >= 18
iterator, total := fluxaorm.RedisSearch[UserEntity](orm, "@Status:{active}", options)
for iterator.Next() {
    user := iterator.Entity()
}
```

The Pager object is optional — if nil, FluxaORM searches all rows.

If you only need entity primary keys, use RedisSearchIDs():
```go
options = &fluxaorm.RedisSearchOptions{}
options.Pager = fluxaorm.NewPager(1, 100)
ids, total := fluxaorm.RedisSearchIDs[UserEntity](orm, "*", options)
```

## Searching for a Single Entity

Use RedisSearchOne() to retrieve a single entity:

```go
user, found := fluxaorm.RedisSearchOne[UserEntity](orm, "@Email:{test@example.com}", nil)
```

::: tip
This function always adds LIMIT 1 to the query. If more than one row matches, only the first will be returned.
:::
