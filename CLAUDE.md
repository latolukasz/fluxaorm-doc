# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Documentation Sync

This documentation must be kept in sync with the ORM code in `orm/`. Every change to the ORM code must be accompanied by a corresponding update here. This includes API changes, new features, removed features, behavior changes, and bug fixes that affect documented behavior.

## Commands

```bash
# Start local dev server with hot reload
yarn docs:dev

# Build static site for production
yarn docs:build
```

The package manager is **yarn** (v1.22). Do not use npm.

## Architecture

This is a **VuePress 2** documentation site for [FluxaORM](https://github.com/latolukasz/fluxaorm), a Golang ORM for MySQL and Redis. It is deployed to Vercel on the `v3` branch.

### Structure

- `docs/` — all documentation source files (Markdown)
  - `README.md` — homepage (VuePress home layout with hero/features frontmatter)
  - `guide/` — main documentation pages (each `.md` = one page)
  - `plugins/` — plugin documentation pages
  - `.vuepress/config.js` — site config: navbar, sidebar order, plugins, theme
  - `.vuepress/public/` — static assets (logos, favicon, images)
  - `.vuepress/styles/` — SCSS overrides (`palette.scss` for accent colors, `index.scss` for custom CSS)

### Sidebar and Navigation

The sidebar order is manually defined in `docs/.vuepress/config.js`. When adding a new page:
1. Create the `.md` file in `docs/guide/` or `docs/plugins/`
2. Add the filename (without `.md`) to the appropriate `sidebar` array in `config.js`

### Theme and Styling

- Uses `@vuepress/theme-default` with dark mode as default (`colorMode: 'dark'`)
- Brand accent color is `#F9B62D` (yellow), defined in `docs/.vuepress/styles/palette.scss`
- The GitHub repo link in the navbar points to the main FluxaORM library repo; the docs repo link points to this repo

### Deployment

Deployed via Vercel. The `vercel.json` sets long-lived cache headers (`max-age=31536000`) for all assets under `/assets/`.
