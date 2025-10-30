# Registry

The `orm.Registry` object is the starting point for using FluxaORM. It allows you to configure your database connections and register structs that represent your data. You can initialize a 
orm.Registry object using the `orm.NewRegistry()` function, as shown in the following example:

```go
package main

import "github.com/latolukasz/fluxaorm"

func main() {
    // Initialize a new Registry
    registry := fluxaorm.NewRegistry()
    
    // Register a MySQL connection pool
    registry.RegisterMySQL("user:password@tcp(localhost:3306)/db", fluxaorm.DefaultPoolCode, nil) 
} 
```

## Init By Config

```go
registry := fluxaorm.NewRegistry()
config := &fluxaorm.Config{
    MySQlPools: []fluxaorm.ConfigMysql{
        {URI: "root:root@tcp(localhost:3377)/test", Code: "default"},
    },
    RedisPools: []fluxaorm.ConfigRedis{
        {URI: "localhost:6385", Code: "default", Database: 0, Streams: []fluxaorm.ConfigStream{
            {Name: "test-stream", Group: "test-group"},
        }},
        {URI: "localhost:6385", Code: "test", Database: 1},
    },
    LocalCachePools: []fluxaorm.ConfigLocalCache{
        {Code: "test", Limit: 10000},
        {Code: "default", Limit: 200},
    },
}

err := registry.InitByConfig(config)
```

## Init By Yaml file

Alternatively, you can configure the `orm.Registry` object using data from a YAML file, as shown in the following example:

```go{20}
package main

import (
    "github.com/latolukasz/fluxaorm"
    "io/ioutil"
    "gopkg.in/yaml.v2"
)

func main() {
    data, err := ioutil.ReadFile("./config.yaml")
    if err != nil {
        panic(err)
    }
    var parsedYaml map[string]interface{}
    err = yaml.Unmarshal(yamlFileData, &parsedYaml)
    if err != nil {
        panic(err)
    }
    registry := fluxaorm.NewRegistry()
    err = registry.InitByYaml(parsedYaml)
     if err != nil {
        panic(err)
    }
}
```

```yml
default:
  mysql: 
    uri: user:password@tcp(localhost:3306)/db
```