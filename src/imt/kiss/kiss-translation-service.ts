/**
 * 文件名称: kiss-translation-service.ts
 * 模块描述: 界面翻译的文本翻译服务层，桥接 kiss-translator 翻译核心
 * 核心功能:
 *   - 从 kiss 设置（存储于插件 kissStorage）解析当前选中的翻译 API 与提示词
 *   - 逐条调用 kiss 的 apiTranslate（多供应商、批量合并、池化限流、请求缓存均由 kiss 核心承担）
 *   - 会话级原文->译文缓存与任务中断
 *
 * 注意事项:
 *   - 流式请求在 Obsidian 下被禁用（requestStream 适配层会抛错），故强制 useStream=false
 *   - 供应商选择/目标语言/译文样式等 kiss 设置通过设置页写入，见 i18n-mode-imt.ts
 */

import { apiTranslate } from "./vendor/apis/index";
import { getSettingWithDefault } from "./vendor/libs/storage";
import { resolveApiPromptSettings } from "./vendor/config/prompt";
import { kissLog } from "./vendor/libs/log";
import { OPT_TRANS_BUILTINAI, DEFAULT_API_LIST } from "./vendor/config/api";

/** 在 Obsidian 中永远不可用的 kiss 供应商（浏览器内置 AI 依赖 chrome.translation API） */
const OBSIDIAN_UNUSABLE_APIS = new Set([OPT_TRANS_BUILTINAI]);

export class KissTranslationService {
    /** 会话级翻译缓存: 原文 -> 译文（kiss 核心另有请求级缓存） */
    private cache: Map<string, string> = new Map();
    /** 当前翻译任务的中断控制器 */
    private controller: AbortController | null = null;

    /** 中断当前翻译任务 */
    public abort(): void {
        this.controller?.abort();
        this.controller = null;
    }

    /** 清空会话缓存 */
    public clearCache(): void {
        this.cache.clear();
    }

    /**
     * 批量翻译文本，返回 原文 -> 译文 映射
     * @param texts 待翻译文本（内部按缓存与重复项去重）
     * @param onProgress 翻译进度回调 (已完成条数, 总条数)
     */
    public async translate(
        texts: string[],
        onProgress?: (done: number, total: number) => void
    ): Promise<Map<string, string>> {
        // 每次翻译都读取最新 kiss 设置，保证设置页修改即时生效
        const setting = (await getSettingWithDefault()) as any;
        const apis: any[] = Array.isArray(setting.transApis) && setting.transApis.length
            ? setting.transApis
            : DEFAULT_API_LIST;
        const selectedSlug = setting.selectedApiSlug;
        const usable = (api: any) => api && !api.isDisabled && !OBSIDIAN_UNUSABLE_APIS.has(api.apiType);
        const baseApi =
            apis.find(api => api.apiSlug === selectedSlug && usable(api)) ||
            apis.find(api => usable(api)) ||
            apis[0];

        if (!baseApi) {
            throw new Error("Kiss 翻译：未找到可用的翻译 API 配置");
        }

        // 流式请求在 Obsidian 下不可用，强制关闭；提示词按 kiss 的解析逻辑展开
        const apiSetting = resolveApiPromptSettings(
            { ...baseApi, useStream: false },
            setting.prompts || [],
            setting.subtitleSetting || {}
        );
        const fromLang = setting.selectedFromLang || "auto";
        const toLang = setting.selectedToLang || "zh-CN";

        const result = new Map<string, string>();
        const pending: string[] = [];
        for (const text of texts) {
            if (result.has(text)) continue;
            const cached = this.cache.get(text);
            if (cached !== undefined) {
                result.set(text, cached);
            } else {
                result.set(text, text); // 失败时保底回退原文
                pending.push(text);
            }
        }
        if (pending.length === 0) return result;

        // 新一轮任务开始前中断上一轮
        this.abort();
        const controller = new AbortController();
        this.controller = controller;
        const signal = controller.signal;

        const total = pending.length;
        let done = 0;
        let aborted = false;

        const runOne = async (text: string): Promise<void> => {
            try {
                // vendor 为 JS 模块，类型系统只能推断到 Object，这里统一按 any 桥接
                const translateApi = apiTranslate as any;
                const { trText } = await translateApi({
                    text,
                    fromLang,
                    toLang,
                    apiSetting,
                    useCache: true,
                    usePool: true,
                    signal,
                });
                if (trText) {
                    result.set(text, trText);
                    this.cache.set(text, trText);
                }
            } catch (error) {
                if (signal.aborted || (error as Error)?.name === "AbortError") {
                    aborted = true;
                    return;
                }
                kissLog("[i18n-kiss] translate item failed:", error);
                // 单条失败保持回退原文，不阻塞其余条目
            } finally {
                done++;
                onProgress?.(done, total);
            }
        };

        // 带并发上限的执行队列；批量型供应商内部还会由 kiss 的 BatchQueue 自动合并请求
        const limit = Math.max(1, Math.min(8, Number((apiSetting as any)?.fetchLimit) || 4));
        let index = 0;
        const workers = Array.from(
            { length: Math.min(limit, pending.length) },
            async () => {
                while (index < pending.length && !aborted) {
                    const text = pending[index++];
                    await runOne(text);
                }
            }
        );
        await Promise.all(workers);

        if (this.controller === controller) this.controller = null;
        if (aborted || signal.aborted) {
            throw new Error("翻译任务已取消");
        }
        return result;
    }
}
