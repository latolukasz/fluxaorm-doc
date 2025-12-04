# MySQL Indexes

This section explains how to define MySQL table indexes using FluxaORM.

## Defining Entity Indexes

To define indexes for a specific entity, start by creating a variable that contains index definitions.

For example, the code below defines a `userEntityIndexes` struct with three indexes:

```go
var userEntityIndexes = struct {
    Name   fluxaorm.IndexDefinition
    Email  fluxaorm.UniqueIndexDefinition
    Status fluxaorm.IndexDefinition
}{
    Name:   fluxaorm.IndexDefinition{"Name", false},
    Email:  fluxaorm.UniqueIndexDefinition{"Email", false},
    Status: fluxaorm.IndexDefinition{"Status,CreatedAt", false},
}
```

Next, implement the `fluxaorm.IndexInterface` for the entity and return the index definitions:

```go
type UserEntity struct {
    ID        uint64
    Name      string `orm:"rquired"`
    Email     string `orm:"rquired"`
    Status    enums.Status
    CreatedAt time.TIme
}

func (e *UserEntity) Indexes() any {
	return userEntityIndexes
}
```

This will generate the following indexes in the MySQL table:

```sql
  KEY `Name` (`Name`),
  UNIQUE KEY `Email` (`Email`),
  KEY `Status` (`Status`, `CreatedAt`),
```

Later, you will learn how to [query entities using defined indexes](/guide/crud.html#getting-entities-by-unique-key).

## Cached Entity Indexes

Both fluxaorm.IndexDefinition and fluxaorm.UniqueIndexDefinition include a boolean field named `Cached`.
When set to true, all [queries](/guide/crud.html#getting-entities-by-unique-key) filtered by the corresponding index
will be stored in cache.

If the entity uses the Local Cache, rows are cached locally. Otherwise, Redis is used.

```go{6}
var userEntityIndexes = struct {
	Name fluxaorm.IndexDefinition
	Email fluxaorm.UniqueIndexDefinition
	Status fluxaorm.IndexDefinition
}{
	Name: fluxaorm.IndexDefinition{"Name", true}, // cache all query results in cache
	Email: fluxaorm.UniqueIndexDefinition{"Email", false},
	Status: fluxaorm.IndexDefinition{"Status,CreatedAt", false},
}
```

You do not need to manually update cached data. FluxaORM keeps cache entries up to date automatically.