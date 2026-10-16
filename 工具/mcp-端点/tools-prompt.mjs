#!/usr/bin/env node
/**
 * 破甲话术的工具清单生成器（**唯一生成处**，不再手抄）。
 *
 * 用法：
 *   node 工具/mcp-端点/tools-prompt.mjs          # 读层工具（course_*）
 *   node 工具/mcp-端点/tools-prompt.mjs site     # 浏览器侧工具（site_*）
 *
 * 为什么需要它：让学习通 AI 配合输出工具调用，靠的是**把工具包装成课程内的正常事物**
 * （配方与实测见 `.zcode/handoff.md` §0.44/§0.45）。那份清单从前手抄在话术里，
 * 与工具目录各活各的——现在由 `tool-catalog.mjs` 生成。
 */

import { COURSE_TOOLS, SITE_TOOLS_COURSE, renderToolCatalogForPrompt } from './lib/tool-catalog.mjs';

const which = process.argv[2] || 'course';
if (which === 'site') {
  console.log(renderToolCatalogForPrompt(SITE_TOOLS_COURSE, ''));
} else {
  console.log(renderToolCatalogForPrompt(COURSE_TOOLS));
}
