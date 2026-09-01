/**
 * 文件名称: immersive.ts
 * 模块描述: 沉浸式翻译功能入口，负责翻译功能的激活、停用与单例管理
 * 核心功能:
 *   - 提供单例模式的ImmersiveTranslate类
 *   - 将激活/停用请求转发给本地 Kiss 风格界面翻译编排器
 *
 * 开发人员: zero
 * 维护人员: zero
 * 创建日期: 2025-08-15
 *
 * 修改日期:
 *   - 2025-08-15 [v1.0.0] zero: 初始版本，实现基础功能;
 *   - 2025-XX-XX [v1.1.0] zero: 整合为单例工具类
 *   - 2026-09-02 [v2.0.0] zero: 移除远程沉浸式翻译 SDK 注入，改用本地 Kiss 风格实现
 *
 * 注意事项:
 *   - 翻译区域由 settings.imtPagerule 决定，与原 SDK 的 pageRule 语义保持一致
 *   - 停用通过清理 DOM 与监听器完成，不再刷新页面
 */

import { KissObsidianTranslator, ImtActivationContext } from "src/imt/kiss/kiss-obsidian-translator";

export class ImmersiveTranslate {
    private static instance: ImmersiveTranslate | null = null;
    private translator = new KissObsidianTranslator();

    private constructor() {
    }

    /**
     * 获取单例实例
     */
    public static getInstance(): ImmersiveTranslate {
        if (!ImmersiveTranslate.instance) ImmersiveTranslate.instance = new ImmersiveTranslate();
        return ImmersiveTranslate.instance;
    }

    /**
     * 激活沉浸式翻译（创建悬浮球并自动翻译当前界面）
     */
    public activate(context: ImtActivationContext): void {
        this.translator.activate(context);
    }

    /**
     * 停用沉浸式翻译（清理译文节点、样式与监听器，不刷新页面）
     */
    public deactivate(): void {
        this.translator.deactivate();
    }
}

// 导出单例实例，方便直接使用
const immersiveTranslate = ImmersiveTranslate.getInstance();
export default immersiveTranslate;

// 为了保持向后兼容性，保留原有函数的导出
// @deprecated 使用ImmersiveTranslate类替代
const activateIMT = immersiveTranslate.activate.bind(immersiveTranslate);
// @deprecated 使用ImmersiveTranslate类替代
const deactivateIMT = immersiveTranslate.deactivate.bind(immersiveTranslate);

export { activateIMT, deactivateIMT };

export interface pageRule {
    mainFrameSelector?: string | string[];              // 翻译的根节点范围
    selectors?: string | string[];                      // 仅翻译匹配到的元素
    excludeSelectors?: string | string[];               // 排除元素，不翻译匹配的元素
    stayOriginalSelectors?: string | string[];          // 匹配的元素将保持原样。常用于论坛网站的标签。
    extraBlockSelectors?: string | string[];            // 额外的选择器，匹配的元素将作为 block 元素，独占一行。
    extraInlineSelectors?: string | string[];           // 额外的选择器，匹配的元素将作为 inline 元素。
    translationClasses?: string | string | string[];    // 为译文添加额外的 Class
    injectedCss?: string | string[];                    // 嵌入 CSS 样式
}
