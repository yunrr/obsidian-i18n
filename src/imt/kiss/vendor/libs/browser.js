/**
 * @file browser.js
 * @description 浏览器环境桥接模块，用于引入 WebExtension Polyfill 垫片，并提供当前执行环境上下文 (Background, Options, Content Script) 的判定工具。
 * [obsidian-i18n 移植补丁] 不再 require("webextension-polyfill")，改为读取 globalThis.browser（Obsidian 环境下为 undefined）。
 */

/**
 * 尝试安全加载 webextension-polyfill
 * @returns {object|undefined} 浏览器插件 API polyfill 实例，非插件环境则返回 undefined
 */
function _browser() {
  try {
    return globalThis.browser;
  } catch (err) {
    // 非扩展环境下运行时忽略报错
  }
  return undefined;
}

// 统一的浏览器扩展 API 导出对象
export const browser = _browser();

/**
 * 获取当前脚本在浏览器扩展中的具体执行环境上下文
 * @returns {string} 返回 "background" | "content" | "options" | "popup" | "undefined"
 */
export const getContext = () => {
  const context = globalThis.__KISS_CONTEXT__;
  if (context) return context;
  return "undefined";
};

// 辅助环境判定变量
export const isBg = () => getContext() === "background";
export const isOptions = () => getContext() === "options";

// 判断当前浏览器内核中是否支持原生内置 AI (LanguageDetector 和 Translator，目前主要是 Chrome Dev 138+)
// Obsidian 渲染进程没有这些全局对象，恒为 false，BuiltinAI 相关路径自然禁用。
export const isBuiltinAIAvailable =
  "LanguageDetector" in globalThis && "Translator" in globalThis;
