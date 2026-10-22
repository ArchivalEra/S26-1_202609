// index.mjs —— 站点侧助手的对外入口（T10：协议栈搬到站点侧）
//
// ## 搬家边界
//   toolcycle.mjs / chatsvc.mjs / session.mjs / context.mjs / proto.mjs
//   都是从 /mnt/hdd/study/userscript/proto/ **原样复制**的（函数体逐字未动，
//   四个 .test.mjs 同目录、测试逻辑零改动）。本文件是唯一新写的部分：外壳。
//
// ## 为什么需要外壳
//   旧链路里 createManager 的默认 adapter（session.mjs 的 chaoxingAdapter）自己
//   new 一个 createAssistant 去连上游 WS——那要求 base/unitId/robotId 三件套。
//   搬到站点后三件套只在插件里（密文链，见 T7/T9），站点拿到的只有薄桥：
//
//     window.__assistantBridge = {
//       ask(payload, onEvent) → Promise<{ok, text?, reason?}>,
//       cancel(),
//       ready: Promise<boolean>,
//     }
//
//   所以 adapter 这一层换成 bridgeAdapter()：管理器仍负责重放水位、惰性轮换、
//   取消标记、墙钟兜底，只是「一次通道 ask」变成「一次 bridge.ask」，
//   正文增量从 onEvent 的 delta 转给工具会话的 askOpts.onChunk。
//   工具循环（提示词 → ask → 解析 → invoke → 回喂 → 再 ask）全部留在站点侧。
//
// ## 薄桥缺的两个能力（如实记下，不假装有）
//   · 没有 send：管理器重放背景段时退回 ask 慢路径（每条背景段一次完整往返）。
//     会话不轮换/不逐出时 hasGap 为假，正常问答不会触发重放。
//   · 没有 uploadImage：视觉链路（用户附件 / 模型调 site_image 看图）在站点侧
//     不可用；createChatService 的 upload 保持默认 null。

import { createManager } from './session.mjs';
import { createChatService } from './chatsvc.mjs';

/**
 * 桥 → 管理器 adapter。
 *
 * 管理器对通道的要求只有 open(cfg) → {ask, cancel?, close?, send?, uploadImage?}
 * （session.mjs 的 ensureChannel/doAsk 按 typeof 判可选方法），所以薄壳只实现
 * 实际用得上的三个：ask / cancel / close。
 *
 * @param {{ask: Function, cancel: Function}} bridge window.__assistantBridge
 */
function bridgeAdapter(bridge) {
  return {
    async open() {
      return {
        /**
         * 一次提问 = 一次 bridge.ask。
         *
         * @param {string} prompt 本轮完整提示词（工具表 + 页面上下文 + 任务句）
         * @param {object} [askOpts] 工具会话传来的 opts（这里只消费 onChunk）
         * @returns {Promise<{text: string, status: string, error?: string}>}
         *   status 用管理器认识的类型化值：
         *     answered  —— 正常答完（管理器落转录、推水位）
         *     cancelled —— 用户停止（管理器按 partial 落转录、不再重试）
         *     transport —— 其余失败（管理器按 reconnectAttempts 换线重试）
         */
        async ask(prompt, askOpts = {}) {
          const onChunk = askOpts && typeof askOpts.onChunk === 'function' ? askOpts.onChunk : null;
          const onEvent = (ev) => {
            if (!onChunk || !ev || ev.type !== 'delta' || ev.text == null) return;
            try { onChunk(String(ev.text)); } catch { /* 消费方自理 */ }
          };
          const r = await bridge.ask({ text: String(prompt == null ? '' : prompt) }, onEvent);
          const text = String((r && r.text) || '');
          if (r && r.ok === true) return { text, status: 'answered' };
          const reason = String((r && r.reason) || '');
          return {
            text,
            status: /cancel|停止|已停/.test(reason) ? 'cancelled' : 'transport',
            error: reason,
          };
        },
        /** 用户点「停止回答」：桥自身幂等；管理器另留 cancelRequested 标记兜底。 */
        cancel() {
          try { return bridge.cancel(); } catch { return { cancelled: false }; }
        },
        /** 桥的生命周期归插件（T9 的 ready 看门狗）；站点关会话不拆桥。 */
        close() {},
      };
    },
  };
}

/**
 * 建站点侧助手客户端。
 *
 * @param {object} p
 * @param {{ask: Function, cancel: Function}} p.bridge window.__assistantBridge
 * @param {Array<{name:string, description?:string, inputSchema?:object}>} [p.tools]
 *   页面工具定义（webmcp-tools 报上来的形状）
 * @param {Function} p.invoke (name, args) → Promise<{value, effect?}>
 *   工具执行接缝——T11 接 webmcp-tools.mjs 的 runTool，本模块不实现
 * @param {Function} [p.contextProvider] () → {title, course, path?, sections?}
 * @param {string[]} [p.navToolNames] 放行进提示词的工具名（G20：只取前 3 个）
 * @param {number} [p.rounds=4] 工具闭环最多轮数
 * @returns createChatService 的返回值：{ask, cancel, upload, setTools, snapshot, close}
 */
export function createAssistantClient({
  bridge, tools = [], invoke, contextProvider = null, navToolNames = null, rounds = 4,
} = {}) {
  if (!bridge || typeof bridge.ask !== 'function') {
    throw new Error('createAssistantClient: 缺少 bridge（window.__assistantBridge）');
  }
  if (typeof invoke !== 'function') {
    throw new Error('createAssistantClient: 缺少 invoke（工具执行接缝）');
  }
  const mgr = createManager({ adapter: bridgeAdapter(bridge) });
  return createChatService({
    mgr, tools, invoke, contextProvider, navToolNames, rounds,
  });
}
