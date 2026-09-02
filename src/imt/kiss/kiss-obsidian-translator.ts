/**
 * 文件名称: kiss-obsidian-translator.ts
 * 模块描述: Kiss 风格界面翻译编排器，替代远程沉浸式翻译 SDK
 * 核心功能:
 *   - 管理悬浮球/面板 UI、激活与停用生命周期
 *   - 按 pageRule 扫描并翻译当前界面，MutationObserver 跟进动态内容（菜单/通知）
 *   - 停用时清理译文节点、样式与监听器，不刷新页面
 *
 * 注意事项:
 *   - 翻译区域由 settings.imtPagerule 决定，与原 SDK 行为一致
 *   - 文本翻译由 KissTranslationService 提供，本文件不感知具体翻译后端
 */

import { I18nSettings } from "src/settings/data";
import { t } from "src/locales";
import { ScopedDomTranslator } from "./scoped-dom-translator";
import { TranslationRenderer } from "./translation-renderer";
import { KissTranslationService } from "./kiss-translation-service";
import { genTextClass } from "./vendor/libs/style";
import { getSettingWithDefault } from "./vendor/libs/storage";

/** 激活上下文：由 CoreManager 传入 */
export interface ImtActivationContext {
    settings: I18nSettings;
    /** 注册插件卸载时的自动清理回调 */
    registerCleanup?: (cleanup: () => void) => void;
}

/** 动态内容（菜单、通知等）出现后的防抖延迟 */
const OBSERVER_DEBOUNCE_MS = 600;
/** 注入样式节点 id */
const INJECTED_STYLE_ID = "imt-kiss-injected-css";
/** kiss 译文样式表节点 id */
const KISS_TEXT_STYLE_ID = "imt-kiss-text-styles";

const toList = (value?: string | string[]): string[] => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
};

const BALL_SVG = '<svg t="1759459310417" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="1662" width="20" height="20"><path d="M213.333333 640v85.333333a85.333333 85.333333 0 0 0 78.933334 85.12L298.666667 810.666667h128v85.333333H298.666667a170.666667 170.666667 0 0 1-170.666667-170.666667v-85.333333h85.333333z m554.666667-213.333333l187.733333 469.333333h-91.946666l-51.242667-128h-174.506667l-51.157333 128h-91.904L682.666667 426.666667h85.333333z m-42.666667 123.093333L672.128 682.666667h106.325333L725.333333 549.76zM341.333333 85.333333v85.333334h170.666667v298.666666H341.333333v128H256v-128H85.333333V170.666667h170.666667V85.333333h85.333333z m384 42.666667a170.666667 170.666667 0 0 1 170.666667 170.666667v85.333333h-85.333333V298.666667a85.333333 85.333333 0 0 0-85.333334-85.333334h-128V128h128z" fill="currentColor"  p-id="1663"></path></svg>';

export class KissObsidianTranslator {
    private ctx: ImtActivationContext | null = null;
    private active = false;
    private ball: HTMLElement | null = null;
    private panel: HTMLElement | null = null;
    private statusEl: HTMLElement | null = null;
    private injectedStyle: HTMLStyleElement | null = null;
    private observer: MutationObserver | null = null;
    private debounceTimer: number | null = null;
    private running = false;
    private pendingRun = false;
    private service = new KissTranslationService();
    private scanner: ScopedDomTranslator | null = null;
    /** kiss 译文样式类映射 (styleSlug -> class) */
    private kissTextClass: Record<string, string> | null = null;
    /** 当前选中的 kiss 译文样式 slug */
    private kissTextStyleSlug = "style_none";
    /** kiss 样式表注入完成的信号 */
    private stylesReady: Promise<void> = Promise.resolve();

    /** 激活界面翻译：创建悬浮球、注入样式、启动观察器并自动翻译当前界面 */
    public activate(ctx: ImtActivationContext): void {
        if (this.active) return;
        this.ctx = ctx;
        this.active = true;
        this.scanner = new ScopedDomTranslator(ctx.settings.imtPagerule);
        this.createBall();
        this.applyInjectedCss();
        this.stylesReady = this.applyKissTextStyles();
        this.setupObserver();
        ctx.registerCleanup?.(() => this.deactivate());
        // 激活后自动翻译当前界面，与原 SDK 行为保持一致
        void this.translateDocument(true);
    }

    /** 停用界面翻译：中断任务、恢复原文、清理全部 DOM 与监听器 */
    public deactivate(): void {
        if (!this.active) return;
        this.active = false;
        this.ctx = null;
        if (this.debounceTimer !== null) {
            window.clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.observer?.disconnect();
        this.observer = null;
        this.service.abort();
        this.pendingRun = false;
        this.running = false;
        TranslationRenderer.restore(document.body);
        this.removeInjectedCss();
        this.removeKissTextStyles();
        this.removeBall();
        this.scanner = null;
    }

    /** 手动触发一次界面翻译 */
    public restore(): void {
        this.pendingRun = false;
        this.service.abort();
        TranslationRenderer.restore(document.body);
        this.updateStatus(t("Settings.Immersive.Restored"));
    }

    /**
     * 扫描并翻译当前界面，进行中的重复触发会合并为一次追加执行
     * @param manual 是否由用户/激活流程显式触发（决定空结果时是否提示）
     */
    public async translateDocument(manual: boolean = false): Promise<void> {
        if (!this.active || !this.scanner || !this.ctx) return;
        if (this.running) {
            this.pendingRun = true;
            return;
        }
        this.running = true;

        try {
            await this.stylesReady;
            if (!this.active || !this.scanner || !this.ctx) return;
            const units = this.scanner.collect(document.body);
            if (!units.length) {
                // 观察器引起的空轮询不打扰状态显示
                if (manual) this.updateStatus(t("Settings.Immersive.NothingToTranslate"));
                return;
            }

            const styleClass = this.kissTextClass?.[this.kissTextStyleSlug];
            const extraClasses = [
                ...(styleClass ? [styleClass] : []),
                ...toList(this.ctx.settings.imtPagerule?.translationClasses),
            ].filter(Boolean);
            this.updateStatus(`${t("Settings.Immersive.Translating")} 0/${units.length}`);
            const map = await this.service.translate(
                units.map(unit => unit.text),
                (done, total) => this.updateStatus(`${t("Settings.Immersive.Translating")} ${done}/${total}`)
            );

            let count = 0;
            for (const unit of units) {
                const translated = map.get(unit.text);
                // 源目标相同（或批次失败回退原文）时不插入译文
                if (!translated || translated === unit.text) continue;
                TranslationRenderer.render(unit, translated, extraClasses);
                count++;
            }
            this.updateStatus(`${t("Settings.Immersive.TranslateDone")} (+${count})`);
        } catch (error) {
            if ((error as Error)?.message !== "翻译任务已取消") {
                this.updateStatus(t("Settings.Immersive.TranslateFailed"));
                console.error("[i18n-kiss] translate document failed:", error);
            }
        } finally {
            this.running = false;
            if (this.pendingRun && this.active) {
                this.pendingRun = false;
                void this.translateDocument();
            }
        }
    }

    /** 创建悬浮球与操作面板 */
    private createBall(): void {
        this.removeBall();

        const ball = document.createElement("div");
        ball.id = "immersive-translate-ball";
        ball.innerHTML = BALL_SVG;
        ball.addEventListener("click", this.onBallClick);
        this.makeDraggable(ball);

        const panel = document.createElement("div");
        panel.id = "immersive-translate-panel";
        panel.addClass("imt-kiss-panel");

        const title = document.createElement("div");
        title.className = "imt-kiss-panel-title";
        title.textContent = t("Settings.Immersive.PanelTitle");
        panel.appendChild(title);

        this.statusEl = document.createElement("div");
        this.statusEl.className = "imt-kiss-panel-status";
        panel.appendChild(this.statusEl);

        panel.appendChild(this.createPanelButton(t("Settings.Immersive.PanelTranslate"), () => void this.translateDocument(true)));
        panel.appendChild(this.createPanelButton(t("Settings.Immersive.PanelRestore"), () => this.restore()));

        ball.appendChild(panel);
        this.ball = ball;
        this.panel = panel;
        document.body.appendChild(ball);
    }

    /** 移除悬浮球与面板 */
    private removeBall(): void {
        if (this.ball && this.ball.parentNode) {
            this.ball.removeEventListener("click", this.onBallClick);
            this.clearDragListeners();
            this.ball.parentNode.removeChild(this.ball);
        }
        this.ball = null;
        this.panel = null;
        this.statusEl = null;
    }

    private onBallClick = (e: MouseEvent): void => {
        // 点击面板内部时不切换显隐
        if (e && this.panel && e.target instanceof Node && this.panel.contains(e.target)) return;
        if (!this.panel) return;
        const isOpen = this.panel.style.display === "flex";
        this.panel.style.display = isOpen ? "none" : "flex";
    };

    private createPanelButton(label: string, onClick: () => void): HTMLElement {
        const btn = document.createElement("div");
        btn.className = "imt-kiss-panel-btn";
        btn.textContent = label;
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            onClick();
        });
        return btn;
    }

    private updateStatus(message: string): void {
        if (this.statusEl) this.statusEl.textContent = message;
    }

    /** 监听动态内容（菜单、通知、弹窗），防抖后增量翻译 */
    private setupObserver(): void {
        this.observer = new MutationObserver(() => this.scheduleTranslation());
        this.observer.observe(document.body, { childList: true, subtree: true });
    }

    private scheduleTranslation(): void {
        if (!this.active) return;
        if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
        this.debounceTimer = window.setTimeout(() => {
            this.debounceTimer = null;
            void this.translateDocument();
        }, OBSERVER_DEBOUNCE_MS);
    }

    /** 应用 pageRule.injectedCss */
    private applyInjectedCss(): void {
        this.removeInjectedCss();
        const injectedCss = this.ctx?.settings.imtPagerule?.injectedCss;
        if (!injectedCss) return;
        const cssText = Array.isArray(injectedCss) ? injectedCss.join("\n") : injectedCss;
        if (!cssText?.trim()) return;

        const style = document.createElement("style");
        style.id = INJECTED_STYLE_ID;
        style.textContent = cssText;
        document.head.appendChild(style);
        this.injectedStyle = style;
    }

    private removeInjectedCss(): void {
        this.injectedStyle?.remove();
        document.getElementById(INJECTED_STYLE_ID)?.remove();
        this.injectedStyle = null;
    }

    /** 注入 kiss 译文样式表，并记录当前样式对应的类名 */
    private async applyKissTextStyles(): Promise<void> {
        try {
            const setting = (await getSettingWithDefault()) as any;
            const [textClass, textStyles] = genTextClass(setting.customStyles || []);
            this.kissTextClass = textClass;
            this.kissTextStyleSlug = setting.selectedTextStyle || "style_none";

            document.getElementById(KISS_TEXT_STYLE_ID)?.remove();
            const style = document.createElement("style");
            style.id = KISS_TEXT_STYLE_ID;
            style.textContent = textStyles;
            document.head.appendChild(style);
        } catch (error) {
            console.error("[i18n-kiss] apply kiss text styles failed:", error);
        }
    }

    private removeKissTextStyles(): void {
        document.getElementById(KISS_TEXT_STYLE_ID)?.remove();
        this.kissTextClass = null;
    }

    /**
     * 使悬浮球可垂直拖动（保持与原实现一致的行为）
     */
    private makeDraggable(element: HTMLElement): void {
        let isDragging = false;
        let startY = 0;
        let initialTop = 0;

        const onMouseDown = (e: MouseEvent) => {
            if (e.button !== 0 || e.target !== element) return;
            e.preventDefault();
            isDragging = true;
            startY = e.clientY;
            initialTop = element.getBoundingClientRect().top;
        };
        const onMouseMove = (e: MouseEvent) => {
            if (!isDragging) return;
            e.preventDefault();
            const viewportHeight = window.innerHeight;
            const elementHeight = element.offsetHeight;
            let newTop = initialTop + (e.clientY - startY);
            newTop = Math.max(0, Math.min(newTop, viewportHeight - elementHeight));
            element.style.top = `${newTop}px`;
            element.style.bottom = "auto";
            element.style.right = "0px";
        };
        const onMouseUp = () => {
            isDragging = false;
        };

        element.addEventListener("mousedown", onMouseDown);
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        this.dragCleanup = () => {
            element.removeEventListener("mousedown", onMouseDown);
            document.removeEventListener("mousemove", onMouseMove);
            document.removeEventListener("mouseup", onMouseUp);
        };
    }

    private dragCleanup: (() => void) | null = null;

    private clearDragListeners(): void {
        this.dragCleanup?.();
        this.dragCleanup = null;
    }
}
