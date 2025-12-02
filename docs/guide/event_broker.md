# Event Broker

FluxaORM provides a special object `fluxabee.EventBroker` that facilitates sending data to Redis Streams and
reading from them.

## Defining redis stream

The first step is to define a list of Redis Streams:

Plik YAML:

```yaml
default:
  streams:
    - stream-1
    - stream-2
````

Config:

```go
config := &fluxaorm.Config{
    RedisPools: []fluxaorm.ConfigRedis{
        {URI: "localhost:6385", Code: "default", Database: 0, Streams: []string{
            "test-stream", "test-group",
        }},
    },
}
```

## Publishing events to Redis Streams

```go
broker := ctx.GetEventBroker()

// Publishing simple text
err = broker.Publish("test-stream", "some-text")

// Publishing struct that is serialized/unserialized automatically
someData := SomeStruct{
    SomeField: "some-value",
}
err = broker.Publish("test-stream", "some-text")

// flushing all events to Redis
err = broker.Flush()
```

## Reading events from Redis Stream by single consumer

```go
broker := ctx.GetEventBroker()
consumer, err := broker.ConsumerSingle(ctx, "test-stream")
defer consumer.Cleanup()
err = consumer.Consume(5, time.Second * 10, func(events []Event) {
    for _, event := range events {
        err = event.ACK()
        if err != nil {
            return err
        }
    }
    return nil
} error)
```

In above example, we consume max 5 messages from Redis Stream `test-stream`.
Consumer will block connection to Redis for 10 second waiting for new messages.
Consumer is cereated using ConsumerSingle function which instruct consumer to create only one
single consumer with name "consumer-single". Because of that, we have guarantee that only one consumer
will read messages and all events will be processed from oldest to newest.

## Reading events from Redis Stream by many consumers

```go
broker := ctx.GetEventBroker()

go func() {
    consumer1, err := broker.ConsumerMany(ctx, "test-stream")
    defer consumer1.Cleanup()
    err = consumer1.Consume(5, time.Second * 10, func(events []Event) {
        for _, event := range events {
            err := event.ACK()
            if err != nil {
                return err
            }
        }
        return nil
    } error)
}()

go func() {
    consumer2, err := broker.ConsumerMany(ctx, "test-stream")
    defer consumer2.Cleanup()
    rr = consumer2.Consume(5, time.Second * 10, func(events []Event) {
        for _, event := range events {
            err := event.ACK()
            if err != nil {
                return err
            }
        }
        return nil
    } error)
}()
```

In above example, we create two consumers that will read messages from Redis Stream `test-stream`.
That's why you must use ConsumerMany function instead of ConsumerSingle. Each consumer have its own name
and will read messages from Redis Stream in parallel. Events orders are not guaranteed.

You can get name of consumer using `consumer.Name()` function.

```go
consumer2.Name() // consumer-2025_02-11_12_23_21_494323423423423 
```

As You can see, consumer name is generated automatically and contains date and time when consumer was created and random number.

When running many consumers (ConsumerMany) it's recommended to auto-claim old pending messages from Redis Stream from time to time
to assure messages are not lost.

```go
broker := ctx.GetEventBroker()
consumer, err := broker.ConsumerMany(ctx, "test-stream")
defer consumer.Cleanup()
err = consumer.AutoClaim(1000, time.Minute * 10, func(events []Event) {
    for _, event := range events {
        err := event.ACK()
        if err != nil {
            return err
        }
    }
    return nil
} error)
```

Above example will claim max up to 1000 pending messages in one iteration are not acknowledged longer than 10 minutes