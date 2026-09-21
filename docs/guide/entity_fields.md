---
description: "Every Go field type FluxaORM supports, the exact MySQL column it produces, enums and sets, references, JSON, sub-structs and the generated getters and setters."
---

# Entity Fields

Every exported field of an entity struct becomes a MySQL column, and code generation emits a typed getter and setter for it: `Name string` produces `GetName() string` and `SetName(value string) *UserEntity`. Setters return the entity so calls can be chained, and fields are never accessed directly.

This page lists every supported Go type, the exact column definition the ORM emits for it, and the generated accessors. In the DDL below `utf8mb4` and `utf8mb4_0900_ai_ci` are the pool's `MySQLOptions.DefaultEncoding` and `DefaultEncoding + "_" + DefaultCollate` (see [Data Pools](/guide/data_pools.html)).

## Nullability Rules

- Non-pointer scalars (integers, floats, `bool`, `time.Time`) are always `NOT NULL` with a zero default. Their pointer variants are nullable (`DEFAULT NULL`).
- For `string`, enums, sets, `[]uint8`, `Reference[T]`, `References[T]` and JSON struct pointers, the `required` tag decides: with `required` the column is `NOT NULL` with a non-null default, without it the column is nullable.
- `NOT NULL` text and blob columns receive the expression default `DEFAULT ('')` (MySQL 8.0.13+), so an INSERT from a previous code version that omits the column still succeeds.
- Nullable `mediumtext` and blob columns are emitted without an explicit `DEFAULT NULL` clause; all other nullable columns get `DEFAULT NULL`.

## Integers

```go
type UserEntity struct {
    ID      uint64
    Age     uint8
    Balance int32
    Friends *uint32 // nullable
}
```

| Go type | Column definition |
|---------|-------------------|
| `ID uint64` | `bigint unsigned NOT NULL` (primary key, no default) |
| `uint8` | `tinyint unsigned NOT NULL DEFAULT '0'` |
| `uint16` | `smallint unsigned NOT NULL DEFAULT '0'` |
| `uint32`, `uint` | `int unsigned NOT NULL DEFAULT '0'` |
| `uint32` + `orm:"mediumint"` | `mediumint unsigned NOT NULL DEFAULT '0'` |
| `uint64` | `bigint unsigned NOT NULL DEFAULT '0'` |
| `int8` | `tinyint NOT NULL DEFAULT '0'` |
| `int16` | `smallint NOT NULL DEFAULT '0'` |
| `int32`, `int` | `int NOT NULL DEFAULT '0'` |
| `int32` + `orm:"mediumint"` | `mediumint NOT NULL DEFAULT '0'` |
| `int64` | `bigint NOT NULL DEFAULT '0'` |
| pointer to any of the above | same type, `DEFAULT NULL` instead of `NOT NULL DEFAULT '0'` |

Generated accessors widen the type: unsigned fields use `uint64`, signed fields use `int64`, nullable fields use pointers:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetAge(25).SetBalance(-1500)
age := user.GetAge()         // uint64
balance := user.GetBalance() // int64

friends := uint64(5)
user.SetFriends(&friends)
user.SetFriends(nil)         // NULL
count := user.GetFriends()   // *uint64, nil when NULL
```

::: tip
Pick the smallest integer that fits the data (`uint8` for an age, `uint16` for a year). Smaller columns mean smaller indexes.
:::

## Floats

```go
type ProductEntity struct {
    ID       uint64
    Price    float64 `orm:"decimal=10,2;unsigned"`
    Weight   float32 `orm:"unsigned"`
    Rating   float64
    Discount *float64
}
```

| Go type | Column definition |
|---------|-------------------|
| `float32` | `float NOT NULL DEFAULT '0'` |
| `float64` | `double NOT NULL DEFAULT '0'` |
| float + `orm:"unsigned"` | `float unsigned` / `double unsigned` |
| float + `orm:"decimal=X,Y"` | `decimal(X,Y) NOT NULL DEFAULT '0.00'` (the default zero has `Y` decimals) |
| `*float32`, `*float64` | same type, `DEFAULT NULL` |

Getters return `float64`, setters take `float64`; nullable variants use `*float64`. The `precision=N` tag has no effect on the column definition. It sets the number of decimals the ORM works with for the field - the setter treats a value equal to the stored one within `N` decimals as unchanged, the [Redis row cache](/guide/redis_cache.html) formats the value with `N` decimals, and [Redis Search](/guide/redis_search.html) indexes it with that precision. Default is `8` for `float64`, `4` for `float32`, and `Y` for `decimal=X,Y`.

## Booleans

| Go type | Column definition |
|---------|-------------------|
| `bool` | `tinyint(1) NOT NULL DEFAULT '0'` |
| `*bool` | `tinyint(1) DEFAULT NULL` |
| `FakeDelete bool` (top-level) | `bigint unsigned NOT NULL DEFAULT '0'` - stores the row ID when soft-deleted, see [Fake Delete](/guide/fake_delete.html) |

```go
user.SetActive(true)
active := user.GetActive()   // bool
yes := true
user.SetHasChildren(&yes)    // *bool
```

## Strings

```go
type ProductEntity struct {
    ID          uint64
    Title       string `orm:"required;length=150"`
    Description string `orm:"length=max"`
    Brand       string
}
```

| Go type | Column definition |
|---------|-------------------|
| `string` | `varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL` |
| `string` + `required` | `varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT ''` |
| `string` + `length=N` | `varchar(N) ...` (N must be an integer <= 65535, otherwise `invalid max string: <N>`) |
| `string` + `length=max` | `mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci` (no `DEFAULT NULL` clause) |
| `string` + `length=max;required` | `mediumtext CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT ('')` |

Getters always return `string`; for a nullable column `NULL` reads as `""`, and setting `""` on a nullable column stores `NULL`. Pointer strings (`*string`) are not supported.

```go
product.SetTitle("Wireless Mouse")
brand := product.GetBrand() // "" when NULL
```

## Dates and Times

`time.Time` is a `date` column unless tagged `time`, which makes it `datetime`. Fields named `CreatedAt` or `UpdatedAt` are always `datetime` and are filled automatically (see [Entities](/guide/entities.html)).

```go
type UserEntity struct {
    ID          uint64
    DateOfBirth time.Time
    LastLogin   *time.Time `orm:"time"`
    CreatedAt   time.Time
    UpdatedAt   time.Time
}
```

| Go type | Column definition |
|---------|-------------------|
| `time.Time` | `date NOT NULL DEFAULT '0001-01-01'` |
| `time.Time` + `orm:"time"` (or named `CreatedAt`/`UpdatedAt`) | `datetime NOT NULL DEFAULT '1000-01-01 00:00:00'` |
| `*time.Time` | `date DEFAULT NULL` |
| `*time.Time` + `orm:"time"` | `datetime DEFAULT NULL` |

Setters truncate the value: `date` columns to whole days, `datetime` columns to whole seconds. Store UTC values.

```go
user.SetDateOfBirth(time.Date(1990, 6, 15, 0, 0, 0, 0, time.UTC))
login := user.GetLastLogin() // *time.Time, nil when NULL
```

## Binary Data

```go
type UserEntity struct {
    ID        uint64
    Avatar    []uint8
    Document  []uint8 `orm:"mediumblob;required"`
    LargeFile []uint8 `orm:"longblob"`
}
```

| Go type | Column definition |
|---------|-------------------|
| `[]uint8` | `blob` (nullable, no `DEFAULT NULL` clause) |
| `[]uint8` + `orm:"mediumblob"` | `mediumblob` |
| `[]uint8` + `orm:"longblob"` | `longblob` |
| any of the above + `required` | `... NOT NULL DEFAULT ('')` |

Accessors are `Get<F>() []uint8` and `Set<F>(value []uint8)`. Blob fields have no typed `Fields` descriptor and cannot be used in query filters.

## Enums

An `enum=` tag on a `string` field creates a MySQL `ENUM` column and a Go enum type in the `enums/` sub-package:

```go
type OrderEntity struct {
    ID     uint64
    Status string `orm:"enum=pending,processing,shipped,delivered;required"`
}
```

| Definition | Column definition |
|------------|-------------------|
| `enum=a,b,c;required` | `enum('a','b','c') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'a'` (first value) |
| `enum=a,b,c` | `enum('a','b','c') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL` |

::: warning
The enum and set collation suffix is always `_0900_ai_ci`, regardless of `MySQLOptions.DefaultCollate`.
:::

### Generated enum type

The type name defaults to the entity name without its `Entity` suffix followed by the field name: `OrderEntity.Status` becomes `OrderStatus`. Override it with `enumName=`. Constant names are built from the value by capitalising every `_`-separated part (`in_progress` becomes `InProgress`).

```go
// Generated: enums/OrderStatus.go
package enums

type OrderStatus string

var OrderStatusList = struct {
    Pending    OrderStatus
    Processing OrderStatus
    Shipped    OrderStatus
    Delivered  OrderStatus
}{
    Pending:    "pending",
    Processing: "processing",
    Shipped:    "shipped",
    Delivered:  "delivered",
}

func (e OrderStatus) Valid() bool
func (e OrderStatus) Values() []OrderStatus
```

```go
order := entities.OrderEntityProvider.New(ctx) // Status is pre-filled with "pending"
order.SetStatus(enums.OrderStatusList.Shipped)
status := order.GetStatus() // enums.OrderStatus

enums.OrderStatus("unknown").Valid() // false
```

`New()` and `NewWithID()` pre-fill every required enum and set field with its first value.

### Optional enums

Without `required` the getter returns a pointer and `nil` means `NULL`:

```go
type OrderEntity struct {
    ID             uint64
    Status         string `orm:"enum=pending,processing,shipped,delivered;required"`
    PreviousStatus string `orm:"enum=pending,processing,shipped,delivered;enumName=OrderStatus"`
}

prev := order.GetPreviousStatus() // *enums.OrderStatus
v := enums.OrderStatusList.Pending
order.SetPreviousStatus(&v)
order.SetPreviousStatus(nil)      // NULL
```

Here `enumName=OrderStatus` makes `PreviousStatus` reuse the type generated for `Status` instead of creating `OrderPreviousStatus`.

### Shared enums across entities

Define the values in exactly one entity and reference them elsewhere with `enum;enumName=X` or just `enumName=X`:

```go
type OrderEntity struct {
    ID     uint64
    Status string `orm:"enum=pending,processing,shipped,delivered;required;enumName=OrderStatus"`
}

type OrderLogEntity struct {
    ID     uint64
    Status string `orm:"enum;enumName=OrderStatus"`
}

type AuditLogEntity struct {
    ID             uint64
    PreviousStatus string `orm:"enumName=OrderStatus"`
}
```

Validation rules:

| Rule | Error |
|------|-------|
| `enum` without values needs `enumName` | `enum without values requires enumName in field '<f>' of entity '<e>'` |
| the referenced name must be defined somewhere | `enum/set '<name>' referenced in '<e>' but no entity defines its values` |
| two entities may not define different values for one name | `enum/set '<name>' has conflicting values defined in both '<a>' and '<b>', definition must be in only one entity` |

Several entities may repeat the same name with identical values.

## Sets

A `set=` tag creates a MySQL `SET` column that holds zero or more of the listed values:

```go
type ProductEntity struct {
    ID   uint64
    Tags string `orm:"set=sale,featured,new;required"`
}
```

| Definition | Column definition |
|------------|-------------------|
| `set=a,b,c;required` | `set('a','b','c') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL DEFAULT 'a'` |
| `set=a,b,c` | `set('a','b','c') CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci DEFAULT NULL` |

The generated type follows the enum rules (`ProductEntity.Tags` becomes `enums.ProductTags`, `enums.ProductTagsList`). The setter is variadic and the getter returns a slice:

```go
product.SetTags(enums.ProductTagsList.Sale, enums.ProductTagsList.Featured)
tags := product.GetTags() // []enums.ProductTags
```

Values are stored sorted and comma-separated. On an optional set, calling the setter with no values stores `NULL` and the getter returns `nil`. Sharing works like enums, but the field must keep the `set` tag: `orm:"set;enumName=ProductTags"` references the definition, while a bare `enumName=ProductTags` without `set` is treated as an enum reference and produces an `ENUM` column. A bare `set` without `enumName` fails with `set without values requires enumName in field '<f>' of entity '<e>'`. Set fields have no typed `Fields` descriptor.

## References

`fluxaorm.Reference[T]` stores the ID of another registered entity:

```go
type CategoryEntity struct {
    ID   uint64
    Name string `orm:"required"`
}

type ProductEntity struct {
    ID       uint64
    Name     string                             `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity] `orm:"required"`
    Brand    fluxaorm.Reference[BrandEntity]    // optional
}
```

| Definition | Column definition |
|------------|-------------------|
| `Reference[T]` + `required` | `bigint unsigned NOT NULL DEFAULT '0'` |
| `Reference[T]` | `bigint unsigned DEFAULT NULL` |

Generated accessors for a field `Category` referencing `CategoryEntity`:

```go
func (e *ProductEntity) GetCategoryID() uint64                                            // 0 when NULL
func (e *ProductEntity) SetCategory(value uint64) *ProductEntity                          // 0 stores NULL on an optional reference
func (e *ProductEntity) GetCategory(ctx fluxaorm.Context) (*CategoryEntity, bool, error)  // loads via CategoryEntityProvider.GetByID
func (e *ProductEntity) MustGetCategory(ctx fluxaorm.Context) (*CategoryEntity, error)    // panics "Category not found in ProductEntity" when missing
```

`GetCategory` returns `nil, false, nil` when the ID is `0`. The referenced entity type in the signature is the generated type of the target table, so it follows the target's `table` tag.

No foreign key constraint is created; existing `CONSTRAINT` lines on a table are reported by [GetAlters](/guide/schema_update.html) as `drop_foreign_key` alters.

### Multiple references

`fluxaorm.References[T]` stores a JSON array of IDs in a `text` column:

```go
type ProductEntity struct {
    ID   uint64
    Tags fluxaorm.References[TagEntity]
}
```

| Definition | Column definition |
|------------|-------------------|
| `References[T]` + `required` | `text NOT NULL DEFAULT ('')` |
| `References[T]` | `text DEFAULT NULL` |

```go
func (e *ProductEntity) GetTagsIDs() []uint64
func (e *ProductEntity) SetTagsIDs(ids []uint64) *ProductEntity            // nil stores NULL (optional only), empty slice stores "[]"
func (e *ProductEntity) GetTags(ctx fluxaorm.Context) ([]*TagEntity, error) // loads via TagEntityProvider.GetByIDs
```

`References[T]` fields have no typed `Fields` descriptor.

## Sub-Structs

A named struct field is flattened: every field of the sub-struct becomes a column prefixed with the parent field name. An anonymous embedded struct is flattened without a prefix.

```go
type Address struct {
    Country string
    City    string
}

type UserEntity struct {
    ID          uint64
    HomeAddress Address // columns HomeAddressCountry, HomeAddressCity
    Address             // columns Country, City
}

user.SetHomeAddressCity("New York")
user.SetCity("Boston")
```

::: warning
`orm` tags written on the fields inside the sub-struct are honoured only when the parent field itself carries **no** `orm` tag. Putting a tag on `HomeAddress` replaces the nested tags.
:::

## JSON Struct Fields

A pointer to a struct that is **not** a registered entity is serialised to JSON and stored in a `text` column:

```go
type Dimensions struct {
    Width  float64
    Height float64
}

type ProductEntity struct {
    ID   uint64
    Size *Dimensions
}
```

| Definition | Column definition |
|------------|-------------------|
| `*Struct` | `text DEFAULT NULL` |
| `*Struct` + `required` | `text NOT NULL DEFAULT ('')` |

```go
product.SetSize(&Dimensions{Width: 10, Height: 20})
product.SetSize(nil)        // NULL
size := product.GetSize()   // *Dimensions, nil when NULL
```

Only exported struct fields are serialised. A pointer to a registered entity type is rejected with `<entity> field <name> type *<type> is not supported` - use `fluxaorm.Reference[T]` instead. JSON fields have no typed `Fields` descriptor.

## Ignored Fields

`orm:"ignore"` removes a field from the schema entirely - no column, no accessors:

```go
type UserEntity struct {
    ID        uint64
    TempValue string `orm:"ignore"`
}
```

## Unsupported Types

Arrays (`[3]string`), slices other than `[]uint8`, maps, `*string`, and pointers to registered entities are not supported. Validation fails with `<entity> field <name> type <type> is not supported`.

## Typed Field Descriptors

Every column that can be filtered gets a descriptor in `Provider.Fields`, used by [search](/guide/search.html) and [unique index lookups](/guide/mysql_indexes.html):

| Go type | Descriptor | Condition methods |
|---------|------------|-------------------|
| `uint*`, `ID` | `fluxaorm.UintField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt`, `In` (`uint64`) |
| `int*` | `fluxaorm.IntField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt`, `In` (`int64`) |
| `float*` | `fluxaorm.FloatField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt`, `In` (`float64`) |
| `string` + `required` | `fluxaorm.StringField` | `Is`, `Like`, `In`, `IsEmpty` |
| `string` | `fluxaorm.NullableStringField` | `Is`, `Like`, `In`, `IsEmpty`, `IsNull`, `IsNotNull` |
| `bool` | `fluxaorm.BoolField` | `Is` |
| `time.Time` | `fluxaorm.TimeField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt` |
| enum + `required` | `fluxaorm.EnumField` | `Is`, `In` (`any`) |
| enum | `fluxaorm.NullableEnumField` | `Is`, `In`, `IsNull`, `IsNotNull` |
| `Reference[T]` + `required` | `fluxaorm.ReferenceField` | `Eq`, `In` (`uint64`) |
| `Reference[T]` | `fluxaorm.NullableUintField` | `Eq`, `Gte`, `Lte`, `Gt`, `Lt`, `In`, `IsNull`, `IsNotNull` |
| `*uint*`, `*int*`, `*float*`, `*bool`, `*time.Time` | `fluxaorm.NullableUintField`, `NullableIntField`, `NullableFloatField`, `NullableBoolField`, `NullableTimeField` | as above plus `IsNull`, `IsNotNull` |

`FakeDelete`, `[]uint8`, sets, `References[T]` and JSON struct fields have no descriptor.
