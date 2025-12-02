# Searching for Entities

In the previous section, you learned how to load entities from a database using their primary keys. In this section, we will cover how to search and load entities using other criteria. This can be useful when you want to find specific entities that meet certain conditions or when you want to retrieve a list of entities that match a certain search query. We will explore different techniques for searching and loading entities using various filters and search parameters.

## Using the Pager Object

It is a good practice to limit the number of rows returned in a search query using the `LIMIT` condition in SQL. The FluxaORM library provides a special object called the `Pager` to help define the proper SQL syntax for pagination in your queries.

Here is an example of how to use the Pager object:

```go
// load first 100 rows
pager := fluxaorm.NewPager(1, 100) // LIMIT 0, 100
pager.GetPageSize() // 100
pager.GetCurrentPage() // 1
pager.String() // "LIMIT 0,100"

// load next 100 rows (page nr 2)
pager = fluxaorm.NewPager(2, 100) // LIMIT 100, 100
pager.GetPageSize() // 100
pager.GetCurrentPage() // 2
pager.String() // "LIMIT 100,100"

pager.IncrementPage() // LIMIT 200, 100
pager.GetCurrentPage() // 3
```

## Using the Where Object

Every SQL search query requires specific search conditions to be defined. The `orm.Where` object can be used to define these conditions in a convenient and flexible way.

Here is an example of how to use the `Where` object:

```go
// WHERE Email = "fluxa@orm.dev" AND Age >= 18
where := fluxaorm.NewWhere("Email = ? AND Age >= ?", "fluxa@orm.dev", 18)
where.String() // returns: "Email = ? AND Age >= ?"
where.GetParameters() // returns: []interface{}{"fluxa@orm.dev", 18}

// update the first parameter
where.SetParameter(1, "lion@orm.io")
where.GetParameters() // returns: []interface{}{"lion@orm.io", 18}

// update all parameters
where.SetParameters("elephant@orm.io", 20)
where.GetParameters() // returns: []interface{}{"elephant@orm.io", 20}

// append additional conditions
where.Append(" AND Age <= ?", 60)
where.String() // returns: "Email = ? AND Age >= ? AND Age <= ?"
where.GetParameters() // returns: []interface{}{"elephant@orm.io", 20, 60}
```

You can also use the `Where` object to define the `ORDER BY` clause in a query:

```go
// WHERE 1 ORDER BY Age
where := fluxaorm.NewWhere("1 ORDER BY Age")
// WHERE Age > 10 ORDER BY Age
where := fluxaorm.NewWhere("Age > ? ORDER BY Age", 10)
```
If you pass a slice as an argument to `orm.Where`, it will automatically convert it into the `SQL IN (?,?,...)` syntax, which can simplify your code. For example:

```go
where := fluxaorm.NewWhere("Age IN ?", []int{18, 20, 30})
where.String() // WHERE Age IN (?,?,?)
where.GetParameters() // []interface{}{18, 20, 30}
```

## Searching for Entities

The `Search()` function is used to search for entities using a SQL query condition.

Here is an example of how to use the `Search()` function:

```go
iterator, err := fluxaorm.Search[UserEntity](orm, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
for iterator.Next() {
    user, err := iterator.Entity()
}
```

The Pager object is optional. If you provide nil, FluxaORM will search for all rows.

```go
orm.Search[UserEntity](orm, fluxaorm.NewWhere("Age >= ?", 18), nil)
```

If you need the total number of found rows, you can use the `SearchWithCount()` function, which works exactly the same as `engine.Search()`, with the only difference being that it returns the total number of found rows as an int.

```go
iterator, total, err := fluxaorm.SearchWithCount[UserEntity](orm, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 100))
```

You can efficiently search for entities using the search methods offered by the [entity schema](/guide/entity_schema.html) object.

```go
entitySchema, err := c.Engine().Registry().EntitySchema("mypackage.UserEntity")
searchCriteria := fluxaorm.NewWhere("Age >= ?", 18)
pagination := fluxaorm.NewPager(1, 100)
iterator, total, err := entitySchema.SearchWithCount(orm, searchCriteria, pagination)
```

## Searching for a Single Entity

If you need to search for a single entity, you can use the `SearchOne()` function:

```go
// returns nil if not found
firstUser, found, err := fluxaorm.SearchOne[UserEntity](orm, fluxaorm.NewWhere("1 ORDER BY `CreatedAt`"))
```

::: tip
This function always adds `LIMIT 1` to the SQL query, so if your query selects more than one row from the database, only the first row will be returned.
:::

## Searching for Primary Keys

You can use the `SearchIDs()` or `SearchIDsWithCount` functions to search for the primary keys of an entity:

```go
ids, err := fluxaorm.SearchIDs[UserEntity](orm, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 10))
for _, id := range ids {
    fmt.Printf("ID: %d\n", id)
}
// if you need total rows
ids, total, err := fluxaorm.SearchIDsWithCount[UserEntity](orm, fluxaorm.NewWhere("Age >= ?", 18), fluxaorm.NewPager(1, 10))
```