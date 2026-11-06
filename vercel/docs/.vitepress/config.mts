import { defineConfig } from 'vitepress'

export default defineConfig({
  lang: 'zh-CN',
  title: 'Anpio Agents',
  titleTemplate: ':title · Anpio Agents',
  description: 'ANPIO 的智能体执行引擎：自运行、接入 anpio-collab、用插件连接外部流水线。',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['meta', { name: 'theme-color', content: '#146b55' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:site_name', content: 'Anpio Agents' }],
    ['meta', { property: 'og:title', content: 'Anpio Agents 文档' }],
    ['meta', { property: 'og:description', content: '一份定义文件，一个模型；不连平台时自己跑，连上 anpio-collab 后由平台下发定义、投递消息、记录运行。' }]
  ],
  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'Anpio Agents',
    nav: [
      { text: '指南', link: '/guide/overview' },
      { text: '记忆', link: '/guide/memory' },
      { text: '自运行', link: '/guide/standalone' },
      { text: 'Collab 调用', link: '/guide/collab' },
      { text: '参考', link: '/guide/definition' },
      { text: '插件', link: '/guide/plugins' }
    ],
    sidebar: {
      '/guide/': [
        {
          text: '认识引擎',
          items: [
            { text: '总览', link: '/guide/overview' },
            { text: '记忆与会话', link: '/guide/memory' }
          ]
        },
        {
          text: '运行方式',
          items: [
            { text: '自运行', link: '/guide/standalone' },
            { text: 'Collab 调用', link: '/guide/collab' }
          ]
        },
        {
          text: '参考',
          items: [
            { text: '定义文件', link: '/guide/definition' },
            { text: '外部插件', link: '/guide/plugins' }
          ]
        }
      ]
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/eccstartup/anpio-agents' }
    ],
    outline: { level: [2, 3], label: '本页目录' },
    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索文档',
            buttonAriaLabel: '搜索文档'
          },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清除查询',
            backButtonTitle: '返回',
            noResultsText: '没有找到结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        }
      }
    },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: {
      text: '最后更新',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '主题',
    lightModeSwitchTitle: '切换到浅色模式',
    darkModeSwitchTitle: '切换到深色模式',
    langMenuLabel: '语言',
    externalLinkIcon: true,
    footer: {
      message: 'ANPIO 的智能体执行引擎',
      copyright: 'Anpio Agents'
    }
  }
})
