/**
 * issue-status.mjs —— 「完成边界」唯一产地（GitHub Issue）解析与构建期自动隐身。
 *
 * 约定（2026-11-25 定案）：
 *   1. 页面内 `## 完成边界`（若存在）只允许写单一 issue 指针（`issue #N` 或对应超链接），
 *      禁止任何「缺件 / 缺图 / 未双签 / 已解析 / 已验证」第二产地文本。
 *   2. 缺件、双签、三签真实状态唯一住在对应 GitHub Issue 里。
 *   3. 构建期读取 issue 开闭态：CLOSED ⇒ 从页面正文 / TOC / 搜索 / machine 镜像中整节移除；
 *      OPEN（或离线不可达的保守回退）⇒ 保留指针栏。
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const DEFAULT_REPO = 'ArchivalEra/S26-1_202609';

const POINTER_RE = new RegExp(
  '^(?:-\\s+)?(?:'
  + '\\[issue\\s*#(\\d+)\\]\\(https:\\/\\/github\\.com\\/ArchivalEra\\/S26-1_202609\\/issues\\/\\1\\)'
  + '|issue\\s*#(\\d+)'
  + '|https:\\/\\/github\\.com\\/ArchivalEra\\/S26-1_202609\\/issues\\/(\\d+)'
  + ')$',
  'i'
);

/**
 * 校验「## 完成边界」正文是否严格为单一 issue 指针。
 * @param {string} body
 * @returns {{ok: true, issueNumber: number} | {ok: false, reason: string}}
 */
export function parseBoundaryPointer(body) {
  const trimmed = String(body || '').trim();
  if (!trimmed) return { ok: false, reason: '完成边界为空（应删除整节或写唯一 issue #N 指针）' };
  if (trimmed.includes('\n')) {
    return { ok: false, reason: '完成边界只允许保留唯一一行 issue 指针，禁止附加正文或列表' };
  }
  const m = POINTER_RE.exec(trimmed);
  if (!m) {
    return {
      ok: false,
      reason: `完成边界只允许写「issue #数字」或 GitHub issue 超链接，当前为：${trimmed.slice(0, 60)}`,
    };
  }
  const num = Number(m[1] || m[2] || m[3]);
  if (!Number.isInteger(num) || num <= 0) {
    return { ok: false, reason: `非法 issue 编号：${trimmed}` };
  }
  return { ok: true, issueNumber: num };
}

/**
 * 从整篇 Markdown 的「## 完成边界」节中提取 issue 编号（不存在或格式不符返回 null）。
 * @param {string} markdown
 * @returns {number | null}
 */
export function extractBoundaryIssueNumber(markdown) {
  const m = /(?:^|\n)## 完成边界[ \t]*\n([\s\S]*?)(?=\n## |\n---\n|$)/.exec(String(markdown || ''));
  if (!m) return null;
  const parsed = parseBoundaryPointer(m[1]);
  return parsed.ok ? parsed.issueNumber : null;
}

/**
 * 若「## 完成边界」指向的 issue 在 issueStates 中为 CLOSED，则整节剥除。
 * @param {string} markdown
 * @param {Map<number, string> | Record<string, string>} issueStates
 * @returns {string}
 */
export function stripClosedBoundary(markdown, issueStates) {
  const src = String(markdown || '');
  const re = /(?:^|\n)## 完成边界[ \t]*\n([\s\S]*?)(?=\n## |\n---\n|$)/;
  const m = re.exec(src);
  if (!m) return src;
  const parsed = parseBoundaryPointer(m[1]);
  if (!parsed.ok) return src;

  const num = parsed.issueNumber;
  let state = null;
  if (issueStates instanceof Map) {
    state = issueStates.get(num) ?? issueStates.get(String(num)) ?? null;
  } else if (issueStates && typeof issueStates === 'object') {
    state = issueStates[num] ?? issueStates[String(num)] ?? null;
  }
  if (String(state || '').toUpperCase() !== 'CLOSED') return src;

  const before = src.slice(0, m.index).replace(/\n+$/, '');
  const after = src.slice(m.index + m[0].length).replace(/^\n+/, '');
  if (!after) return before ? `${before}\n` : '';
  return before ? `${before}\n\n${after}` : after;
}

function normalizeStateMap(raw) {
  const map = new Map();
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && Number.isInteger(Number(item.number)) && item.state) {
        map.set(Number(item.number), String(item.state).toUpperCase());
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) {
      const n = Number(k);
      if (Number.isInteger(n) && v) map.set(n, String(v).toUpperCase());
    }
  }
  return map;
}

/**
 * 读取仓库 issue 状态映射：优先本地 override，其次 GitHub API / `gh` CLI；离线安全降级为空 Map。
 * @param {{repo?: string, statesFile?: string|null, env?: Record<string, string|undefined>, fetchImpl?: Function, execSyncImpl?: Function}} [opts]
 * @returns {Promise<Map<number, string>>}
 */
export async function loadIssueStates(opts = {}) {
  const repo = opts.repo || DEFAULT_REPO;
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const execSyncImpl = opts.execSyncImpl ?? execFileSync;

  if (opts.statesFile) {
    const parsed = JSON.parse(fs.readFileSync(opts.statesFile, 'utf8'));
    return normalizeStateMap(parsed);
  }
  if (env.ISSUE_STATES_JSON) {
    return normalizeStateMap(JSON.parse(env.ISSUE_STATES_JSON));
  }
  if (env.ACT === 'true' || env.OFFLINE === '1' || env.CI_OFFLINE === '1') {
    return new Map();
  }

  // 1) GitHub REST API (CI / 有公网与可选 GITHUB_TOKEN)
  if (typeof fetchImpl === 'function') {
    try {
      const token = env.GITHUB_TOKEN || env.GH_TOKEN;
      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'S26-1-site-builder',
      };
      if (token) headers.Authorization = `Bearer ${token}`;

      const collected = [];
      let page = 1;
      while (page <= 10) {
        const url = `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}`;
        const res = await fetchImpl(url, {
          headers,
          signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const items = await res.json();
        if (!Array.isArray(items) || items.length === 0) break;
        for (const it of items) {
          if (it && typeof it.number === 'number' && it.state) {
            collected.push({ number: it.number, state: String(it.state).toUpperCase() });
          }
        }
        if (items.length < 100) break;
        page += 1;
      }
      return normalizeStateMap(collected);
    } catch {
      // 走 gh CLI 回退（本机无外网 DNS 时 gh 走系统代理）
    }
  }

  // 2) gh CLI 回退
  try {
    const out = execSyncImpl(
      'gh',
      ['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', 'number,state'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return normalizeStateMap(JSON.parse(out));
  } catch {
    console.warn('[issue-status] 无法在线拉取 GitHub issue 状态（离线或未登录），未结案边界将按 OPEN 保留。');
    return new Map();
  }
}
