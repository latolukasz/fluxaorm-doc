# Introduction

Object-relational mapping (ORM) libraries such as [GORM](https://gorm.io/) are designed to 
facilitate the conversion of data between relational databases and object-oriented programming languages. 
These libraries provide a unified interface for working with various databases, including MySQL, PostgreSQL, SQLite, and SQL Server. 
This allows developers to interact with the database using familiar object-oriented concepts and syntax, rather than having to write raw SQL queries. 
ORM libraries can greatly simplify the development process and reduce the amount of boilerplate code required to work with databases.

## Designed for MySQL

FluxaORM has a unique approach to database support. Unlike other ORM libraries, which aim to provide a generic interface to 
many different databases, FluxaORM is specifically tailored to work with [MySQL](https://www.mysql.com/). 
This allows us to take full advantage of MySQL's unique features and optimization techniques, resulting in top performance and reliability. 
Our team is committed to staying up-to-date with the latest MySQL releases and implementing any necessary changes and improvements. 
With FluxaORM, you can trust that you are using a database-specific ORM that is expertly designed to support all of MySQL's capabilities.

## Centralized data model

FluxaORM is a unique object-relational mapping (ORM) tool that was created by developers, for developers. 
Our team has spent the last 20 years building high-traffic applications, and we have learned that a relational database like MySQL is just one piece of the puzzle when it comes to building an application data model. 
While MySQL is great for storing data persistently, it is not optimized for handling heavy traffic. This is where other technologies like NoSQL and message brokers come in. 
With FluxaORM, you can easily integrate these technologies and take your application to the next level.



## It's all about cache

Adding a caching layer can improve the performance of your application by reducing the number of queries that need to be executed against the database. Instead of querying the database every time data is needed, a caching layer can be used to store the results of frequently-used queries. This can help reduce the load on the database, allowing it to handle more traffic without sacrificing performance.

However, implementing a caching layer can be complex and error-prone, as the code must be carefully written to ensure that the cache is always up-to-date and that it is properly cleared when necessary. For example, if a user changes their username, the cache must be updated to reflect this change. If this is not done properly, the login form may continue to use the old username, leading to errors or security vulnerabilities.

In short, while a caching layer can improve the performance of a login form, it is important to carefully consider the trade-offs and ensure that the implementation is correct and maintainable

## Redis client

FluxaORM provides its own redis client, which includes support for all standard redis commands as well as additional features like shared lock and rate limiter. This means that you do not need to use any other redis client libraries, such as go-redis, when using FluxaORM. Our client is specifically designed to make it easy to integrate redis into your application, without the need for additional dependencies.

## And much much more...

To learn more about FluxaORM and all of its capabilities, please take some time to read through the rest of our [guide](/guide/registry.html). 
We encourage you to explore all of the features of FluxaORM and see how they can help you build high-traffic applications more easily and efficiently.

