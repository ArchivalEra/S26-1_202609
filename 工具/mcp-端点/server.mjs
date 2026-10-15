#!/usr/bin/env node
/**
 * MCP 读层服务入口（stdio）。用法：
 *
 *   node 工具/mcp-端点/server.mjs
 *
 * 客户端配置（Claude Desktop / Cursor 等）：
 *   { "mcpServers": { "课程仓库": {
 *       "command": "node",
 *       "args": ["/绝对路径/工具/mcp-端点/server.mjs"]
 *   } } }
 *
 * 全离线、零依赖；工具名带 `course_` 前缀（避与浏览器 relay 的 webmcp_* 相撞）。
 * 日志一律走 stderr（stdout 只写协议帧）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadCore } from './lib/read-core.mjs';
import { createDistCorpus } from './lib/corpus-dist.mjs';
import { createCatalog } from './lib/catalog-source.mjs';
import { createSourcePacks } from './lib/packs-source.mjs';
import { createStdioEndpoint } from './lib/endpoint-stdio.mjs';
import { TARGET_FILES } from '../../站点/页面清单.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const DIST = path.join(ROOT, '站点/dist');

const core = createReadCore({
  corpus: createDistCorpus({ distDir: DIST, root: ROOT, targetFiles: TARGET_FILES }),
  catalog: createCatalog({ root: ROOT, targetFiles: TARGET_FILES }),
  packs: createSourcePacks({ root: ROOT }),
});

createStdioEndpoint({ core }).listen();
