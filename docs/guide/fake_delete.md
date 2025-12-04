# Fake Delete

In a real live scenario, if you delete entity you want to keep in Database marked as deleted instead of actually deleting it.
Entity marked as deleted is not returned by `GetByID` and `GetByIDs` functions but is not returned by these functions:

 * `Search`
 * `RedisSearch`
 * `SearchIDs`
 * `SearchOne`
 * `GetByIndex`
 * `GetByUniqueIndex`
 * `GetAll`


## Enabling Fake Delete

You can enable context cache by adding `FakeDelete bool` field to your entity:

```go
type UserEntity {
 Name string
 FakeDelete bool
}
```

Every time you are deleting UserEntity it will be marked as deleted in Database by setting `FakeDelete` field to `ID` of entity.
FakeDele field generates column in MySQL table the same as ID column and this columns is added automatically 
added to all MySQL indexes, including unique indexes. This approach allows yoo to avoid duplicate key errors

Example:

```go
userEntity, err := GetByID[UserEntity](orm, 3)
err = fluxaorm.Delete(orm, &userEntity)
err = orm.Flush() // UPDATE UserEntity SET FakeDelete = 3 WHERE ID = 3

userEntity, found, err := GetByID[UserEntity](orm, 3) // found = true
userEntity.FakeDelete // true

users, err := Search[UserEntity](orm, NewWhere("1"), nil)
users.Len() // 0
```

## Forcing Entity to be deleted.

You can use `ForceDeleteEntity()` function to force entity to be deleted from MySQL table.

```go
err := fluxaorm.ForceDeleteEntity(orm, &userEntity) // DELETE FROM UserEntity WHERE ID = 3
```

## Searching for entities marked as deleted

You can instruct fluxaorm to return in search results also entities marked as deleted with `WithFakeDeletes()` method on 
`fluxaorm.Where`:

```go{2}
where  := fluxaorm.NewWhere("1")
where.WithFakeDeletes()
users, err = fluxaorm.Search[UserEntity](orm, where, nil) // returns all entities, including marked as deleted
```