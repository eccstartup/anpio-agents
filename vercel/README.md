# anpio-agents 文档站

基于 Vite 的静态文档站，部署到 Vercel。文档内容在 `public/docs/`，用 Markdown 编写；站点只负责导航、渲染与样式。

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

产物在 `vercel/dist/`。

## 部署到 Vercel

在 Vercel 新建项目，选择本仓库，把 **Root Directory** 设为 `vercel`。框架会被识别为 Vite，构建命令 `npm run build`，输出目录 `dist`。

也可以用 Vercel CLI：

```bash
cd vercel
npx vercel
npx vercel --prod
```

## 加一篇文档

1. 新建 `public/docs/<name>.md`。
2. 在 `src/main.ts` 的 `DOCS` 数组里加一项：`id`（URL hash）、`title`、`file`、`group`、`summary`。
3. 重新构建。

路由用 URL hash，例如 `#/standalone`，不需要服务端 rewrite。

## 目录

```text
vercel/
├─ index.html
├─ vite.config.ts
├─ vercel.json
├─ public/docs/       Markdown 文档
└─ src/
   ├─ main.ts         导航、路由、目录与复制按钮
   ├─ markdown.ts     轻量 Markdown 渲染
   └─ style.css       样式
```
