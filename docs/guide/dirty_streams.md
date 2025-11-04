# Dirty Streams

FluxaORM allows you to define special Redis Streams that hold information about entities that are added, edited or deleted.
All you need to do is to add `dirty` tag to your entity with a stream name and optional attributes.

## Defining dirty streams

Check the below example:

```go
type UserEntity struct {
    ID uint32  `orm:"dirty=AllChanges,NewUsers:add,DeletedUsers:delete,EmailAddedOrChanged:add"`
    Name string
    Email string `orm:"dirty=EmailAddedOrChanged"`
}

type CategoryEntity struct {
    ID uint16  `orm:"dirty=AllChanges,CategoryAddedDeleted:add|delete"`
}
```

Above example will create five Redis Streams in entity redis cache pool (or fluxabee.DefaultPoolCode if you don't specify pool code):
    
* `dirty_AllChanges` - triggered when UserEntity or CategoryEntity is added, updated or deleted
* `dirty_NewUsers` - triggered when UserEntity is added 
* `dirty_DeletedUsers` - triggered when UserEntity is deleted
* `dirty_EmailAddedOrChanged` - triggered when UserEntity is added or email is changed
* `dirty_CategoryAddedDeleted` - triggered when CategoryEntity is added or deleted

## Consuming dirty stream events

To consume events from dirty streams simply create a consumer using `fluxaorm.NewDirtyStreamConsumer()` function
and call `Digest` method.

```go
consumer := fluxaorm.NewDirtyStreamConsumer(orm, "AllChanges", func(event *fluxaorm.DirtyStreamEvent) {
    event.EntityName // for example "mypkg.UserEntity"
    event.ID // ID of added, edited or deleted entity
    event.Operation // fluxaorm.Insert or fluxaorm.Update or fluxaorm.Delete
    event.Bind // map of attributes that were changed
})
consumer.Digest(1, 100) // consume 100 events at once as consumer with name "consumer_1"
```

`event.Bind` is a map of attributes that were changed. When entity is added Bind holds all attributes of the entity.
When is deleted Bind holds also all fields of deleted entity. Edited entity holds only changed fields.

::: tip
In case your entity uses [Fake Delete](/guide/fake_delete.html) feature when you mark entity as fake deleted `event.Operation` is equal
to `fluxaorm.Delete` and `event.Bind` holds only changed field `{"FakeDelete": 13243}`.
:::

In case one consumer is not enough to consume all events you can create more consumers:

```go
go func() {
    consumer.Digest(1, 100) // consume 100 events at once as consumer with name "consumer_1"
}()
go func() {
    consumer.Digest(2, 100) // consume 100 events at once as consumer with name "consumer_2"
}()
```

By default all events passed to above function are automatically acknowledged when function finishes.
If you want to acknowledge event sooner you can run `event.Ack()` in your code:

```go
consumer := fluxaorm.NewDirtyStreamConsumer(orm, "AllChanges", func(event *fluxaorm.DirtyStreamEvent) {
    event.Ack() // acknowledge event immediately in stream
})
```

## Dirty stream statistics 

To get statistics of dirty stream use `GetStreamStatistics()` method of `fluxaorm.EventBroker`.
You must add `dirty_` prefix to stream name.

```go
stats := ctx.GetEventBroker().GetStreamStatistics("dirty_AllChanges")
stats.Len // number of events in stream
stats.OldestEventSeconds // time in seconds since oldest event
...

