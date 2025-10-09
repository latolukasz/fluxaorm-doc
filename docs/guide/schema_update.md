# Schema Update

One of the main benefits of using an ORM is the ability to generate and update a database schema based on the data structures in your code. In FluxaORM, these data structures are represented as registered entities. There are two ways to generate or update the MySQL schema in FluxaORM:

The recommended approach is to use the `GetAlters()` function. This function compares the current MySQL schema in all the MySQL databases used by the registered entities and returns detailed information that can be used to update the schema. Here is an example of how to use the `GetAlters()` function:

```go{20}
package main

import "github.com/latolukasz/fluxaorm"

type CategoryEntity struct {
	ID   uint64 `orm:"mysql=products"`
    Name string `orm:"required"`
}

func main() {
    registry := fluxaorm.NewRegistry()
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
    registry.RegisterEntity(CategoryEntity{})
    engine, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    orm := engine.NewContext(context.Background())
    
    alters := fluxaorm.GetAlters(orm)
    for _, alter := range alters {
      alter.SQL // "CREATE TABLE `CategoryEntity` ..."
      alter.Pool // "products"
      alter.Safe // true
	}
}  
```

The Safe field of the fluxaorm.Alter object is false if any of the following conditions are met:

 * The table needs to be dropped and is not empty.
 * At least one column needs to be removed or changed and the table is not empty.

If the Safe field is true, it means that executing the alter will not result in any data loss.

To execute all the alters, you can use a loop like this:

```go
for _, alter := range alters {
  alter.Exec()
}
```

::: tip
Make sure to execute all the alters in the exact order they are returned by the GetAlters() method.
:::

::: warning
FluxaORM generates `DROP TABLE ...` queries for all tables in the registered MySQL database that are not mapped as entities. 
See [ignored tables](/guide/data_pools.html#ignored-tables) section how to register ignored MySQL tables.
:::

## Updating Entity Schema

You can also use the `orm.EntitySchema` object of an entity to update its database schema. Here is an example:

```go{2}
orm := engine.NewContext(context.Background())
entitySchema := fluxaorm.GetEntitySchema[CategoryEntity](orm)
alters, has := entitySchema.GetSchemaChanges(orm)
if has {
    for _, alter := range alters {
      alter.SQL // "CREATE TABLE `CategoryEntity` ..."
      alter.Pool // "products"
      alter.Safe // true
      alter.Exec()
    }
}
```

For convenience, you can use the following short versions to execute all the necessary alters:

```go{3-4}
orm := engine.NewContext(context.Background())
entitySchema := fluxaorm.GetEntitySchema[CategoryEntity](orm)
entitySchema.UpdateSchema(engine) // executes all alters
entitySchema.UpdateSchemaAndTruncateTable(engine) // truncates table and executes all alters
```

The `orm.EntitySchema` object also provides several useful methods for managing the entity table:

```go
orm := engine.NewContext(context.Background())
entitySchema := fluxaorm.GetEntitySchema[CategoryEntity](orm)
entitySchema.DropTable(orm) // drops the entire table
entitySchema.TruncateTable(orm) // truncates the table
```
