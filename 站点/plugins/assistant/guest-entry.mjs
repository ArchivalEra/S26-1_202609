// guest-entry.mjs —— B 侧入口：在**上游域**的 iframe 里跑起来
//
// ## 谁调用它
//
// 油猴脚本（@match 上游域，无 @noframes）。它 import proto + upstream-host + channel，
// 组装成应答器，向父窗口报到。
//
// ## 为什么单独一个文件
//
// 让「B 侧装配」可单测：测试里注入假的 proto / 假 window，不需要真上游、不需要 iframe。
// 油猴入口只负责「把真东西传进来」。
//
// ## 硬约束（违反即退回旧病灶）
//
// 本文件**不许** import toolcycle / chatsvc / session。B 只做上游代理，
// 工具循环与提示词拼装全部在 A 侧。见 upstream-host.mjs 的头注释。

import { createUpstreamHost } from './upstream-host.mjs';
import { createGuestEndpoint, createResponder } from './channel.mjs';

/**
 * 在 B 侧（上游域）装配。
 *
 * @param {object} p
 * @param {object} p.proto       协议栈（createAssistant 等）
 * @param {string} p.aOrigin     A 侧 origin（课程站，如 'https://isui.ren'）
 * @param {string} p.bOrigin     B 侧 origin（上游，如 'https://robot-lc.chaoxing.com'）
 * @param {string} p.unitId
 * @param {string} p.robotId
 * @param {Window} [p.parentWindow]  默认 window.parent
 * @param {Window} [p.selfWindow]    默认 window
 * @param {Function} [p.log]
 * @param {number} [p.trace]
 * @returns {{ announce: Function, host: object, dispose: Function }}
 */
export function bootGuest({
  proto, aOrigin, bOrigin, unitId, robotId,
  parentWindow, selfWindow, log = () => {}, trace = 1,
}) {
  const self = selfWindow || (typeof window !== 'undefined' ? window : null);
  const parent = parentWindow || (self && self.parent) || null;
  if (!self || !parent) throw new Error('bootGuest: 没有可用的 window/parent（不在 iframe 里？）');
  if (parent === self) throw new Error('bootGuest: 当前不是 iframe（parent === self），不做任何事');
  if (!aOrigin || !bOrigin) throw new Error('bootGuest: 缺 aOrigin/bOrigin');

  // 日志分两路（2026-10-25 站长要求接帧级日志）：
  //   ① 本地 console（调试时直接看 iframe）
  //   ② **经通道转发给 A**（面板/控制台能取到——iframe 的 console 默认看不见）
  // 转发用 responder.forwardLog，它在 A 侧落进环形缓冲。
  let forwardLog = () => {};   // responder 建好后再接上
  const localLog = (tag, ...a) => {
    const line = tag + ' ' + a.join(' ');
    try { log(line); } catch { /* 上层日志回调不许影响主流程 */ }
    try { forwardLog(line); } catch { /* 通道没通就丢 */ }
  };

  const host = createUpstreamHost({
    proto,
    base: bOrigin,
    unitId, robotId,
    log: (...a) => localLog('[B]', ...a),
    trace,
  });

  const endpoint = createGuestEndpoint({
    parentWindow: parent,
    aOrigin,
    bOrigin,
    listenOn: self,
  });

  const responder = createResponder({
    endpoint,
    host,
    log: (...a) => localLog('[B]', ...a),
  });
  forwardLog = responder.forwardLog;   // 接上：此后所有日志都会转给 A

  localLog('[B] 已就绪，等待 A 侧指令（origin 白名单：' + aOrigin + '）');

  return {
    host,
    dispose() {
      try { endpoint.dispose(); } catch { /* 忽略 */ }
      try { host.close(); } catch { /* 忽略 */ }
    },
  };
}
