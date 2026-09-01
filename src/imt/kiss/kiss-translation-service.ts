/**
 * 文件名称: kiss-translation-service.ts
 * 模块描述: Kiss 风格界面翻译的文本翻译服务层
 * 核心功能:
 *   - 将待翻译文本批量交给项目现有 LLM 翻译 provider
 *   - 会话级原文->译文缓存，同一文案（菜单/设置项）只翻译一次
 *   - 新一轮任务自动中断上一轮，支持外部中止
 *
 * 注意事项:
 *   - 批次失败时条目回退为原文，不阻塞其余批次（由 base-provider 统一提示）
 *   - 后续如需接入 kiss-translator 的多服务商 apiTranslate，仅需替换本文件实现
 */

import { createTranslationProvider } from "src/ai/provider-factory";
import { RegexItem } from "src/views/plugin_editor/types";

export class KissTranslationService {
    /** 会话级翻译缓存: 原文 -> 译文 */
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

        const provider = createTranslationProvider();
        const items: RegexItem[] = pending.map((source, id) => ({ id, source, target: "" }));
        const total = pending.length;
        let done = 0;

        try {
            const translated = await provider.regexTranslate(
                items,
                (batch) => {
                    for (const item of batch) {
                        const target = item.target?.trim() ? item.target : item.source;
                        result.set(item.source, target);
                        this.cache.set(item.source, target);
                    }
                    done += batch.length;
                    onProgress?.(done, total);
                },
                controller.signal,
                (batchItems) => {
                    // 批次失败：条目保持回退原文，进度继续推进
                    done += batchItems.length;
                    onProgress?.(done, total);
                }
            );

            for (const item of translated) {
                const target = item.target?.trim() ? item.target : item.source;
                result.set(item.source, target);
                this.cache.set(item.source, target);
            }

            return result;
        } finally {
            if (this.controller === controller) this.controller = null;
        }
    }
}
