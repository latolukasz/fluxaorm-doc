# Fake Delete

In many applications, you want to mark entities as deleted instead of permanently removing them from the database. FluxaORM supports this pattern through fake delete (also known as soft delete).

## Enabling Fake Delete

To enable fake delete on an entity, add a `FakeDelete bool` field to your entity struct:

```go
type UserEntity struct {
    ID         uint64
    Name       string
    Email      string
    FakeDelete bool
}
```

When the schema is validated, FluxaORM automatically:

1. Adds a `FakeDelete` column to the MySQL table (same type as the `bool` column).
2. Adds a `FakeDelete` index to the table.
3. Appends `FakeDelete` to all existing MySQL indexes (including unique indexes). This ensures that fake-deleted entities do not cause duplicate key constraint violations.

## Deleting an Entity (Soft Delete)

Call `Delete()` on an entity to mark it as fake-deleted:

```go
user, found, err := UserEntityProvider.GetByID(ctx, 3)
user.Delete()
err = ctx.Flush() // UPDATE `UserEntity` SET `FakeDelete` = 1 WHERE `ID` = 3
```

The `Delete()` method sets the `FakeDelete` field to `true` and tracks the entity for flushing. The entity remains in the database -- it is simply marked as deleted.

## Permanently Deleting an Entity

Call `ForceDelete()` to permanently remove the entity from the database:

```go
user, found, err := UserEntityProvider.GetByID(ctx, 3)
user.ForceDelete()
err = ctx.Flush() // DELETE FROM `UserEntity` WHERE `ID` = 3
```

`ForceDelete()` bypasses the fake delete mechanism and performs a real `DELETE` statement. This is only available on entities that have the `FakeDelete` field.

## Behavior of Fake-Deleted Entities

Once an entity is fake-deleted, it is **excluded from search results** by default. All query methods that use a `WHERE` clause automatically add `AND FakeDelete = 0` to filter out deleted rows:

- `Search`
- `SearchOne`
- `SearchIDs`
- `GetByIndex`
- `GetByUniqueIndex`
- `GetAll`
- Redis Search queries

However, `GetByID` and `GetByIDs` **will still return** fake-deleted entities. You can check whether an entity has been fake-deleted by reading its `FakeDelete` field:

```go
user, found, err := UserEntityProvider.GetByID(ctx, 3) // found = true, even if fake-deleted
if user.GetFakeDelete() {
    fmt.Println("This user has been deleted")
}
```

## Including Fake-Deleted Entities in Search Results

If you need to include fake-deleted entities in search results, use the `WithFakeDeletes()` method on the `Where` clause:

```go
where := fluxaorm.NewWhere("`Status` = ?", "active")
where.WithFakeDeletes()
users, err := UserEntityProvider.Search(ctx, where, fluxaorm.NewPager(1, 100)) // returns all matching entities, including fake-deleted ones
```

Without `WithFakeDeletes()`, the same query would automatically filter out any rows where `FakeDelete = 1`.

## Example: Full Lifecycle

```go
// Create a new user
user := UserEntityProvider.New(ctx)
user.SetName("Alice")
user.SetEmail("alice@example.com")
err := ctx.Flush()

// Soft delete the user
user.Delete()
err = ctx.Flush()

// The user is excluded from normal searches
users, err := UserEntityProvider.Search(ctx, fluxaorm.NewWhere("1"), fluxaorm.NewPager(1, 100))
// users does not include Alice

// But can still be loaded by ID
user, found, err := UserEntityProvider.GetByID(ctx, user.GetID())
// found = true, user.GetFakeDelete() = true

// Include deleted users in search
where := fluxaorm.NewWhere("1")
where.WithFakeDeletes()
allUsers, err := UserEntityProvider.Search(ctx, where, fluxaorm.NewPager(1, 100))
// allUsers includes Alice

// Permanently remove the user
user.ForceDelete()
err = ctx.Flush()
// The row is now deleted from the database
```
