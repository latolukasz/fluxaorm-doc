# CRUD

In the previous sections, you learned how to configure BeeORM and update the MySQL schema. Now it's time to perform CRUD (Create, Read, Update, and Delete) actions using BeeORM.

The following examples build upon the following code base:

```go
package main

import "github.com/latolukasz/beeorm"

type CategoryEntity struct {
	beeorm.ORM  `orm:"redisCache"`
	ID          uint
	Code        string `orm:"required;length=10;unique=code"`
	Name        string `orm:"required;length=100"`
	FakeDelete  bool
}

type ImageEntity struct {
	beeorm.ORM `orm:"redisCache"`
	ID   uint
	Url string `orm:"required"`
}

type BrandEntity struct {
	beeorm.ORM `orm:"redisCache"`
	ID   uint
	Name string `orm:"required;length=100"`
	Logo *ImageEntity
}

type ProductEntity struct {
	beeorm.ORM `orm:"redisCache"`
	ID       uint
	Name     string `orm:"required;length=100"`
	Category *CategoryEntity `orm:"required"`
	Brand    *BrandEntity
}

func main() {
    registry := beeorm.NewRegistry()
    registry.RegisterMySQLPool("user:password@tcp(localhost:3306)/db") 
    registry.RegisterRedis("localhost:6379", 0)
    registry.RegisterEntity(&CategoryEntity{}, &BrandEntity{}, &ImageEntity{}, &ProductEntity{}) 
    validatedRegistry, err := registry.Validate()
    if err != nil {
        panic(err)
    }
    engine := validatedRegistry.CreateEngine()
}  
```

## Saving New Entities

There are various ways to store a new entity in a database using BeeORM. The simplest method is to use the `engine.Flush()` method, which inserts the entity into the database and updates its ID field with the primary key value:

<code-group>
<code-block title="code">
```go{2}
category := &CategoryEntity{Code: "cars", Name: "Cars"}
engine.Flush(category)
```
</code-block>

<code-block title="queries">
```queries
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?)
REDIS DELETE CacheForCategory1
```
</code-block>
</code-group>

You can save multiple entities at once:

<code-group>
<code-block title="code">
```go{4}
categoryCars := &CategoryEntity{Code: "cars", Name: "Cars"}
categoryBikes := &CategoryEntity{Code: "bikes", Name: "Bikes"}
product := &ProductEntity{Name: "BMW 1", Category: categoryCars}
engine.Flush(categoryCars, categoryBikes, product)
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?),(?, ?)
INSERT INTO `ProductEntity`(`Name`, `Category`) VALUES(?, ?)
REDIS DELETE CacheForCategory1, CacheForCategory2, CacheForProduct1
```
</code-block>
</code-group>

::: tip
Note that `Flush()` only generates two SQL queries, as BeeORM's query optimizer groups all queries to MySQL and Redis to minimize the number of queries. It is always more efficient to use `FlushMany()` to save multiple entities at once, rather than calling `Flush()` multiple times.
:::

Every time a new entity is saved to MySQL, BeeORM automatically sets the inserted primary key value in the ID field of the entity. Each entity provides a `GetID()` method that is useful if you pass the `beeorm.Entity` type in your code:

```go
func printID(entity beeorm.Entity) uint64 {
   fmt.Printf("ID: %d\n", entity.GetID())
}

categoryCars := &CategoryEntity{Code: "cars", Name: "Cars"}
categoryCars.ID // 0
engine.Flush(categoryCars)
categoryCars.ID // 1
printID(categoryCars) // "ID: 1"
```

If needed, you can define the ID for new entities by setting the ID field before flushing the entity:

<code-group>
<code-block title="code">
```go{1}
categoryCars := &CategoryEntity{ID: 10, Code: "cars", Name: "Cars"}
engine.Flush(categoryCars)
categoryCars.ID // 10
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `CategoryEntity`(`ID`, `Code`, `Name`) VALUES(10, ?, ?)
REDIS DELETE CacheForCategory10
```
</code-block>
</code-group>

By default, the `Flush()` method of BeeORM does not return any errors. Instead, it will panic if an error occurs. This approach is preferred in actions that connect to external services such as databases, as it ensures that any issues are immediately addressed. However, in some cases, you may want to handle specific errors that may occur when saving an entity. For example, you may want to catch errors related to duplicate or invalid values in MySQL indexes.

To handle these specific errors, you can use the `engine.FlushWithCheck()` method, which returns either a `*beeorm.DuplicatedKeyError` or a `*beeorm.ForeignKeyError` in case of a duplicate or invalid value in a MySQL index, respectively. Any other errors, such as an unavailable MySQL server, will still cause a panic.

Here is an example of using `engine.FlushWithCheck()` to handle specific errors:

<code-group>
<code-block title="code">
```go{3}
categoryCars := &CategoryEntity{Code: "cars", Name: "Cars"}
categoryCarsDuplicated := &CategoryEntity{ Code: "cars", Name: "Cars"}
err := engine.FlushWithCheck(categoryCars, categoryCarsDuplicated)
if err != nil {
    duplicatedError, is := err.(*beeorm.DuplicatedKeyError)
    if is {
       duplicatedError.Message // "Duplicate entry 'cars' for key 'code'"
       duplicatedError.Index // "code" 
    } else {
        foreignKeyError := err.(*beeorm.ForeignKeyError)
        duplicatedError.Message // "foreign key error in key `XXX`"
        duplicatedError.Constraint // "XXX"
    }
}
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?),(?, ?)
REDIS DELETE CacheForCategory1, CacheForCategory2
```
</code-block>
</code-group>

### On duplicate key update

MySQL has a useful feature called [INSERT ON DUPLICATE KEY UPDATE](https://dev.mysql.com/doc/refman/8.0/en/insert-on-duplicate.html) that allows you to update an existing entity if it has a duplicate key in the database. BeeORM fully supports this feature and allows you to use it through the SetOnDuplicateKeyUpdate() method of an entity.

For example, consider the following code:

<code-group>
<code-block title="code">
```go{3}
 // let's assume we have category in database with `Code` = cars and `ID` = 10:
category := &CategoryEntity{Code: "cars", Name: "Cars V2"}
category.SetOnDuplicateKeyUpdate(beeorm.Bind{"Name": "Cars V3"})
engine.Flush(categoryCars) // no panic
category.ID // 10
category.Name // "Cars V3"
```
</code-block>

<code-block title="queries">
```sql
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?) ON DUPLICATE KEY UPDATE `Name` = ?
REDIS DELETE CacheForCategory10
```
</code-block>
</code-group>

In some cases, you may not want to update any fields if the entity you are trying to insert has a duplicate key in the database. In this case, you can simply provide `nil` as the bind parameter when calling the `SetOnDuplicateKeyUpdate()` method.

For example, consider the following code:

<code-group>
<code-block title="code">
```go{3}
// Let's assume we have a category in the database with Code = "cars" and ID = 10:
category := &CategoryEntity{Code: "cars", Name: "Cars"}
category.SetOnDuplicateKeyUpdate(nil)
engine.Flush(category) // No panic
fmt.Println(category.ID) // 10
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?) ON DUPLICATE KEY UPDATE `ID` = `ID`
```
</code-block>
</code-group>

As you can see, the Flush() method does not panic and the ID field of the category entity is set to 10. The ON DUPLICATE KEY UPDATE clause ensures that no fields are updated if a duplicate key is detected.

### Flushing References

BeeORM automatically flushes all new entities (entities with an ID of 0) that are assigned as references in a flushed entity. For example:

<code-group>
<code-block title="code">
```go
categoryCars := &CategoryEntity{Code: "cars", Name: "Cars"}
categoryDogs := &CategoryEntity{Code: "dogs", Name: "Dogs"}
bmw1 := &ProductEntity{Name: "BMW 1", Category: categoryCars}
fordFocus := &ProductEntity{Name: "Ford focus", Category: categoryCars}
cockerSpaniel := &ProductEntity{Name: "Cocker spaniel", Category: categoryDogs}
engine.Flush(bmw1, fordFocus) // we are flushing only products
bmw1.Category.ID // 1
fordFocus.Category.ID // 1
cockerSpaniel.Category.ID // 2
categoryCars.ID // 1
categoryDogs.ID // 2
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?),(?,?)
INSERT INTO `ProductEntity`(`Name`, `Category`) VALUES(?, ?)(?,?)
REDIS DELETE CacheForCategory1, CacheForCategory2, CacheForProduct1, CacheForProduct2
```
</code-block>
</code-group>


Sometimes you may need to define a referenced entity, but you only know its `ID` value. In this case, you can assign it as a new entity with the `ID` field set to the correct value:

<code-group>
<code-block title="code">
```go{1}
product := &ProductEntity{Name: "Ford focus", Category: &CategoryEntity{ID: 7}}
engine.Flush()
```
</code-block>

<code-block title="sql">
```queries
INSERT INTO `ProductEntity`(`Name`, `Category`) VALUES(?, 7)
REDIS DELETE CacheForProduct1
```
</code-block>
</code-group>

Note that the CategoryEntity with an ID of 7 will not be inserted into the database, as it is being referenced rather than created as a new entity.

## Dirty State

An entity is considered "dirty" if it has changes that need to be applied to the corresponding MySQL table. Examples of dirty states include:

 * A new entity that needs to be inserted into the MySQL table.
 * An entity that needs to be deleted.
 * An entity that needs to be edited in the MySQL table because at least one column value has changed.

You can check the dirty state of an entity using the `IsDirty()` method. The `GetDirtyBind()` method returns a map with the fields that need to be inserted or updated.

```go{2-3}
category := &CategoryEntity{Code: "cars", Name: "Cars"}
category.IsDirty() // true, entity needs to be inserted in MySQL table
bind, isDirty := category.GetDirtyBind() // isDirty = true
fmt.Printf("%v", bind) // {"Code: "cars", "Name": "Cars"}

engine.Flush(category)

category.IsDirty() // false
category.Code = "vehicles"
category.IsDirty() // true
bind, isDirty := category.GetDirtyBind() // isDirty = true
fmt.Printf("%v", bind) // {"Code: "vehicles"}
category.Code = "cars" // setting back to oryginal value
bind, isDirty := category.GetDirtyBind() // isDirty = false
```

You can flush entities that are not dirty, but BeeORM will simply skip these entities and no queries will be sent to MySQL. This means that you can run the `Flush()` method as many times as you want, and BeeORM will only update the database and cache when it is necessary.

```go
// we don't know what changes were made to the category inside the `DoSmthWithCactegory` method: 
some_package.DoSmthWithCactegory(category)
// but we ask BeeORM to save any changes that were made:
engine.Flush(category)
```

## Loading Entities

There are several ways to load entities from the database when you know the primary key. 

You can use the `engine.Load()` method:

<code-group>
<code-block title="code">
```go{2}
product := &ProductEntity{ID: 1} // provide ID
found := engine.Load(product) // true
```
</code-block>

<code-block title="queries hit">
```sql
[HIT] REDIS GET cacheKeyForProduct1
```
</code-block>

<code-block title="queries miss">
```sql
[MISS] REDIS GET cacheKeyForProduct1
SELECT `ID`, `Name`, `Category` FROM `Products` WHERE `ID` = 1 
REDIS SET cacheKeyForProduct1 "entity data"
```
</code-block>
</code-group>

Another option is to use `engine.LoadByID()`:

<code-group>
<code-block title="code">
```go{2}
product := &ProductEntity{}
found := engine.LoadByID(1, product) // true
```
</code-block>

<code-block title="queries hit">
```sql
[HIT] REDIS GET cacheKeyForProduct1
```
</code-block>

<code-block title="queries miss">
```sql
[MISS] REDIS GET cacheKeyForProduct1
SELECT `ID`, `Name`, `Category` FROM `Products` WHERE `ID` = 1 
REDIS SET cacheKeyForProduct1 "entity data"
```
</code-block>
</code-group>

If you need to load more than one entity, you can use `engine.LoadByIDs()`:

<code-group>
<code-block title="code">
```go{2}
var products []*ProductEntity{}
engine.LoadByIDs([]uint64{1, 2}, &products)
len(products) == 2 // true
products[0].ID // 1
products[1].ID // 2
```
</code-block>

<code-block title="queries hit">
```sql
[HIT,HIT] REDIS MGET cacheKeyForProducts1 cacheKeyForProducts2
```
</code-block>

<code-block title="queries miss">
```sql
[MISS,MISS] REDIS MGET cacheKeyForProducts1 cacheKeyForProducts2
SELECT `ID`, `Name`, `Category` FROM `Products` WHERE `ID` IN (1, 2) 
REDIS MSET cacheKeyForProducts1 "entity1 data" cacheKeyForProducts2 "entity2 data"
```
</code-block>
</code-group>

If an entity is not found, it will be returned as `nil`:

```go
// we have only products with IDs 1 and 2 in the table
var products []*ProductEntity{}
engine.LoadByIDs([]uint64{1, 2, 3}, &products)
len(products) == 3 // true
products[0].ID // 1
products[1].ID // 2
products[2] == nil // true
```

### Loaded State

Every entity stores internally the data that is stored in the corresponding MySQL table. This allows BeeORM to track changes and determine if an entity is "dirty" and needs to be flushed (saved) to the database. This data is stored in the entity every time a new entity is flushed or loaded from the database. You can use the `entity.IsLoaded()` method to determine if an entity has this data and can track changes:

```go{2,4,7,9,12,14}
category := &CategoryEntity{ID: 22, Code: "cars", Name: "Cars"}
category.IsLoaded() // false, entity needs to be inserted in MySQL table
engine.FLush(category)
category.IsLoaded() // true, entity data is saved in database

product := &ProductEntity{}
product.IsLoaded() // false
engine.LoadByID(1, product)
product.IsLoaded() // true, entity data is loaded from database

product2 := &ProductEntity{ID: 2}
product2.IsLoaded() // false
product.Load(product2)
product2.IsLoaded() // true
```

The `entity.IsLoaded()` and `entity.Load()` methods are particularly useful when working with references:

```go{3-5}
product := &ProductEntity{}
engine.LoadByID(1, product)
product.Category.Loaded() // false
engine.Load(product.Category)
product.Category.Loaded() // true
```

## Loading References

Often when loading an entity, you also need data from the connected referenced entities. For example, on a product page, you might need to display the product title, its category, brand, and brand logo. One way to do this is as follows:

<code-group>
<code-block title="code">
```go
product := &ProductEntity{}
engine.LoadByID(1, product)
product.Name // returns "Ford focus"
product.Category.ID // returns 1
product.Brand.ID // returns 1
product.Category.Name // returns an empty string because the entity data is not Loaded
product.Brand.Name // returns an empty string because the entity data is not Loaded
product.Brand.Logo // returns nil because the entity data is not Loaded
engine.Load(product.Category)
engine.Load(product.Brand)
product.Category.Name // returns "Cars"
product.Brand.Name // returns "Ford"
product.Brand.Logo.ID // returns 1
product.Brand.Logo.Name // returns an empty string because the entity data is not Loaded
engine.Load(product.Brand.Logo)
product.Brand.Logo.Url // returns "/images/ford.png"
```
</code-block>

<code-block title="queries hit">
```sql
[HIT] REDIS GET cacheKeyForProduct1
[HIT] REDIS GET cacheKeyForCategory1
[HIT] REDIS GET cacheKeyForBrand1
[HIT] REDIS GET cacheKeyForImage1
```
</code-block>

<code-block title="queries miss">
```sql
[MISS] REDIS GET cacheKeyForProduct1
SELECT `ID`, `Name`, `Category`, `Brand` FROM `ProductEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForProduct1 "entity data"
[MISS] REDIS GET cacheKeyForCategory1
SELECT `ID`, `Name` FROM `CategoryEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForCategory1 "entity data"
[MISS] REDIS GET cacheKeyForBrand1
SELECT `ID`, `Name` FROM `BrandEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForBrand1 "entity data"
[MISS] REDIS GET cacheKeyForImage1
SELECT `ID`, `Url` FROM `ImageEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForImage1 "entity data"
```
</code-block>
</code-group>

Is it possible to make this code simpler and faster? Every method used to load entities, such as `Load()`, `LoadByID()`, and `LoadByIDs()`, accepts optional references parameters that can be used to instruct BeeORM to load specific references together with the entity:

<code-group>
<code-block title="code">
```go{2}
product := &ProductEntity{}
engine.LoadByID(1, product, "Category", "Brand/Logo")
product.Name // "Ford focus"
product.Category.Name // "Cars"
product.Brand.Name // "Ford"
product.Brand.Logo.Url // "/images/ford.png"
```
</code-block>

<code-block title="queries hit">
```sql
[HIT] REDIS GET cacheKeyForProduct1
[HIT] REDIS MGET cacheKeyForCategory1 cacheKeyForBrand1
[HIT] REDIS GET cacheKeyForImage1
```
</code-block>

<code-block title="queries miss">
```sql
[MISS] REDIS GET cacheKeyForProduct1
SELECT `ID`, `Name`, `Category`, `Brand` FROM `ProductEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForProduct1 "entity data"
[MISS] REDIS MGET cacheKeyForCategory1 cacheKeyForBrand1
SELECT `ID`, `Name` FROM `CategoryEntity` WHERE `ID`= 1 
SELECT `ID`, `Name` FROM `BrandEntity` WHERE `ID`= 1 
REDIS MSET cacheKeyForCategory1 "entity data" cacheKeyForBrand1 "entity data"
[MISS] REDIS GET cacheKeyForImage1
SELECT `ID`, `Url` FROM `ImageEntity` WHERE `ID`= 1 
REDIS SET cacheKeyForImage1 "entity data"
```
</code-block>
</code-group>

As you can see, the code above is not only simpler, but it also produces fewer requests to MySQL and Redis. Notice how queries are generated when you use the references feature to load multiple entities at once:

<code-group>
<code-block title="code">
```go{2}
var products []*ProductEntity{}
engine.LoadByIDs(uint64{1, 2, 3}, &products, "Category", "Brand/Logo")
```
</code-block>

<code-block title="queries hit">
```sql
[HIT] REDIS MGET cacheKeyForProduct1 cacheKeyForProduct2 cacheKeyForProduct3
[HIT] REDIS MGET cacheKeyForCategory1 cacheKeyForCategory2 cacheKeyForCategory3 cacheKeyForBrand1 cacheKeyForBrand2 cacheKeyForBrand3
[HIT] REDIS MGET cacheKeyForImage1 cacheKeyForImage2 cacheKeyForImage3
```
</code-block>


<code-block title="queries miss">
```sql
[MISS] REDIS MGET cacheKeyForProduct1 cacheKeyForProduct2 cacheKeyForProduct3
SELECT `ID`, `Name`, `Category`, `Brand` FROM `ProductEntity` WHERE `ID` IN (1, 2, 3) 
REDIS MSET cacheKeyForProduct1 "entity data" cacheKeyForProduct2 "entity data" cacheKeyForProduct3 "entity data"
[MISS] REDIS MGET cacheKeyForCategory1 cacheKeyForCategory2 cacheKeyForCategory4 cacheKeyForBrand1 cacheKeyForBrand2 cacheKeyForBrand3
SELECT `ID`, `Name` FROM `CategoryEntity` WHERE `ID` IN (1, 2, 3) 
SELECT `ID`, `Name` FROM `BrandEntity` WHERE `ID` IN (1, 2, 3) 
REDIS MSET cacheKeyForCategory1 "entity data" cacheKeyForCategory2 "entity data" cacheKeyForCategory3 "entity data" cacheKeyForBrand1 "entity data" cacheKeyForBrand2 "entity data" cacheKeyForBrand3 "entity data"
[MISS] REDIS MGET cacheKeyForImage1 cacheKeyForImage2 cacheKeyForImage3
SELECT `ID`, `Url` FROM `ImageEntity` WHERE `ID` IN (1, 2, 3) 
REDIS MSET cacheKeyForImage1 "entity data" cacheKeyForImage2 "entity data" cacheKeyForImage3 "entity data"
```
</code-block>
</code-group>

This code generates only three queries to Redis, making it a very efficient way to load multiple entities with their references. Isn't that cool?

## Updating entities

Updating entities with BeeORM is straightforward. You can update entity by calling the `Flush()` method on the entities.

<code-group>
<code-block title="code">
```go{4}
product := &ProductEntity{}
engine.LoadByID(1, product)
product.Name = "New name"
engine.Flush(product)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS GET cacheKeyForProduct1
UPDATE `ProductEntity` SET `Name` = ? WHERE `ID` = 1
REDIS DELETE cacheKeyForProduct1
```
</code-block>
</code-group>


<code-group>
<code-block title="code">
```go{8}
var products []*ProductEntity
engine.LoadByIDs(int64{1, 2}, &products)
category := &CategoryEntity{}
engine.LoadByID(1, &category)
products[0].Name = "New name"
products[1].Name = "Another name"
category.Name = "New name"
engine.Flush(category, products[0], products[1])
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS MGET cacheKeyForCategory1 cacheKeyForProduct1 cacheKeyForProduct2
UPDATE `CategoryEntity` SET `Name` = ? WHERE `ID` = 1
UPDATE `ProductEntity` SET `Name` = ? WHERE `ID` = 1
UPDATE `ProductEntity` SET `Name` = ? WHERE `ID` = 2
REDIS DELETE cacheKeyForCategory1 cacheKeyForProduct1 cacheKeyForProduct2
```
</code-block>
</code-group>

To update an entity, you first need to load it from the database using a method like `LoadByID()`. Then, you can modify the entity's properties and call `Flush()` to persist the changes to the database. BeeORM will automatically generate the necessary `SQL UPDATE` statement and execute it against the database, as well as invalidate any relevant cache entries to ensure that the updated data is reflected in future queries.

It's important to note that you can only update entities that are already loaded and have their data stored internally. If you try to update an entity that has not been loaded, BeeORM will return an error.

In the example provided, the code loads two ProductEntity instances and a CategoryEntity instance from the database, then modifies the Name property of each entity and calls `Flush()` to update all three entities in a single batch. This results in three `UPDATE` statements being executed against the database, and the relevant cache entries being invalidated to ensure that the updated data is reflected in future queries.

## Cloning entities

Sometimes you may need to create a copy of an entity, make some changes to it, and save it as a new row in the database. You can easily do this using the `entity.Clone()` method:

```go{3}
category := &CategoryEntity{}
engine.LoadByID(1, category)
newCategory := category.Clone(*CategoryEntity)
newCategory.Name = "New name"
engine.Flush(newCategory)
```

This will create a copy of the category entity, assign a new value to its Name field, and save it as a new row in the database. The original category entity will remain unchanged.

## Deleting Entities

In BeeORM, entities can be deleted from a MySQL table using the `engine.Delete()` method. For example:

<code-group>
<code-block title="code">
```go{3}
product := &ProductEntity{}
engine.LoadByID(1, product)
engine.Delete(product)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS GET cacheKeyForProduct1
DELETE FROM `ProductEntity` WHERE `ID` = 1
REDIS SET cacheKeyForProduct1 "nil"
```
</code-block>
</code-group>

This will delete the `ProductEntity` with an ID of 1 from the table.

To delete multiple entities at once:

<code-group>
<code-block title="code">
```go
engine.Delete(product1, product1, product3)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS MGET cacheKeyForProduct1 cacheKeyForProduct1
DELETE FROM `ProductEntity` WHERE `ID` IN (1, 2)
REDIS MSET cacheKeyForProduct1 "nil" cacheKeyForProduct2 "nil"
```
</code-block>
</code-group>

This will delete all ProductEntity objects with an ID of 1 or 2 from the table.

If the entity has a  [FakeDelete field](/guide/entity_fields.html#fake-delete), the above methods will work differently. Instead of deleting rows from the table, a special update query will be executed:

<code-group>
<code-block title="code">
```go{3}
category := &CategoryEntity{}
engine.LoadByID(3, category)
engine.Delete(category)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS GET cacheKeyForCategory3
UPDATE `CategoryEntity` SET `FakeDelete` = 3 WHERE `ID` = 3
REDIS DELETE cacheKeyForCategory3
```
</code-block>
</code-group>

This will update the FakeDelete field for the CategoryEntity with an ID of 3 in the table, rather than deleting the row.

To force an entity with a `FakeDelete` field to be deleted from the MySQL table, use the `engine.ForceDelete()` method:

<code-group>
<code-block title="code">
```go{3}
category := &CategoryEntity{}
engine.LoadByID(3, category)
engine.ForceDelete(category)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS GET cacheKeyForCategory3
DELETE FROM `CategoryEntity` WHERE `ID` = 3
REDIS SET cacheKeyForCategory3 "nil"
```
</code-block>
</code-group>

This will delete the `CategoryEntity` with an ID of 3 from the table, even if it has a `FakeDelete` field.

## Using the Flusher

The `beeorm.Flusher` is a useful tool in BeeORM when you need to add, update, and delete multiple entities at the same time. It allows you to "track" entities and provides flush methods that update all tracked dirty entities at once.

Here's an example of using the `Flusher`:

<code-group>
<code-block title="code">
```go{1,5,9,12,15}
flusher := engine.NewFlusher()

category := &CategoryEntity{Name: "New category"}
brand := &BrandEntity{Name: "New brand"}
flusher.Track(category, brand)
product := &ProductEntity{}
engine.LoadByID(1, product)
product.Name = "New Name"
flusher.Track(product)
categoryToDelete := &CategoryEntity{}
engine.LoadByID(10, categoryToDelete)
flusher.Delete(categoryToDelete)
categoryToDeleteFromTable := &CategoryEntity{}
engine.LoadByID(11, categoryToDeleteFromTable)
flusher.ForceDelete(categoryToDeleteFromTable)
```
</code-block>

<code-block title="queries">
```sql
[HIT] REDIS GET cacheKeyForProduct1
[HIT] REDIS GET cacheKeyForCategory10
[HIT] REDIS GET cacheKeyForCategory11
```
</code-block>
</code-group>

Once you have finished tracking the entities you want to update or delete, you can execute the updates and deletions by calling the `Flush()` method on the `Flusher` object:

<code-group>
<code-block title="code">
```go
flusher.Flush()
```
</code-block>

<code-block title="queries">
```sql
INSERT INTO `CategoryEntity`(`Code`, `Name`) VALUES(?, ?)
INSERT INTO `BrandEntity`(`Code`, `Name`) VALUES(?, ?)
UPDATE `ProductEntity` SET `Name` = ? WHERE `ID` = 1
UPDATE `CategoryEntity` SET `FakeDelete` = 10 WHERE `ID` = 10
DELETE FROM `CategoryEntity` WHERE `ID` = 11
REDIS DELETE cacheKeyForCategory1 cacheKeyForCategory2 cacheKeyForCategory11 cacheKeyForCategory12 cacheKeyForProduct1
```
</code-block>
</code-group>

This will execute all of the necessary queries to update or delete the tracked entities in the database. For example, if you tracked an entity to be inserted, updated, and deleted, the `Flush()` method will execute the appropriate INSERT, UPDATE, and DELETE queries.


The `beeorm.Flusher` provides several methods for flushing tracked entities to the database. These methods include:

 * `FlushWithCheck()`, which returns a `*beeorm.DuplicatedKeyError` or `*beeorm.ForeignKeyError` if an error occurs during the flush.
 * `FlushWithFullCheck()`, which returns an error instead of panicking if an error occurs during the flush.


```go
// returns *beeorm.DuplicatedKeyError or *beeorm.ForeignKeyError
err := flusher.FlushWithCheck()
```

```go
// returns error instead of panicing 
err := flusher.FlushWithFullCheck()
```

The `beeorm.Flusher` allows you to track entities for updates and deletions, but it does not remove them from the tracker after they are flushed to the database. To stop tracking an entity, you can use the `flusher.Clear()` method.

For example:

```go{7}
category := &CategoryEntity{Name: "New category"}
flusher := engine.NewFlusher()
flusher.Track(category)
flusher.Flush() // insert category into MySQL table
category.Name = "New name"
flusher.Flush() // updates category in MySQL table
flusher.Clear()
category.Name = "Another name"
flusher.Flush() // does nothing, category is not tracked
```

This code will insert the category entity into the database, then update it with a new name. However, after the `flusher.Clear()` method is called, any further updates to the category entity will not be tracked and will not be applied to the database when the `Flush()` method is called.

## Clearing Entity Cache

In BeeORM, you can use the `beeorm.ClearCacheByIDs()` method to manually clear cached entity data. This can be useful if you need to update the cache after making changes to an entity in the database.

Here's an example of how to use the `ClearCacheByIDs()` method:

```go{2}
var categoryEntity CategoryEntity
engine.ClearCacheByIDs(categoryEntity, 7, 13, 33)
```

This will clear the cache for the specified entities with the IDs 7, 13, and 33 of the CategoryEntity type. After calling this method, the next time these entities are loaded from the database, the cache will be updated with the latest data from the database.

