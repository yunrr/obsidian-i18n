/**
 * 文件名称: scoped-dom-translator.ts
 * 模块描述: Kiss 风格界面翻译的 DOM 扫描器，按 pageRule 圈定翻译区域
 * 核心功能:
 *   - mainFrameSelector 决定扫描根，selectors 白名单决定实际翻译的元素
 *   - excludeSelectors / stayOriginalSelectors 排除与保持原样
 *   - 识别文本叶子元素并产出翻译单元，扫描过程不修改 DOM
 *
 * 注意事项:
 *   - 与原沉浸式翻译 SDK 的 pageRule 语义保持一致，翻译区域行为不变
 *   - CodeMirror 编辑器内部与 contenteditable 区域任何配置下都不进入
 */

import type { pageRule } from "src/utils/ui/immersive";

/** 译文节点类名 */
export const IMT_TRANSLATION_CLASS = "imt-kiss-translation";

/** 已翻译宿主元素标记 */
export const IMT_HOST_MARK = "data-imt-kiss-host";

/** 译文插入位置：host 为挂载点，insertAfter 存在时译文插到该节点之后 */
export interface DomTranslationUnit {
    host: HTMLElement;
    insertAfter: ChildNode | null;
    text: string;
    isBlock: boolean;
}

/** 不参与翻译的标签 */
const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "CODE", "PRE", "KBD", "SAMP", "SVG", "MATH", "CANVAS", "IFRAME", "OBJECT", "EMBED",
    "VIDEO", "AUDIO", "PICTURE", "SOURCE", "TRACK", "MAP", "IMG", "META", "LINK", "DIALOG",
]);

/** 任何配置下都不进入的结构，防止破坏 CodeMirror 编辑器 */
const HARD_SKIP_SELECTORS = [".cm-editor", ".cm-content"];

/** 可翻译文本的长度上下限 */
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 1000;

const toList = (value?: string | string[]): string[] => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
};

const matchesAny = (el: Element, selectors: string[]): boolean => {
    for (const selector of selectors) {
        try {
            if (el.matches(selector)) return true;
        } catch {
            // 非法选择器直接忽略
        }
    }
    return false;
};

const queryAll = (root: ParentNode, selectors: string[]): Element[] => {
    const found: Element[] = [];
    for (const selector of selectors) {
        try {
            root.querySelectorAll(selector).forEach(el => found.push(el));
        } catch {
            // 非法选择器直接忽略
        }
    }
    return found;
};

/** 行内显示（inline）之外的布局都视作块级容器 */
const isBlockDisplay = (el: HTMLElement): boolean => {
    const display = getComputedStyle(el).display;
    return display !== "inline" && display !== "none" && display !== "contents";
};

const isTranslatable = (text: string): boolean => {
    const trimmed = text.trim();
    if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length > MAX_TEXT_LENGTH) return false;
    if (!/[\p{L}]/u.test(trimmed)) return false; // 至少包含一个字母，跳过纯数字/符号
    if (/^https?:\/\//i.test(trimmed)) return false;
    return true;
};

interface ScanState {
    units: DomTranslationUnit[];
    /** 本轮扫描中已产出翻译单元的元素，用于白名单目标互相包含时去重 */
    covered: Set<Element>;
}

export class ScopedDomTranslator {
    private rule: pageRule;
    private excludeSelectors: string[];
    private stayOriginalSelectors: string[];
    private extraBlockSelectors: string[];
    private extraInlineSelectors: string[];

    constructor(rule: pageRule) {
        this.rule = rule || {};
        this.excludeSelectors = [...HARD_SKIP_SELECTORS, ...toList(this.rule.excludeSelectors)];
        this.stayOriginalSelectors = toList(this.rule.stayOriginalSelectors);
        this.extraBlockSelectors = toList(this.rule.extraBlockSelectors);
        this.extraInlineSelectors = toList(this.rule.extraInlineSelectors);
    }

    /**
     * 按 pageRule 收集翻译单元
     * @param root 默认 document.body；mainFrameSelector 存在时以其匹配元素为根
     */
    public collect(root: ParentNode = document.body): DomTranslationUnit[] {
        const units: DomTranslationUnit[] = [];
        const covered = new Set<Element>();
        const state: ScanState = { units, covered };

        const selectors = toList(this.rule.selectors);
        for (const scanRoot of this.resolveScanRoots(root)) {
            if (!selectors.length) {
                this.visit(scanRoot, state);
                continue;
            }

            // 白名单模式：只处理匹配元素，嵌套匹配按文档序去重
            const targets = queryAll(scanRoot, selectors)
                .filter((el): el is HTMLElement => el instanceof HTMLElement && matchesAny(el, selectors))
                .sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

            for (const target of targets) {
                if (covered.has(target)) continue;
                this.visit(target, state);
            }
        }
        return units;
    }

    /** 解析扫描根：mainFrameSelector 优先，无配置时回落到 root */
    private resolveScanRoots(root: ParentNode): HTMLElement[] {
        const base = root instanceof HTMLElement ? root : document.body;
        const mainFrames = toList(this.rule.mainFrameSelector);
        if (!mainFrames.length) return [base];

        const candidates = queryAll(document.body, mainFrames)
            .filter((el): el is HTMLElement => el instanceof HTMLElement);
        candidates.sort((a, b) => a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

        const roots: HTMLElement[] = [];
        for (const candidate of candidates) {
            if (roots.some(existing => existing.contains(candidate))) continue;
            roots.push(candidate);
        }
        return roots;
    }

    /** 判断元素是否不可进入翻译 */
    private skipElement(el: HTMLElement): boolean {
        if (SKIP_TAGS.has(el.tagName)) return true;
        if (el.classList.contains(IMT_TRANSLATION_CLASS)) return true;
        if (el.hasAttribute(IMT_HOST_MARK)) return true;
        if (el.isContentEditable) return true;
        if (matchesAny(el, this.excludeSelectors)) return true;
        if (matchesAny(el, this.stayOriginalSelectors)) return true;
        return false;
    }

    /** 块级判定：extraBlock/extraInline 选择器优先于实际布局 */
    private isBlockElement(el: HTMLElement): boolean {
        if (matchesAny(el, this.extraBlockSelectors)) return true;
        if (matchesAny(el, this.extraInlineSelectors)) return false;
        return isBlockDisplay(el);
    }

    /** 译文插入形态：extraBlock/extraInline 选择器优先于实际布局 */
    private unitIsBlock(el: HTMLElement): boolean {
        if (matchesAny(el, this.extraBlockSelectors)) return true;
        if (matchesAny(el, this.extraInlineSelectors)) return false;
        return !isInlineOnly(el);
    }

    /**
     * 递归访问元素并产出翻译单元：
     * - 叶子容器（无块级子元素）：整块文本作为一个翻译单元
     * - 混合容器：直接文本与行内子元素文本按块级边界分段收集，再递归块级子元素
     */
    private visit(el: HTMLElement, state: ScanState): void {
        if (!(el instanceof HTMLElement) || this.skipElement(el) || state.covered.has(el)) return;

        const visibleChildren = (Array.from(el.children) as HTMLElement[])
            .filter(child => !this.skipElement(child));
        const blockChildren = visibleChildren.filter(child => this.isBlockElement(child));

        if (blockChildren.length === 0) {
            const text = el.textContent?.trim() ?? "";
            if (isTranslatable(text)) {
                state.units.push({
                    host: el,
                    insertAfter: null,
                    text,
                    isBlock: this.unitIsBlock(el),
                });
                state.covered.add(el);
            }
            return;
        }

        let lastNode: ChildNode | null = null;
        let runText = "";
        const flushRun = () => {
            const trimmed = runText.trim();
            // 分段译文已渲染（插在上一个文本节点之后）时不重复产出
            const nextSibling = lastNode?.nextSibling;
            const alreadyRendered = nextSibling instanceof Element
                && nextSibling.classList.contains(IMT_TRANSLATION_CLASS);
            if (lastNode && isTranslatable(trimmed) && !alreadyRendered) {
                state.units.push({ host: el, insertAfter: lastNode, text: trimmed, isBlock: false });
            }
            runText = "";
            lastNode = null;
        };

        for (const node of Array.from(el.childNodes)) {
            if (node.nodeType === Node.TEXT_NODE) {
                runText += node.textContent ?? "";
                if ((node.textContent ?? "").trim()) lastNode = node;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                const child = node as HTMLElement;
                if (this.skipElement(child) || blockChildren.includes(child)) {
                    flushRun();
                    continue;
                }
                // 行内子元素：其文本并入当前分段，译文插到该元素之后
                runText += child.textContent ?? "";
                if ((child.textContent ?? "").trim()) lastNode = child;
            } else {
                flushRun();
            }
        }
        flushRun();

        for (const child of blockChildren) {
            this.visit(child, state);
        }
    }
}

/** 是否为纯行内元素（译文需要以行内形式插入） */
const isInlineOnly = (el: HTMLElement): boolean => {
    return getComputedStyle(el).display === "inline";
};
