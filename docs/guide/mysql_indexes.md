# MySQL Indexes

In this section, you will learn how to define MySQL table indexes using BeeORM

## One Field in One Index

In BeeORM, you can easily add each field to a MySQL index using special tags:
 * `orm:"index=IndexName"` for a non-unique index
 * `orm:"unique=IndexName"` for a unique index

For example, the following Go code defines a PersonEntity struct with three indexes:

```go{4-5}
type PersonEntity struct {
    ID      uint64
    Name    string
    Age     uint8 `orm:"index=age"` 
    Email   string `orm:"unique=email;required"` 
    Mother  orm.Reference[PersonEntity]
}
```

This will create the following indexes in the MySQL table:

```sql
  KEY `age` (`Age`),
  UNIQUE KEY `email` (`Email`),
  KEY `Mother` (`Mother`),
```

Note that you don't need to define an index for one-to-one references (Mother) in BeeORM. It will create the index automatically, as it is required to create [foreign indexes](https://dev.mysql.com/doc/refman/8.0/en/create-table-foreign-keys.html).

## Many Fields in One Index

Sometimes you may need to add more than one field to a single index. In BeeORM, you can do this by using the same index name for all fields and adding an extra suffix `:X`, where `X` is the position of the field within the index (starting from 1). You can skip the suffix for the first field (which is equivalent to using :1).

For example, the following Go code defines a ShoeEntity struct with a single unique index spanning three fields:

```go{3-5}
type ShoeEntity struct {
    ID       uint64
    Name     string `orm:"unique=model"`
    Color    string `orm:"unique=model:2"`
    Size     uint8 `orm:"unique=model:3"`
}
```

This will create the following unique index in the MySQL table:

```sql
  UNIQUE KEY `model` (`Name`, `Color`, `Size`),
```

## One Field in Many Indexes

If you need to add a single field to multiple indexes, you can do so by separating the index names with a comma in the BeeORM tag. For example:

```go{4-5}
type PersonEntity struct {
    ID          uint64
    FirstName   string `orm:"index=name:2"`
    LastName    string `orm:"index=name,occupation:2;unique=lastname"`
    Occupation  string `orm:"index=occupation"`
}
```

This will create the following indexes in the MySQL table:

```sql
  KEY `model` (`LastName`, `FirstName`),
  KEY `occupation` (`Occupation`, `LastName`),
  UNIQUE KEY `lastname` (`LastName`),
```

Note that the LastName field is included in both the name and occupation indexes, and it is also defined as a unique key.

## Defining Indexes in Subfields

There may be cases where it is not possible to define indexes using field tags, such as when a struct field itself contains multiple fields that need to be included in an index. For example:

```go
type Address struct {
   Country    string
   City       string
   Street     string
   Building   uint
   PostalCode string
}

type UserEntity struct {
    ID             uint64
    HomeAddress    Address
    WorkAddress    Address
}
```

Suppose we need the following indexes:

```sql
KEY `homeStreet` (`HomeAddressStreet`),
KEY `workAddress` (`WorkAddressCity`, `WorkAddressStreet`),
```

To define these indexes in BeeORM, you can use tag attributes on the `ID` field:

```go{2}
type UserEntity struct {
    ID             uint64     `orm:"index=homeStreet:HomeAddressStreet|workAddress:WorkAddressCity,WorkAddressStreet"`
    HomeAdddress   Address
    WorkAddress    Address
}
```

This will create the two indexes specified above in the MySQL table.