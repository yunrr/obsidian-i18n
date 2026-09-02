/**
 * 文件名称: obsidian-storage.ts
 * 模块描述: kiss 核心存储层的 Obsidian 适配器
 * 核心功能:
 *   - 以插件设置中的 kissStorage 键值表承载 kiss 的 STOKEY_* 全部存储键
 *   - 写入通过 i18n.saveSettings() 持久化到插件 data.json（带防抖）
 *
 * 注意事项:
 *   - 不使用 localStorage / browser.storage，避免污染与多写者冲突
 *   - kiss 的设置、规则等均以 JSON 字符串形式存于同一张表内
 */

import { useGlobalStoreInstance } from "src/utils/store/global";

const SAVE_DEBOUNCE_MS = 500;

let saveTimer: number | null = null;

/** 获取插件实例（含 settings 与 saveSettings） */
const getI18n = () => useGlobalStoreInstance.getState().i18n;

/** 获取（并按需初始化）kiss 存储表 */
const getKvTable = (): Record<string, string> => {
    const settings = getI18n().settings as any;
    if (!settings.kissStorage || typeof settings.kissStorage !== "object") {
        settings.kissStorage = {};
    }
    return settings.kissStorage;
};

/** 防抖持久化，避免设置面板高频输入造成频繁写盘 */
const scheduleSave = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        saveTimer = null;
        void getI18n().saveSettings();
    }, SAVE_DEBOUNCE_MS);
};

export const obsidianStorageGet = async (key: string): Promise<string | null> => {
    const value = getKvTable()[key];
    return value === undefined ? null : value;
};

export const obsidianStorageSet = async (key: string, val: string): Promise<void> => {
    getKvTable()[key] = val;
    scheduleSave();
};

export const obsidianStorageDel = async (key: string): Promise<void> => {
    delete getKvTable()[key];
    scheduleSave();
};
