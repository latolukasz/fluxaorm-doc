# Modified

This enhanced plugin streamlines the process of managing timestamps in your entity when interacting with a MySQL database. It allows you to specify which fields should be automatically set to the current time when an entity is inserted or updated.

## Plugin Registration

To utilize this plugin, initialize it using the `New()` function. This function requires two essential arguments:

* `addedAtField` - the name of the entity field to be set to the current time upon insertion.
* `modifiedAtField` - the name of the entity field to be updated with the current time upon modification.

The entity field type must be either `time.Time` or `*time.Time`. Additionally, you can employ the ORM tag `time` to store both date and time or omit it to store only the date.

## Example

```go
package main

import (
    "github.com/latolukasz/orm"
    "github.com/latolukasz/orm/plugin/modified"
)

type MyEntity struct {
    ID         uint64
    Name       string
    CreatedAt  time.Time  `orm:"time"`
    ModifiedAt *time.Time `orm:"time"`
}

func main() {
    registry := orm.NewRegistry()
    registry.RegisterPlugin(modified.New("CreatedAt", "ModifiedAt")) 
}
```

You can specify an empty string `""` as a field name to update only one field:

```go
registry.RegisterPlugin(modified.New("CreatedAt", "")) 
```

In this example, only the `CreatedAt` field is updated when a new entity is inserted into MySQL.

```go
registry.RegisterPlugin(modified.New("", "ModifiedAt")) 
```

In this example, only the `ModifiedAt` field is updated when an entity is modified in MySQL.

You can also use the same name for both columns:

```go
registry.RegisterPlugin(modified.New("ModifiedAt", "ModifiedAt")) 
```

In this scenario, the `ModifiedAt` column is updated when an entity is either added or updated.
