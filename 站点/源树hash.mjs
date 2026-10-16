/**
 * 源树内容 hash：**唯一真相源**（2026-10-16 从两处拷贝收成一份）。
 *
 * ## 它解决什么
 * MCP 读层要判断「构建产物是否落后于源」（stale）。判据不能靠 mtime
 * （`git checkout` 会改 mtime，内容没变也误判），所以改为**对源文件内容取哈希**：
 * 构建期写进 `index.json` 的 `sourceHash`，读层重算同一个值比对。
 *
 * ## 为什么必须是同一份实现
 * 这个算法**同时被写入端（`站点/build.mjs`）与校验端（`工具/mcp-端点/lib/corpus-dist.mjs`）使用**。
 * 从前它有两份拷贝、靠注释「必须与 build.mjs 逐字一致」维系——**其中一边改了分隔符，
 * stale 判定就会静默失效**（不报错，只是永远说不 stale）。收进本模块后不可能再漂。
 *
 * ## 算法（改它 = 换契约，两边同时生效）
 * 按清单顺序，对每个源文件：喂 `相对路径` + `\0` + `文件内容` + `\0` 进同一个 sha256，
 * 最后取十六进制前 16 位。**文件不存在时只喂路径与分隔符**（缺失也是状态的一部分）。
 *
 * 零依赖（只用 `node:crypto` / `node:fs` / `node:path`），构建期与读层共用。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** 取哈希的十六进制位数（写进产物、读层比对，两处同一个值）。 */
export const SOURCE_HASH_LENGTH = 16;

/**
 * 算源树内容 hash。
 * @param {string} root 仓库根
 * @param {string[]} targetFiles 页面清单（`站点/页面清单.mjs` 的 TARGET_FILES）
 * @returns {string} 16 位十六进制
 */
export function computeSourceHash(root, targetFiles) {
  const h = createHash('sha256');
  for (const relPath of targetFiles) {
    const full = path.join(root, relPath);
    h.update(relPath);
    h.update('\0');
    if (fs.existsSync(full)) h.update(fs.readFileSync(full));
    h.update('\0');
  }
  return h.digest('hex').slice(0, SOURCE_HASH_LENGTH);
}
