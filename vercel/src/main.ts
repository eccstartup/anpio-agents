import './style.css';
import { renderMarkdown } from './markdown';

type Doc = {
  id: string;
  title: string;
  file: string;
  group: string;
  summary: string;
};

const REPO = 'https://github.com/eccstartup/anpio-agents';

const DOCS: Doc[] = [
  {
    id: 'overview',
    title: '总览',
    file: 'overview.md',
    group: '入门',
    summary: 'anpio-agents 是什么，两种运行方式怎么选',
  },
  {
    id: 'standalone',
    title: '自运行',
    file: 'standalone.md',
    group: '场景',
    summary: '在本机启动对话、跑一次任务或提供 HTTP 服务',
  },
  {
    id: 'collab',
    title: 'Collab 调用',
    file: 'collab.md',
    group: '场景',
    summary: '接入 anpio-collab：supervisor、平台来源与 ANP router',
  },
  {
    id: 'definition',
    title: '定义文件',
    file: 'definition.md',
    group: '参考',
    summary: 'provider、tools、limits、sources 与密钥解析',
  },
  {
    id: 'plugins',
    title: '外部插件（规划）',
    file: 'plugins.md',
    group: '规划',
    summary: '把日志、监控与流水线环节作为工具接给智能体',
  },
];

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div class="shell">
    <div class="scrim" data-close></div>
    <aside class="sidebar">
      <a class="brand" href="#/overview">
        <span class="brand-mark">an</span>
        <span>
          <strong>anpio-agents</strong>
          <small>文档</small>
        </span>
      </a>
      <nav class="nav">
        ${['入门', '场景', '参考', '规划']
          .map(group => {
            const items = DOCS.filter(doc => doc.group === group);
            if (items.length === 0) return '';
            return `<div class="nav-group">
              <div class="nav-title">${group}</div>
              ${items
                .map(
                  doc =>
                    `<a class="nav-link" data-doc="${doc.id}" href="#/${doc.id}">${doc.title}</a>`,
                )
                .join('')}
            </div>`;
          })
          .join('')}
      </nav>
      <div class="sidebar-foot">
        <a href="${REPO}" target="_blank" rel="noreferrer">GitHub 仓库 ↗</a>
        <span>Node ≥ 22.18 · MIT 之外的使用请遵循仓库许可</span>
      </div>
    </aside>
    <div class="main">
      <header class="topbar">
        <button class="menu-button" data-menu aria-label="打开目录">☰</button>
        <span class="topbar-title" id="topbar-title">总览</span>
      </header>
      <div class="content-wrap">
        <article class="article" id="article"></article>
        <nav class="toc" id="toc" aria-label="本页目录"></nav>
      </div>
    </div>
  </div>
`;

const article = document.querySelector<HTMLElement>('#article')!;
const toc = document.querySelector<HTMLElement>('#toc')!;
const topbarTitle = document.querySelector<HTMLElement>('#topbar-title')!;
const shell = document.querySelector<HTMLElement>('.shell')!;
let observer: IntersectionObserver | null = null;

function currentDoc(): Doc {
  const id = window.location.hash.replace(/^#\/?/, '').split('#')[0] || 'overview';
  return DOCS.find(doc => doc.id === id) ?? DOCS[0]!;
}

function setActive(doc: Doc): void {
  for (const link of document.querySelectorAll<HTMLElement>('.nav-link')) {
    link.classList.toggle('active', link.dataset.doc === doc.id);
  }
  topbarTitle.textContent = doc.title;
  document.title = `${doc.title} · anpio-agents 文档`;
}

function buildToc(doc: Doc): void {
  const headings = [...article.querySelectorAll<HTMLElement>('h2, h3')];
  if (headings.length < 2) {
    toc.innerHTML = '';
    return;
  }
  toc.innerHTML = `<div class="toc-title">本页目录</div>`;
  for (const heading of headings) {
    const link = document.createElement('a');
    link.href = `#/${doc.id}#${heading.id}`;
    link.textContent = heading.textContent ?? '';
    link.className = `toc-link toc-level-${heading.tagName === 'H3' ? 3 : 2}`;
    link.dataset.anchor = heading.id;
    link.addEventListener('click', event => {
      event.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
      history.replaceState(null, '', `#/${doc.id}#${heading.id}`);
    });
    toc.append(link);
  }

  observer?.disconnect();
  const links = [...toc.querySelectorAll<HTMLElement>('.toc-link')];
  observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id;
        for (const link of links) {
          link.classList.toggle('active', link.dataset.anchor === id);
        }
      }
    },
    { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
  );
  for (const heading of headings) observer.observe(heading);
}

function addCopyButtons(): void {
  for (const pre of article.querySelectorAll<HTMLElement>('pre')) {
    pre.classList.add('code-block');
    const button = document.createElement('button');
    button.className = 'copy-button';
    button.type = 'button';
    button.textContent = '复制';
    button.addEventListener('click', async () => {
      const code = pre.querySelector('code')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(code);
        button.textContent = '已复制';
      } catch {
        button.textContent = '复制失败';
      }
      setTimeout(() => {
        button.textContent = '复制';
      }, 1600);
    });
    pre.append(button);
  }
}

async function show(doc: Doc): Promise<void> {
  setActive(doc);
  shell.classList.remove('nav-open');
  article.innerHTML = '<p class="loading">正在加载文档…</p>';
  const url = `${import.meta.env.BASE_URL}docs/${doc.file}`;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const markdown = await response.text();
    article.innerHTML = renderMarkdown(markdown);
    const source = document.createElement('div');
    source.className = 'source-note';
    source.innerHTML = `发现错误？<a href="${REPO}/blob/main/vercel/public/docs/${doc.file}" target="_blank" rel="noreferrer">在 GitHub 上查看或编辑这一页</a>`;
    article.append(source);
    addCopyButtons();
    buildToc(doc);
    const anchor = window.location.hash.split('#').filter(Boolean)[1];
    const target = anchor ? document.getElementById(decodeURIComponent(anchor)) : null;
    if (target) {
      target.scrollIntoView({ block: 'start' });
    } else {
      window.scrollTo({ top: 0 });
    }
  } catch (error) {
    article.innerHTML = `<div class="error">
      <h1>文档加载失败</h1>
      <p>无法读取 <code>${url}</code>：${String(error)}</p>
      <p>本地开发时请确认 Vite 已启动；部署后请确认 <code>public/docs</code> 已随构建产物一起发布。</p>
    </div>`;
    toc.innerHTML = '';
  }
}

function route(): void {
  void show(currentDoc());
}

window.addEventListener('hashchange', route);

document.querySelector('[data-menu]')?.addEventListener('click', () => {
  shell.classList.toggle('nav-open');
});

document.querySelector('[data-close]')?.addEventListener('click', () => {
  shell.classList.remove('nav-open');
});

route();
