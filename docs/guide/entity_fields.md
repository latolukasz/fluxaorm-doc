# Entity Fields

In FluxaORM v2, every public field in an entity struct (starting with an uppercase letter) is stored as a column in MySQL. After running code generation, each field gets typed getter and setter methods on the generated Entity type.

For example, a `Name string` field produces `entity.GetName()` and `entity.SetName(value)`. You never access entity fields directly -- all access goes through generated methods.

## Integers

FluxaORM supports all Go integer types. Here is an example:

```go
type UserEntity struct {
    ID                 uint64
    Age                uint8
    BankAccountBalance int32
}
```

After code generation, you access these fields via getters and setters:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetAge(25)
user.SetBankAccountBalance(-1500)

age := user.GetAge()             // returns uint64
balance := user.GetBankAccountBalance() // returns int64
```

::: tip
Note that the generated getters return widened types: all unsigned integers return `uint64`, and all signed integers return `int64`. The setters also accept these widened types. FluxaORM handles the conversion to the correct MySQL column size internally.
:::

The table below shows how Go integer types map to MySQL column types:

| Go Type | MySQL Type | Min Value | Max Value |
|---------|-----------|-----------|-----------|
| int8 | tinyint | -128 | 127 |
| int16 | smallint | -32768 | 32767 |
| int32 with tag `orm:"mediumint"` | mediumint | -8388608 | 8388607 |
| int32, int, rune | int | -2147483648 | 2147483647 |
| int64 | bigint | -2^63 | 2^63-1 |
| uint8 | tinyint unsigned | 0 | 255 |
| uint16 | smallint unsigned | 0 | 65535 |
| uint32 with tag `orm:"mediumint"` | mediumint unsigned | 0 | 16777215 |
| uint32, uint | int unsigned | 0 | 4294967295 |
| uint64 | bigint unsigned | 0 | 2^64-1 |

::: tip
Always choose the smallest integer type that fits your data:

- Use unsigned types (uint8, uint16, etc.) for values that are always positive.
- Use the smallest bit size possible. For example, `uint8` is sufficient for a person's age since no one lives beyond 255 years.
- Choosing the right type saves MySQL disk space and reduces index memory usage.
:::

### Nullable Integers

To store NULL values, use pointer types (`*uint8`, `*int32`, etc.). In MySQL, these fields are defined with `DEFAULT NULL`:

```go
type UserEntity struct {
    ID      uint64
    Friends *uint32  // NULL if unknown, 0 if no friends
}
```

After generation:

```go
user := entities.UserEntityProvider.New(ctx)

// Nullable getters return pointers
friends := user.GetFriends()  // returns *uint64 (nil when NULL)

// Nullable setters accept pointers
count := uint64(5)
user.SetFriends(&count)
user.SetFriends(nil)  // sets to NULL
```

## Floats

FluxaORM supports `float32` and `float64` types. Use struct tags to control the MySQL column type:

```go
type ProductEntity struct {
    ID          uint64
    Price       float64
    Temperature float32 `orm:"decimal=5,1;unsigned"`
    Weight      float32 `orm:"unsigned"`
}
```

| Go Type | MySQL Type |
|---------|-----------|
| float32 | float |
| float32 with `orm:"unsigned"` | float unsigned |
| float64 | double |
| float64 with `orm:"unsigned"` | double unsigned |
| float32/float64 with `orm:"decimal=X,Y"` | decimal(X,Y) |
| float32/float64 with `orm:"decimal=X,Y;unsigned"` | decimal(X,Y) unsigned |

After generation, all float getters return `float64` and all setters accept `float64`:

```go
product := entities.ProductEntityProvider.New(ctx)
product.SetPrice(29.99)
product.SetWeight(1.5)

price := product.GetPrice()  // returns float64
```

### Nullable Floats

Use `*float32` or `*float64` for nullable float columns:

```go
type ProductEntity struct {
    ID       uint64
    Discount *float64  // NULL means no discount
}
```

After generation:

```go
discount := product.GetDiscount()  // returns *float64

val := 15.5
product.SetDiscount(&val)
product.SetDiscount(nil)  // sets to NULL
```

## Booleans

Use `bool` for boolean fields. They map to MySQL `tinyint(1)`:

```go
type UserEntity struct {
    ID          uint64
    Active      bool
    HasChildren *bool  // nullable
}
```

| Go Type | MySQL Type |
|---------|-----------|
| bool | tinyint(1) NOT NULL |
| *bool | tinyint(1) DEFAULT NULL |

After generation:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetActive(true)
active := user.GetActive()  // returns bool

isTrue := true
user.SetHasChildren(&isTrue)
hasChildren := user.GetHasChildren()  // returns *bool
```

## Strings

Use `string` for text fields. By default, strings map to `varchar(255)`:

```go
type ProductEntity struct {
    ID          uint64
    Title       string `orm:"required;length=150"`
    Description string `orm:"length=max"`
    Brand       string
}
```

| Go Type | MySQL Type |
|---------|-----------|
| string | varchar(255) DEFAULT NULL |
| string with `orm:"required"` | varchar(255) NOT NULL |
| string with `orm:"length=X"` | varchar(X) |
| string with `orm:"length=max"` | mediumtext |

After generation:

```go
product := entities.ProductEntityProvider.New(ctx)
product.SetTitle("Wireless Mouse")
product.SetDescription("A high-quality wireless mouse...")

title := product.GetTitle()  // returns string (for required fields)
brand := product.GetBrand()  // returns *string (nil when NULL, for non-required fields)
```

::: tip
Non-required string fields (without the `orm:"required"` tag) are nullable in MySQL. Their generated getters return `*string`, and empty strings in MySQL are stored as NULL. Add `orm:"required"` when the field should never be NULL -- this saves MySQL storage space and simplifies your code since the getter returns `string` directly.
:::

## Dates and Times

Use `time.Time` to store date or datetime values:

```go
type UserEntity struct {
    ID          uint64
    DateOfBirth time.Time
    CreatedAt   time.Time  `orm:"time"`
    LastLogin   *time.Time `orm:"time"`
}
```

| Go Type | MySQL Type |
|---------|-----------|
| time.Time | date NOT NULL |
| time.Time with `orm:"time"` | datetime NOT NULL |
| *time.Time | date DEFAULT NULL |
| *time.Time with `orm:"time"` | datetime DEFAULT NULL |

By default, `time.Time` maps to a `date` column (date only, no time component). Add the `orm:"time"` tag to store both date and time as a `datetime` column.

After generation:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetDateOfBirth(time.Date(1990, 6, 15, 0, 0, 0, 0, time.UTC))
user.SetCreatedAt(time.Now().UTC())

dob := user.GetDateOfBirth()   // returns time.Time
login := user.GetLastLogin()   // returns *time.Time (nil when NULL)
```

::: tip
DateTime values are automatically truncated to second precision. Date values are truncated to day precision. All times are stored in UTC.
:::

## Binary Data

Use `[]uint8` (or `[]byte`) to store binary data:

```go
type UserEntity struct {
    ID        uint64
    Avatar    []uint8
    Document  []uint8 `orm:"mediumblob"`
    LargeFile []uint8 `orm:"longblob"`
}
```

| Go Type | MySQL Type |
|---------|-----------|
| []uint8 | blob |
| []uint8 with `orm:"mediumblob"` | mediumblob |
| []uint8 with `orm:"longblob"` | longblob |

After generation:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetAvatar(imageBytes)

avatar := user.GetAvatar()  // returns []uint8
```

## Enums

Define an enum directly in the struct tag using `orm:"enum=value1,value2,value3"`:

```go
type OrderEntity struct {
    ID     uint64
    Status string `orm:"enum=pending,processing,shipped,delivered;required"`
}
```

This creates a MySQL `ENUM('pending','processing','shipped','delivered') NOT NULL` column.

The code generator creates a typed enum in the `enums/` subdirectory:

```go
// Generated: enums/Status.go
package enums

type Status string
var StatusList = struct {
    Pending    Status
    Processing Status
    Shipped    Status
    Delivered  Status
}{
    Pending:    "pending",
    Processing: "processing",
    Shipped:    "shipped",
    Delivered:  "delivered",
}
```

After generation, use the typed constants:

```go
import "your/module/entities/enums"

order := entities.OrderEntityProvider.New(ctx)
order.SetStatus(enums.StatusList.Pending)

status := order.GetStatus()  // returns enums.Status
```

### Optional Enums

Without `orm:"required"`, the enum field is nullable. The getter returns a pointer:

```go
type OrderEntity struct {
    ID             uint64
    Status         string `orm:"enum=pending,processing,shipped,delivered;required"`
    PreviousStatus string `orm:"enum=pending,processing,shipped,delivered;enumName=Status"`
}
```

```go
prev := order.GetPreviousStatus()  // returns *enums.Status (nil when NULL)

val := enums.StatusList.Pending
order.SetPreviousStatus(&val)
order.SetPreviousStatus(nil)  // sets to NULL
```

The `enumName=Status` tag tells the generator to reuse the `Status` enum type for this field instead of creating a separate type.

## Sets

Define a set using `orm:"set=value1,value2,value3"`:

```go
type ProductEntity struct {
    ID   uint64
    Tags string `orm:"set=sale,featured,new;required"`
}
```

This creates a MySQL `SET('sale','featured','new') NOT NULL` column. A set can hold zero or more of the specified values simultaneously.

After generation, the setter accepts variadic values and the getter returns a slice:

```go
import "your/module/entities/enums"

product := entities.ProductEntityProvider.New(ctx)
product.SetTags(enums.TagsList.Sale, enums.TagsList.Featured)

tags := product.GetTags()  // returns []enums.Tags
```

### Optional Sets

Without `orm:"required"`, the getter returns `nil` when no values are set:

```go
type ProductEntity struct {
    ID        uint64
    Tags      string `orm:"set=sale,featured,new;required"`
    ExtraTags string `orm:"set=sale,featured,new;enumName=Tags"`
}
```

```go
extra := product.GetExtraTags()  // returns []enums.Tags (nil when empty)
```

## References

Use `fluxaorm.Reference[T]` to create a foreign key relationship to another entity:

```go
import "github.com/latolukasz/fluxaorm/v2"

type CategoryEntity struct {
    ID   uint64
    Name string `orm:"required"`
}

type ProductEntity struct {
    ID       uint64
    Name     string                                `orm:"required"`
    Category fluxaorm.Reference[CategoryEntity]     `orm:"required"`
    Brand    fluxaorm.Reference[CategoryEntity]     // optional reference
}
```

A required reference creates a `bigint NOT NULL` column. An optional reference creates a `bigint DEFAULT NULL` column.

After generation:

```go
product := entities.ProductEntityProvider.New(ctx)

// Required reference: getter returns uint64, setter accepts uint64
product.SetCategory(categoryID)
catID := product.GetCategoryID()  // returns uint64

// Optional reference: getter returns *uint64, setter accepts uint64 (0 to clear)
product.SetBrand(brandID)
brandID := product.GetBrandID()  // returns *uint64 (nil when NULL)
product.SetBrand(0)              // sets to NULL
```

## Subfields (Embedded Structs)

You can group fields into separate structs for reuse and organization:

```go
type Address struct {
    Country    string
    City       string
    Street     string
    Building   uint32
    PostalCode string
}

type UserEntity struct {
    ID          uint64
    HomeAddress Address
    WorkAddress Address
}

type CategoryEntity struct {
    ID      uint64
    Address Address
}
```

Each field in the substruct becomes a MySQL column with the parent field name as a prefix. For example, `HomeAddress.Country` maps to a `HomeAddressCountry varchar(255)` column.

After generation:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetHomeAddressCountry("US")
user.SetHomeAddressCity("New York")

country := user.GetHomeAddressCountry()
```

### Anonymous (Embedded) Subfields

When you embed a struct anonymously, the fields appear without a prefix:

```go
type Address struct {
    Country string
    City    string
}

type UserEntity struct {
    ID uint64
    Address  // anonymous embed
}
```

The `Country` field maps directly to a `Country varchar(255)` column (no prefix).

After generation:

```go
user := entities.UserEntityProvider.New(ctx)
user.SetCountry("US")
```

## Arrays

Use Go arrays to create numbered column groups:

```go
type UserEntity struct {
    ID              uint64
    Alias           [3]string
    Top5Categories  [5]fluxaorm.Reference[CategoryEntity] `orm:"required"`
}
```

Each array element is stored in a separate MySQL column. The example above creates columns like `Alias_1 varchar(255)`, `Alias_2 varchar(255)`, `Alias_3 varchar(255)`, and so on.

## Ignored Fields

To exclude a public field from MySQL storage, use the `orm:"ignore"` tag:

```go
type UserEntity struct {
    ID        uint64
    TempValue string `orm:"ignore"`
}
```

FluxaORM will not create a MySQL column for `TempValue`. This is useful for transient or computed data that does not belong in the database.
