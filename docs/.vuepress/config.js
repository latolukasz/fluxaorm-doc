import { defineUserConfig } from 'vuepress'
import { defaultTheme } from 'vuepress'
import { googleAnalyticsPlugin } from '@vuepress/plugin-google-analytics'
import { searchPlugin } from '@vuepress/plugin-search'

export default defineUserConfig({
  lang: 'en-US',
  title: 'FluxaORM: A Golang ORM for MySQL and Redis',
  description: 'FluxaORM is a Golang ORM designed for high-traffic applications that require optimal performance and scalability. Our ORM allows developers to easily build and maintain applications that can handle large amounts of data and traffic, using the power and simplicity of Golang, along with the reliability and speed of MySQL and Redis (including Redis Search Engine).',
  head: [
    ['link', { rel: 'icon', href: '/favicon.ico' }]
  ],
  plugins: [
    googleAnalyticsPlugin({
      id: 'UA-195751907-1',
    }),
    searchPlugin({})
  ],
  theme: defaultTheme({
    logo: '/logo-small.svg',
    logoDark: '/logo-small-dark.svg',
    repo: 'https://github.com/latolukasz/fluxaorm',
    docsRepo: 'https://github.com/latolukasz/fluxaorm-doc',
    docsBranch: 'v3',
    docsDir: 'docs',
    contributors: false,
    navbar: [
      {
        text: 'Guide',
        link: '/guide/',
      },
      {
        text: 'Plugins',
        link: '/plugins/',
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
            'engine',
            'orm',
            'entity_schema',
            'schema_update',
            'crud',
            'async_flush',
            'search',
            'mysql_queries',
            'local_cache',
            'redis_operations',
            'distributed_lock',
            'queries_log',
            'plugins',
            'log_tables'
          ]
        }],
      '/plugins/': [
        {
          title: 'Plugins',
          children: [
            {
              text: 'Introduction',
              link: '/plugins/'
            },
            'modified',
          ]
        }]
    }
  })
})