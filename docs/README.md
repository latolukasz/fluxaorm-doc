---
home: true
heroText:
siteTitle:
heroImage: logo2.svg
heroImageDark: logoDark2.svg
tagline: Code-generation-based Go ORM for MySQL, Redis, ClickHouse, Kafka, and Debezium CDC with type-safe Providers, dirty tracking, and three-tier caching
actionText: Quick Start →
actionLink: /guide/
footer: MIT Licensed | Copyright © 2024-present Łukasz Lato
actions:
- text: Quick Start →
  link: /guide/
  type: primary
features:
- title: Code Generation First
  details: Define entities as plain Go structs, run Generate(), and get fully typed Providers with CRUD methods, getters/setters with automatic dirty tracking, and reflection-free SQL scanning — all at compile time.
- title: Three-Tier Caching
  details: Transparent caching across Context (per-request), Local (in-process LRU), and Redis layers. Entity reads are automatically cached and invalidated — no manual cache management needed.
- title: MySQL + ClickHouse + Redis Search + Kafka
  details: Full MySQL support with type-safe queries, query-only ClickHouse integration for analytics, Redis Search for lightning-fast full-text and numeric searches, and Kafka for event streaming.
- title: Debezium CDC
  details: Built-in Change Data Capture via Debezium. Tag entities with debezium, and FluxaORM auto-manages Kafka Connect connectors, streams MySQL row changes to Kafka topics, and provides typed helpers for consuming CDC events.
  footer: MIT Licensed | Copyright © 2024-present Łukasz Lato
---
