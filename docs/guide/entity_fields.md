# Entity fields

You have learned how to create a simple Entity. In this section, we will delve into defining other fields and how they are stored in the database.

By default, every public entity field (which starts with an uppercase letter) is stored in MySQL. However, you can specify different storage options for your fields if needed. It is important to carefully consider the types and names of your fields to ensure proper and efficient storage and retrieval of data.

## Integers

Go offers a variety of integer types such as int8, int16, uint, and uint32, and FluxaORM supports all of them.
```go{3-4}
type PersonEntity struct {
    ID                 uint64
    Age                uint8
    BankAccountBalance int32
}
```

The table below shows how Go's integer types are mapped to MySQL column types:
| go        | MySQL         | min value  | max value  |
| ------------- |:-------------:| -----:| -----:|
| int8      | tinyint  | -128 | 127 |
| int16      | smallint      |   -32768 | 32767 |
| int32 with tag `orm:"mediumint"` | mediumint      |    -8388608 | 8388607 |
| int32,int,rune | int      |    	-2147483648 | 	2147483647 |
| int64 | bigint      |    	-2<sup>63</sup> | 	2<sup>63</sup>-1 |
| uint8      | tinyint | 0 | 255 |
| uint16      | smallint      |   0 | 65535 |
| uint32 with tag `orm:"mediumint"` | mediumint      |    0 | 16777215 |
| uint32,uint | int      |    	0 | 	4294967295 |
| uint64 | bigint      |    	0 | 	2<sup>64</sup>-1 |

Note that the minimum and maximum values for each type may vary depending on the MySQL version you are using. Refer to the MySQL documentation for more information.

::: tip
Always take the time to carefully analyze your data and choose the best int type for each field:

 * If a field contains only positive numbers, use an unsigned type (e.g. uint, uint16, etc.). 
 * Try to use the smallest possible bit size for each field. For example, using uint16 for the PersonAge field would be incorrect because people do not live longer than 255 years (at least not yet). In this case, uint8 would be a more appropriate choice.
 * It is important to use the correct type for primary keys and fields that are part of a MySQL index. Using a low bit size not only saves MySQL disk space, but also reduces the memory used to cache the index.
:::

If you need to store a NULL value for any of the above MySQL fields, you can use a reference to the corresponding integer type (e.g. *int8, *int16, *int32, *int, *rune, *int64, *uint8, *uint16, *uint32, *uint, *uint64). In MySQL, these fields will be defined as DEFAULT NULL.

```go{5}
type PersonEntity struct {
    ID uint64
    // null if we don't know how many friends this person has
    // zero if no one likes him:)
    Friends *uint
}
```

## Floats

Working with floating point values can be challenging. In FluxaORM, you can use either float32 or float64 as your primitive type. You can then use special tags to specify how the float value should be stored in MySQL.
```go{3-5}
type PersonEntity struct {
    ID          uint64
    Balance     float64
    Temperature float32 `orm:"decimal=3,1;unsigned"`
    Weight      float32 `orm:"unsigned"`
}
```

| go        | MySQL         |
| ------------- |:-------------:|
| float32      | float  |
| float32 with tag `orm:"unsigned"` | float unsigned      |
| float64      | double  |
| float64 with tag `orm:"unsigned"` | double unsigned      |
| float32,float64 with tag `orm:"decimal=X,Y"`     | decimal(X,Y)  |
| float32,float64 with tag `orm:"decimal=X,Y;unsigned"`     | decimal(X,Y) unsigned  |

All of the above MySQL fields are defined as NOT NULL. If you need to store a NULL value, you can use a reference to the corresponding floating point type (e.g. *float32, *float64). In MySQL, these fields will be defined as DEFAULT NULL.

## Booleans

Working with boolean values is straightforward in FluxaORM. You can use the bool type to store boolean values in MySQL. If you need to allow NULL values in your MySQL field, you can use the *bool type instead.

```go{3-4}
type PersonEntity struct {
    ID           uint64
    Married      bool
    HasChildren  *bool
}
```
In MySQL, the IsActive field will be defined as NOT NULL, while the HasLicense field will be defined as DEFAULT NULL.

| go        | MySQL         |
| ------------- |:-------------:|
| bool      | tinyint(1)  |


## Strings

To store text in Go, you can use the string type. Here is an example of how to use strings in a struct definition:

```go{3-5}
type ProductEntity struct {
    ID           uint64
    Title        string `orm:"required;length=150"`
    Description  string `orm:"required;length=max"`
    Brand        string
}
```

| go        | MySQL         |
| ------------- |:-------------:|
| string      | varchar(255)  |
| string with tag `orm:"required"` | varchar(255) NOT NULL      |
| string with tag `orm:"length=X"` | varchar(X)      |
| string with tag `orm:"length=max"` | mediumtext      |
`
::: tip
When defining string fields in your Go structs, consider adding the orm:"required" tag if the field should never hold an empty string. This can help to save space in the MySQL table where the data is stored, as the database will not need to reserve space for empty strings.
:::

## Dates and Times

To store date or date and time values, use time.Time in your struct::

```go{3-5}
type UserEntity struct {
    ID              uint64
    DateOfBirth     time.Time
    CreatedAt       time.Time `orm:"time"`
    UpdatedAt       *time.Time `orm:"time"`
}
```

The time.Time type will be mapped to a date NOT NULL column in MySQL. If you want to store a datetime value in MySQL, you can use the orm:"time" tag. This will map the time.Time field to a datetime NOT NULL column in MySQL.

If you want to store a nullable date or datetime value in MySQL, you can use a pointer to time.Time. A pointer to time.Time will be mapped to a date column in MySQL, and a pointer to time.Time with the orm:"time" tag will be mapped to a datetime column in MySQL.

Here is a summary of the mapping between Go types and MySQL columns:

| go        | MySQL         |
| ------------- |:-------------:|
| time.Time      | date NOT NULL |
| time.Time with tag `orm:"time"` | datetime NOT NULL      |
| *time.Time      | date |
| *time.Time with tag `orm:"time"` | datetime      |
`

## Binary strings

To store binary strings in your database, use the []uint8 type in your struct:

```go{3}
type UserEntity struct {
    ID              uint64
    CVFileContent   []uint8
}
```

This will map the []uint8 field to a blob column in MySQL. If you want to store a mediumblob or longblob value in MySQL, you can use the orm:"mediumblob" or orm:"longblob" tag, respectively.

Here is a summary of the mapping between Go types and MySQL columns:

| go        | MySQL         |
| ------------- |:-------------:|
| []uint8      | blob |
| []uint8 with tag `orm:"mediumblob"` | mediumblob      |
| []uint8 with tag `orm:"longblob"` | longblob      |

## Enums and Sets

When you require the storage of a value from a predefined list in one of your fields, MySQL provides convenient options in the form of the ENUM or SET field types to accommodate this need. 
To enable this feature for string types, you can effortlessly implement the `EnumValues` interface:
```go
type EnumValues interface {
	EnumValues() any
}
```

This interface is expected to return a struct that defines the valid ENUM values. 
For a more detailed understanding, please refer to the example below:

```go
package main

import "github.com/latolukasz/fluxaorm"

type Color string

var Colors = struct{
	Red    Color
	Blue   Color
	Yellow Color
}{
	Red:    "red",
	Blue:   "blue",
	Yellow: "yellow",
}

func (c Color) EnumValues() any {
	return Colors
}


type UserEntity struct {
    ID              uint64
    FavoriteColor   Color `orm:"required"`
    HatedColors     []Color
}
```

You can also return `[]string:

```go
type Color string

func (c Color) EnumValues() any {
	return []string{"red", "blue", "yellow"}
}
```


Here is a summary of the mapping between Go types and MySQL columns:

| go      |         MySQL         |
|---------|:---------------------:|
| Color   | ENUM(red,blue,yellow) |
| []Color | SET(red,blue,yellow)  |

## One-to-One References

In FluxaORM, you can define a one-to-one reference between two entities by declaring a field with the type of the `Reference[EntityType]`:

```go{9}
type CategoryEntity struct {
    ID     uint64
    Name   string  `orm:"required"`
}

type ProductEntity struct {
    ID       uint64
    Name     string  `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity] `orm:"required"`
}
```

In the example above, FluxaORM will create a `Category bigint NOT NULL` column in the ProductEntity table. If the field is allowed to store NULL values, simply omit the orm:"required" tag.

## Subfields

It is often useful to divide entity fields into logical groups, as this can help improve code readability and facilitate reuse of field definitions in other entities. In FluxaORM, you can do this by creating a struct for the subfields and using it as the type of a field. For example:

```go
type Address struct  {
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

type CompanyEntity struct {
    ID         uint64
    Address    Address
}
```

You can also nest structs within structs to any desired level of complexity.

When working with structs in FluxaORM, a MySQL column is created for each field in the struct, with the field name added as a suffix to the column name. For example, the field `HomeAddress.Country` would be stored in a column named HomeAddressCountry varchar(255).

## Anonymous Subfields

In addition to using named structs as subfields, you can also define fields using anonymous structs. For example:

```go{11}
type Address struct  {
   Country    string
   City       string
   Street     string
   Building   uint
   PostalCode string
}

type UserEntity struct {
    ID             uint64
    Address
}
```

When using anonymous structs in FluxaORM, the fields are represented in the MySQL table without a suffix. For example, the field Country would be stored in a column named `Country varchar(255)`.

## Arrays

You can also utilize Go arrays to group fields. Take a look at the example below:

```go{9-12}
type Address struct  {
    City       string
    Street     string
    PostalCode string
}

type TestEntity struct {
    ID              uint64
    Alias           [5]string
    Codes           [3]uint32
    Top10Categories [10]orm.Reference[CategoryEntity] `orm:"required"`
    Addresses       [3]Address
}
```

In this case, each element within the array is stored in a separate MySQL column. For instance, the example above generates columns 
like `Alias_1 varchar(255)`, `Alias_2 varchar(255)` and so on.

## Ignored Fields

Sometimes you may have public fields in an entity that should not be stored in the database. To instruct FluxaORM to ignore a field, you can use the `orm:"ignore"` tag:

```go{3}
type UserEntity struct {
    ID        uint64
    MyField   string `orm:"ignore"`
}
```

With this tag, FluxaORM will not create a column for the `MyField` field in the MySQL table for the `UserEntity` entity. This can be useful in cases where you want to store additional information in the struct that is not relevant to the database.
