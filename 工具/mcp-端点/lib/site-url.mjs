// site-url.mjs —— 「网址 ↔ 段位 ↔ 源路径」的唯一真相（读层用）。
//
// ## 为什么需要这个模块（codebase-design 的 deepening）
//
// 2026-10-31 修 GitRoll 那批告警时，`read-core.mjs` 里同时散着四件同源的事：
//
//   · `courseOf(url)`    —— 从网址取课程名（写死 `TOP_DIR`）
//   · `categoryOf(url)`  —— 从网址取类目名（再写一次 `TOP_DIR`）
//   · `resolveRef(ref)`  —— 从三元组拼源路径（第三次写死 `'课程总览'`）
//   · `pages()` 的 url   —— 在 `catalog-source.mjs` 里抄了第四份规则
//
// 四份手抄 = 四个会漂的点。实测代价已经付过一次：仓库把 `课程/` 改名成
// `课程总览/` 之后，读层按课程过滤**静默失效**（不报错，只是永远过滤掉所有命中），
// 11 条测试红了很久没人知道原因。
//
// 所以把「段位」这件事收进一个**深模块**：接口五个纯函数，内部管住
// 顶层目录名、分隔符、以及 url 与源路径的互逆。所有调用方只认这五个动作。
//
// ## 三条不变量
//
// ① **顶层目录名只在这里出现一次**。改名 = 改一个常量，不是 grep 全仓。
// ② **url 与源路径互逆**：`toUrl(toPath(u)) === u`（首页与目录页这两个边界要成立）。
// ③ **不依赖 fs / DOM / 构建期模块** —— 纯字符串函数，node 里直接测。

/**
 * 站点内容的顶层目录名。
 *
 * ⚠️ 这是**全仓唯一**的一份。构建期的侧栏与页面清单从目录结构发现它，
 * 读层（本模块的消费方）从这里拿。改名时只改这里 + 实际目录名。
 */
export const TOP_DIR = '课程总览';

/** 首页在仓库里的物理文件名（网址是空串，源路径是这个）。 */
export const HOME_SOURCE = 'README.md';

/** 段位：`课程总览/工程数学/作业/习题册第二章.html` → ['课程总览','工程数学','作业','习题册第二章'] */
export function segmentsOf(pathOrUrl) {
  // ⚠️ 先归一化成**网址形态**再分段（2026-10-31 闸门抓到的真 bug）：
  // 传进来的可能是源路径（`课程总览/index.md`）也可能是网址（`课程总览/`）。
  // 源路径里 `index.md` 会占掉一个「段」，于是 `courseOf('课程总览/index.md')`
  // 会返回 `'index.md'` —— 拿文件名当课程名。
  // 判据：`.md` 结尾的先转成网址（目录索引变 `目录/`），再分段。
  let u = safeDecode(String(pathOrUrl || ''));
  if (u.endsWith('.md')) u = toUrl(u);
  // 去掉首尾斜杠再分段：`课程总览/` 与 `课程总览` 要得到同一结果
  const trimmed = u.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed ? trimmed.split('/') : [];
}

/**
 * 从网址（或源路径）取课程名。首页与顶层目录本身返回空串。
 *
 * 判据是**「第一段是不是顶层内容目录」**，不是「第二段像不像课程名」——
 * 后者在 `README.md`、`维护条例.md` 这类站点级页面上会误报。
 */
export function courseOf(pathOrUrl) {
  const s = segmentsOf(pathOrUrl);
  if (s[0] !== TOP_DIR) return '';
  return s[1] || '';
}

/** 从网址（或源路径）取类目名（课程下第一层，如 `作业`、`课堂笔记`）。 */
export function categoryOf(pathOrUrl) {
  const s = segmentsOf(pathOrUrl);
  if (s[0] !== TOP_DIR) return '';
  return s[2] || '';
}

/**
 * 三元组 → 源路径（`read_page` 的 `(course, category, file)` 形态）。
 *
 * 三项都必须给：`parts.length >= 3` 那种判据读不出「三个都要」这个要求
 * （因为 parts 恰好由这三个可选字段拼出来，永远成立）。
 */
export function toSourcePath({ course, category, file } = {}) {
  if (!course || !category || !file) return null;
  return [TOP_DIR, course, category, file].join('/');
}

/**
 * 源路径 → 网址。
 *
 * 规则与构建期的 `htmlPathOf` 同源（那里是权威实现；本模块复刻它的三条分支）：
 *   · `README.md`（首页）      → `''`（站点根）
 *   · `…/index.md`（目录索引）  → `目录/`（**不带 index.html**）
 *   · 其余 `.md`                → `….html`
 *
 * ⚠️ 为什么不直接 import 构建期的 `htmlPathOf`：那是 `站点/plugins/` 里的模块，
 * 带 CSS/JS 常量等构建期依赖，读层引它会拖进一堆无关东西。这里只复刻**那三条
 * 分支**（8 行），并在闸门里断言「与 htmlPathOf 对同一输入给出同一结果」——
 * 用测试锁住克隆，而不是用 import 制造耦合。
 */
export function toUrl(sourcePath) {
  const p = String(sourcePath || '');
  if (p === HOME_SOURCE) return '';
  if (p.endsWith('/index.md')) return p.slice(0, -'index.md'.length);
  return p.replace(/\.md$/, '.html');
}

/**
 * 网址 → 源路径（`toUrl` 的逆）。
 *
 * `''` → `README.md`；`目录/` → `目录/index.md`；`….html` → `….md`。
 */
export function toSource(urlOrUrl) {
  const u = String(urlOrUrl || '');
  if (u === '') return HOME_SOURCE;
  if (u.endsWith('/')) return u + 'index.md';
  if (u.endsWith('.html')) return u.replace(/\.html$/, '.md');
  // 既不以 / 结尾也不是 .html —— 读层不猜，原样返回（调用方按 unknown_page 处理）
  return u;
}

/** `decodeURIComponent` 失败时原样返回（坏 URL 不该把整个读层打挂）。 */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (e) { return s; }
}
