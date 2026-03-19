import { viteBundler } from '@vuepress/bundler-vite'
import { defineUserConfig } from 'vuepress'
import { defaultTheme } from '@vuepress/theme-default'
import { googleAnalyticsPlugin } from '@vuepress/plugin-google-analytics'
import { searchPlugin } from '@vuepress/plugin-search'

export default defineUserConfig({
  lang: 'en-US',
  title: 'FluxaORM v2: Code-Generation-Based Go ORM for MySQL, Redis, and ClickHouse',
  description: 'FluxaORM v2 is a code-generation-based Go ORM for high-traffic applications. Define entities as Go structs, generate type-safe Providers with CRUD methods, getters/setters with dirty tracking, and leverage MySQL, ClickHouse, Redis caching, and Redis Search — all with zero reflection at runtime.',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }]
  ],
  bundler: viteBundler({
    viteOptions: {},
    vuePluginOptions: {},
  }),
  plugins: [
    googleAnalyticsPlugin({
      id: 'UA-195751907-1',
    }),
    searchPlugin({})
  ],
  theme: defaultTheme({
    logo: '/logo-small2.svg',
    logoDark: '/logo-small-dark2.svg',
    repo: 'https://github.com/latolukasz/fluxaorm',
    docsRepo: 'https://github.com/latolukasz/fluxaorm-doc',
    colorMode: 'dark',
    docsBranch: 'v3',
    docsDir: 'docs',
    contributors: false,
    navbar: [
      {
        text: 'Guide',
        link: '/guide/',
      },
    ],
    sidebar: {
      '/guide/': [
        {
          title: 'Guide',
          children: [
            {
              text: 'Introduction',
              link: '/guide/'
            },
            'registry',
            'data_pools',
            'entities',
            'entity_fields',
            'mysql_indexes',
            'code_generation',
            'engine',
            'context',
            'entity_schema',
            'schema_update',
            'crud',
            'async_flush',
            'search',
            'redis_search',
            'mysql_queries',
            'clickhouse_queries',
            'clickhouse_schema',
            'kafka',
            'local_cache',
            'context_cache',
            'fake_delete',
            'lifecycle_callbacks',
            'metrics',
            'redis_operations',
            'distributed_lock',
            'queries_log',
            'testing'
          ]
        }]
    }
  })
})