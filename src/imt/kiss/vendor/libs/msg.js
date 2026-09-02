import { browser } from "./browser";

/**
 * @file msg.js
 * @description 浏览器扩展消息通信模块。
 * [obsidian-i18n 移植补丁] Obsidian 环境没有 browser.runtime / browser.tabs，
 * 所有消息函数都会安全短路，翻译链路不经过消息总线。
 */

/**
 * 获取当前用户正在浏览且聚焦的活跃标签页 (Tab) 信息。
 * @returns {Promise<Object|undefined>} 活跃的标签页对象
 */
export const getCurTab = async () => {
  if (!browser?.tabs) return undefined;
  const [tab] = await browser.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  return tab;
};

/**
 * 获取当前活跃标签页的 ID。
 * @returns {Promise<number|undefined>} 标签页 ID
 */
export const getCurTabId = async () => {
  const tab = await getCurTab();
  return tab?.id;
};

/**
 * 向扩展后台 Service Worker (Background) 发送单向或双向消息。
 * @param {string} action 指令动作名称
 * @param {Object} args 指令参数数据
 * @returns {Promise<*>} 后台响应的数据
 */
export const sendBgMsg = (action, args) => {
  if (!browser?.runtime) return undefined;
  return browser.runtime.sendMessage({ action, args });
};

/**
 * 向当前活跃页面标签发送通信消息。
 * @param {string} action 指令动作名称
 * @param {Object} args 指令参数数据
 * @returns {Promise<*>} 页面 Content Script 接收处理后的响应数据
 */
export const sendTabMsg = async (action, args) => {
  if (!browser?.tabs) return undefined;
  const tabId = await getCurTabId();
  if (!tabId) return;

  // 向指定 ID 的标签页发送消息，并捕获常见的由于注入未就绪产生的错误
  return browser.tabs.sendMessage(tabId, { action, args }).catch((err) => {
    if (
      err?.message?.includes("Could not establish connection") ||
      err?.message?.includes("Receiving end does not exist")
    ) {
      return;
    } else {
      throw err;
    }
  });
};
