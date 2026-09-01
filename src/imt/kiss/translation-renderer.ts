/**
 * 文件名称: translation-renderer.ts
 * 模块描述: Kiss 风格界面翻译的译文渲染器，负责双语译文的插入与恢复
 * 核心功能:
 *   - 块级单元在宿主元素内部追加译文块，行内单元在宿主后插入译文
 *   - 译文节点与宿主标记成对出现，恢复时成对清理
 */

import { DomTranslationUnit, IMT_HOST_MARK, IMT_TRANSLATION_CLASS } from "./scoped-dom-translator";

export class TranslationRenderer {
    /**
     * 在翻译单元位置插入译文节点，并给宿主打上已翻译标记
     * @param unit 扫描产出的翻译单元
     * @param translated 译文文本
     * @param extraClasses 追加的译文类名（pageRule.translationClasses）
     */
    public static render(unit: DomTranslationUnit, translated: string, extraClasses: string[] = []): HTMLElement {
        const node = unit.isBlock ? document.createElement("div") : document.createElement("span");
        node.classList.add(IMT_TRANSLATION_CLASS, ...extraClasses.filter(Boolean));
        node.textContent = translated;

        if (unit.insertAfter?.parentNode) {
            unit.insertAfter.parentNode.insertBefore(node, unit.insertAfter.nextSibling);
        } else if (unit.isBlock) {
            unit.host.appendChild(node);
        } else {
            unit.host.parentNode?.insertBefore(node, unit.host.nextSibling);
        }
        // 分段译文（insertAfter 模式）依赖渲染位置的相邻性去重，宿主不做整体标记
        if (!unit.insertAfter) {
            unit.host.setAttribute(IMT_HOST_MARK, "true");
        }
        return node;
    }

    /** 删除扫描范围内的所有译文节点并清除宿主标记 */
    public static restore(root: ParentNode = document.body): void {
        if (!(root instanceof Element) && !(root instanceof Document)) return;
        root.querySelectorAll(`.${IMT_TRANSLATION_CLASS}`).forEach(node => node.remove());
        root.querySelectorAll(`[${IMT_HOST_MARK}]`).forEach(node => node.removeAttribute(IMT_HOST_MARK));
    }
}
