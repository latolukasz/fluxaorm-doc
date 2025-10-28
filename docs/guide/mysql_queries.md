# MySQL Queries

In this section, you will learn how to run SQL queries in MySQL. First, we need to configure the MySQL data pools and engine. In our example, we will create two pools - one with the name `default` and another with the name `users`:

```go
registry := fluxaorm.NewRegistry()
registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil)
registry.RegisterMySQL("user:password@tcp(localhost:3306)/users", "users", nil)
engine, err := registry.Validate(0)
if err != nil {
    panic(err)
}
orm := engine.NewContext(context.Background())
```

## MySQL Data Pool

Now we are ready to get the MySQL data pool that will be used to execute all queries. This pool also provides a few useful methods:

```go
db := engine.DB(orm.DefaultPoolCode) // or c.Engine().DB(orm.DefaultPoolCode)
config := db.GetConfig()
config.GetCode() // "default"
config.GetDatabaseName() // "default_db"
config.GetDataSourceURI() // "user:password@tcp(localhost:3306)/default_db"
confit.GetOptions() // MySQL options, MaxOpenConnections, DefaultEncoding....
```

## Executing Modification Queries

To run queries that modify data in MySQL, use the `Exec()` method:

```go{2,6,10,15}
db := engine.DB(orm.DefaultPoolCode)
result := db.Exec(orm, "INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?)", "Berlin", 12)
result.LastInsertId() // 1
result.RowsAffected() // 1

result = db.Exec(orm, "INSERT INTO `Cities`(`Name`, `CountryID`) VALUES(?, ?),(?, ?)", "Amsterdam", 13, "Warsaw", 14)
result.LastInsertId() // 3
result.RowsAffected() // 2

result = db.Exec(orm, "UPDATE `Cities` SET `Name` = ? WHERE ID = ?", "New York", 1)
result.LastInsertId() // 0
result.RowsAffected() // 1

dbUsers := engine.DB("users")
dbUsers.Exec(orm, "DELETE FROM `Users` WHERE `Status` = ?", "rejected")
result.LastInsertId() // 0
result.RowsAffected() // 0
```

## Querying a Single Row

To run a query that returns only one row, use the `QueryRow()` method:

```go{5}
db := engine.DB(orm.DefaultPoolCode)
where := fluxaorm.NewWhere("SELECT ID, Name FROM Cities WHERE ID = ?", 12)
var id uint64
var name string
found := db.QueryRow(orm, where, &id, &name)
```

## Querying Multiple Rows

To run a query that returns multiple rows, use the `Query()` method:

```go{4}
db := engine.DB(orm.DefaultPoolCode)
var id uint64
var name string
results, close := db.Query(orm, "SELECT ID, Name FROM Cities WHERE ID > ? LIMIT 100", 20)
defer close()
results.Columns() // []string{"ID", "Name"}
for results.Next() {
    results.Scan(&id, &name)
}
```

:::warning
Remember to include a `defer close()` after every `db.Query()` call. Failing to do so will result in the inability to run queries to MySQL, as all open database connections will be occupied.
:::

## Transactions

Working with transactions is straightforward:

```go
db := engine.DB(orm.DefaultPoolCode)

func() {
    tx := db.Begin(orm) 
    defer tx.Rollback(orm)
    // execute some queries
    tx.Commit(orm)
}()
```

:::tip
Always put `defer Rollback()` after `Begin()`.
:::

## Prepared statements

Using MySQL prepared statements  with FluxaORM is straightforward:

```go
db := engine.DB(orm.DefaultPoolCode)
preparedStatement, close := db.Prepare(orm, "INSERT INTO `UserEntity(`Name`, `Age`)` VALUES(?,?)")
defer close()
res := preparedStatement.Exec("Tom", 12)
res.LastInsertId() // 1
res = preparedStatement.Exec("Ivona", 33)
res.LastInsertId() // 2
```

```go
db := engine.DB(orm.DefaultPoolCode)
preparedStatement, close := db.Prepare(orm, "SELECT `ID`, `Name` FROM `UserEntity WHERE `ID` = ?")
defer close()
id := 0
name := "
preparedStatement.QueryRow([]interface{}{1}, &id, &name)
preparedStatement.QueryRow([]interface{}{2}, &id, &name)
```

```go
db := engine.DB(orm.DefaultPoolCode)
preparedStatement, close := db.Prepare(orm, "SELECT `ID`, `Name` FROM `UserEntity WHERE `ID` > ?")
defer close()
id := 0
name := "
results, queryClose := preparedStatement.Query(2)
defer queryClose()
for results.Next() {
    results.Scan(&id, &name)
}
```
