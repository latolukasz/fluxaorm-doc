# Plugins

BeeORM's functionality can be extended by incorporating plugins.

## Enabling Plugins

Activating plugins in BeeORM is a simple process. To get started, register the desired plugin using the `RegisterPlugin()` method, as demonstrated in the example below:

```go{10}
package main

import (
    "github.com/latolukasz/orm"
    "github.com/latolukasz/orm/plugins/modified"
)

func main() {
  registry := orm.NewRegistry()
  registry.RegisterPlugin(modified.New("Added", "Updated"))
}
```

BeeORM offers a variety of built-in plugins, which can be explored further in the [Plugins](/plugins/) section.

## Creating a Custom Plugin

To tailor BeeORM to your specific needs, you have the flexibility to craft your own custom plugin by implementing at least one of the following interfaces.

### ValidateRegistry Interface

```go
type PluginInterfaceValidateRegistry interface {
	ValidateRegistry(engine orm.EngineSetter, registry orm.Registry) error
}
```

The `PluginInterfaceValidateRegistry` interface comes into play when the `registry.Validate()` method is invoked.
The first argument, `EngineSetter`, empowers you to define additional parameters for the `Engine`. These parameters can later be accessed in your code using the `engine.Option()` method. The example below illustrates this concept:

```go
type MyPlugin struct {}

func (p *MyPlugin) ValidateRegistry(engine orm.EngineSetter, registry orm.Registry) error {
    // perform custom actions
    engine.SetOptions("orm-started", time.Now())
    return nil
}
```

Subsequently, in your code, you can retrieve this option from `orm.Engine()`:

```go
ormStarted := engine.Option("orm-started") // returns nil if not defined
```

This mechanism allows you to enrich the behavior of the `Engine` during initialization by injecting and retrieving custom parameters.

### InitRegistryFromYaml Interface

```go
type PluginInterfaceInitRegistryFromYaml interface {
	InitRegistryFromYaml(registry orm.Registry, yaml map[string]interface{}) error
}
```

The `PluginInterfaceInitRegistryFromYaml` interface is invoked for each Entity when the `registry.InitByYaml()` method is called. This interface provides access to both the `orm.Registry` and the data loaded from a YAML file.

For instance:

```go
type MyPlugin struct {}

func (p *MyPlugin) InitRegistryFromYaml(registry orm.Registry, yaml map[string]interface{}) error {
    if yaml["MyPluginEnabled"] == true {
        registry.SetOption("IsMyPluginEnabled", true)
    }
    return nil
}
```

Subsequently, in your code, you can retrieve registry options:

```go
isEnabled := engine.Registry().Option("IsMyPluginEnabled") == true
```

This functionality allows you to customize the initialization process based on data loaded from YAML files, offering greater flexibility in configuring BeeORM entities.

### ValidateEntitySchema Interface

```go
type PluginInterfaceValidateEntitySchema interface {
	ValidateEntitySchema(schema orm.EntitySchemaSetter) error
}
```

The `PluginInterfaceValidateEntitySchema` interface is executed for each entity registered with `registry.RegisterEntity()` when `registry.Validate()` is called:

```go
type MyPlugin struct {}

func (p *MyPlugin) ValidateEntitySchema(schema orm.EntitySchemaSetter) error {
    schema.SetOption("my-plugin-schema-option", "Some value")
    return nil
}
```

Subsequently, in your code, you can access entity schema options:

```go
schema := orm.GetEntitySchema[MyEntity](orm)
value := schema.Option("my-plugin-schema-option")
```

This interface empowers you to enhance the behavior of individual entity schemas during validation, providing a mechanism to inject custom options and retrieve them later in your code.

### EntityFlush Interface

```go
type PluginInterfaceEntityFlush interface {
	EntityFlush(schema orm.EntitySchema, entity reflect.Value, before, after orm.Bind, engine orm.Engine) (orm.PostFlushAction, error)
}
```

The `EntityFlush` interface plays a crucial role when entity data undergoes flushing via the `Flush()` method. Code within this method executes just before data is poised for updating in MySQL. Optionally, you can return a function that executes immediately after the SQL queries are executed and data is stored in MySQL. The `before` and `after` maps contain entity data before and after changes:

- If `before` is nil and `after` is not nil, a new entity is slated for insertion into MySQL.
- If both `before` and `after` are not nil, an entity is set to be updated in MySQL.
- If `before` is not nil and `after` is nil, an entity is on the brink of being deleted from MySQL.

Here's an illustrative example:

```go
type MyPlugin struct {}

func (p *MyPlugin) EntityFlush(schema orm.EntitySchema, entity reflect.Value, before, after orm.Bind, engine orm.Engine) (orm.PostFlushAction, error) {
    now := time.Now().UTC()
    if before == nil && after != nil { // INSERT
        after["CreatedAt"] = now.Format(time.RFC3339)
    }
    return func(_ orm.ORM) {
        entity.FieldByName("CreatedAt").Set(reflect.ValueOf(now))
    }, nil
}
```

This example showcases how to utilize the `EntityFlush` interface to manipulate entity data just before insertion, updating, or deletion in MySQL, demonstrating the flexibility it provides in customizing the flushing process.