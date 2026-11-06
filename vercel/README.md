# anpio-agents 文档站

基于 VitePress 的静态文档站，和 [anpio-collab 文档站](https://github.com/eccstartup/anpio-collab/tree/master/vercel) 使用同一套主题与配置风格，部署到 Vercel。

覆盖两种使用场景：

- **自运行**：终端对话、一次性任务、HTTP 常驻服务。
- **Collab 调用**：supervisor、平台消息来源、ANP router。

外加定义文件参考与外部插件规划。

## 本地开发

```bash
cd vercel
npm install
npm run dev
```

默认地址 `http://localhost:5173`。

## 构建

```bash
npm run build
npm run preview
```

产物在 `vercel/docs/.vitepress/dist/`。

## 部署到 Vercel

在 Vercel 新建项目，选择本仓库，把 **Root Directory** 设为 `vercel`。框架会被识别为 VitePress，构建命令 `npm run build`，输出目录 `docs/.vitepress/dist`。

也可以用 Vercel CLI：

```bash
cd vercel
npx vercel
npx vercel --prod
```

## 加一篇文档

1. 新建 `docs/guide/<name>.md`，开头写 `title` 与 `description`。
2. 在 `docs/.vitepress/config.mts` 的 `themeConfig.sidebar` 里加一项。
3. 需要的话同步 `themeConfig.nav` 与首页的“文档地图”。

路由由文件路径决定，`cleanUrls` 打开后访问 `/guide/<name>`。

## 目录

```text
vercel/
├─ vercel.json
├─ tsconfig.json
└─ docs/
   ├─ index.md                 首页（hero + features）
   ├─ public/                  logo 与 robots.txt
   ├─ guide/                   总览、自运行、Collab、定义、插件
   └─ .vitepress/
      ├─ config.mts            导航、侧边栏、搜索与页脚
      └─ theme/
         ├─ index.ts
         └─ custom.css         品牌色与文档样式
```
