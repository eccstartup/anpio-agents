/**
 * 流水线日志插件模板：复制这个文件，把下面的假数据换成你系统里的真实查询。
 *
 * 三条规则：
 *   1. stdout 只走 MCP 协议，任何日志都写 stderr。
 *   2. 只读工具加 readOnlyHint，引擎才会把它当读操作（超时不会被标记为结果未知）。
 *   3. 启动后从 stdin 读请求，关掉 stdin（EOF）就退出。
 *
 * 自检：npm run plugin:check -- --command "node examples/plugins/ci-logs/server.ts" --allow logs_tail,stage_status
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ci-logs', version: '0.1.0' });

const LINES = [
  '[build-123] checkout 完成',
  '[build-123] 安装依赖 42s',
  '[build-123] 单元测试 318 passed',
  '[build-123] 镜像推送 registry/ci:build-123',
  '[build-123] 部署到 staging 完成',
  '[build-123] 冒烟测试通过',
];

server.registerTool(
  'logs_tail',
  {
    description: '读取构建日志的最新若干行',
    inputSchema: {
      cursor: z.number().int().min(0).optional().describe('从第几行开始，缺省从 0'),
      limit: z.number().int().min(1).max(100).optional().describe('最多返回多少行，默认 20'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ cursor, limit }) => {
    const start = cursor ?? 0;
    const slice = LINES.slice(start, start + (limit ?? 20));
    const next = start + slice.length;
    const text = slice.join('\n');
    return {
      content: [
        {
          type: 'text',
          text: next < LINES.length ? `${text}\n（还有更多，cursor=${next}）` : text,
        },
      ],
    };
  },
);

server.registerTool(
  'stage_status',
  {
    description: '查询构建各阶段的状态',
    inputSchema: { buildId: z.string().min(1).describe('构建号，如 build-123') },
    annotations: { readOnlyHint: true },
  },
  async ({ buildId }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          buildId,
          stages: [
            { name: 'checkout', status: 'succeeded' },
            { name: 'test', status: 'succeeded' },
            { name: 'deploy', status: 'succeeded', environment: 'staging' },
          ],
        }),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
