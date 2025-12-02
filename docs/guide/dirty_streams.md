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

To consume events from dirty streams simply create a consumer using `fluxaorm.NewDirtyStreamConsumerSingle()` or `fluxaorm.NewDirtyStreamConsumerMany()` function
and call `Digest` method.

```go
consume, errr := fluxaorm.NewDirtyStreamConsumerSingle(orm, "AllChanges", func(events []*fluxaorm.DirtyStreamEvent) {
    for _, event := range events {
        event.EntityName // for example "mypkg.UserEntity"
        event.ID // ID of added, edited or deleted entity
        event.Operation // fluxaorm.Insert or fluxaorm.Update or fluxaorm.Delete
        event.Bind // map of attributes that were changed
    }
    return nil
} error)
defer consumer.Cleanup()
err = consumer.Consume(100, time.Second * 5) // wait max 5 secondas for new events and consume max 100 event as consumer with name "consumer_single"
```

`event.Bind` is a map of attributes that were changed. When entity is added Bind holds all attributes of the entity.
When is deleted Bind holds also all fields of deleted entity. Edited entity holds only changed fields.

::: tip
In case your entity uses [Fake Delete](/guide/fake_delete.html) feature when you mark entity as fake deleted `event.Operation` is equal
to `fluxaorm.Delete` and `event.Bind` holds only changed field `{"FakeDelete": 13243}`.
:::

In case one consumer is not enough to consume all events you can create more consumers:

```go
consumer1, err := fluxaorm.NewDirtyStreamConsumerMany(orm, "AllChanges", func(events []*fluxaorm.DirtyStreamEvent) {
 // ....
} error)
defer consumer1.Cleanup()
consumer2, err := fluxaorm.NewDirtyStreamConsumerMany(orm, "AllChanges", func(events []*fluxaorm.DirtyStreamEvent) {
 // ....
} error)
defer consumer2.Cleanup()
go func() {
   err = consumer1.Consume(100, time.Second * 5) 
}()
go func() {
   err = consumer2.Consume(100, time.Second * 5) 
}()
```

By default all events passed to above function are automatically acknowledged when function finishes.
If you want to acknowledge event sooner you can run `event.Ack()` in your code:

```go
consumer := fluxaorm.NewDirtyStreamConsumerSingle(orm, "AllChanges", func(events []*fluxaorm.DirtyStreamEvent) {
    for _, event := range events {
        err = event.Ack() // acknowledge event immediately in stream
    }
    return nil
} error)
```

## Dirty stream statistics 

To get statistics of dirty stream use `GetStreamStatistics()` method of `fluxaorm.EventBroker`.
You must add `dirty_` prefix to stream name.

```go
stats, err := ctx.GetEventBroker().GetStreamStatistics("dirty_AllChanges")
stats.Len // number of events in stream
stats.OldestEventSeconds // time in seconds since oldest event
...
```

## Auto-claim old events

```go
consumer, err := fluxaorm.NewDirtyStreamConsumerMany(orm, "AllChanges", func(events []*fluxaorm.DirtyStreamEvent) {
 // ....
} error)
err = consumer.AutoClaim(1000, time.Second * 5) // auto-claim max 1000 penfing events older than 5 seconds
```