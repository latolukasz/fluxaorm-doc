---
home: true
heroText:
siteTitle:
heroImage: logo2.svg
heroImageDark: logoDark2.svg
tagline: Code-generation-based Go ORM for MySQL and Redis with type-safe Providers, dirty tracking, and three-tier caching
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
- title: MySQL + Redis Search
  details: Full MySQL support with type-safe queries, combined with Redis Search Engine for lightning-fast full-text and numeric searches. Async SQL operations via Redis Streams for non-blocking writes.
  footer: MIT Licensed | Copyright © 2024-present Łukasz Lato
---
