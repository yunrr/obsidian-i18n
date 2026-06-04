import * as path from 'path';
import type I18N from 'src/main';

export type ApplyPluginTimingStage =
    | 'getCjsEndpoint'
    | 'applyPluginTranslation'
    | 'disablePlugin'
    | 'enablePlugin'
    | 'refreshParent';

export type ApplyPluginLogStage = 'flow' | ApplyPluginTimingStage;
export type ApplyPluginLogStatus = 'start' | 'success' | 'failure' | 'skipped';

export interface ApplyPluginStageTiming {
    stage: ApplyPluginTimingStage;
    durationMs: number;
}

export interface ApplyPluginLogEvent {
    stage: ApplyPluginLogStage;
    status: ApplyPluginLogStatus;
    message: string;
    durationMs?: number;
    error?: string;
}

interface ApplyPluginFlowMessages {
    genericError: string;
    noApplyTranslationKinds: string;
    reloadSuccessTitle: string;
    loadFailedAfterApply: string;
}

interface ApplyPluginFlowPlugin {
    id: string;
    name?: string;
    version: string;
}

interface ApplyPluginFlowOptions {
    plugin: ApplyPluginFlowPlugin;
    pluginDir: string;
    activeSourceId: string | null;
    isEnabled: boolean;
    translationVersion?: string;
    i18n: I18N;
    refreshParent: () => void | Promise<void>;
    messages: ApplyPluginFlowMessages;
    now?: () => number;
    warn?: (...args: any[]) => void;
    onLog?: (event: ApplyPluginLogEvent) => void;
}

export interface ApplyPluginFlowResult {
    applied: boolean;
    timings: ApplyPluginStageTiming[];
    error?: string;
}

export function getSlowestApplyPluginStage(timings: ApplyPluginStageTiming[]): ApplyPluginStageTiming | null {
    return timings.reduce<ApplyPluginStageTiming | null>((slowest, timing) => {
        if (!slowest || timing.durationMs > slowest.durationMs) return timing;
        return slowest;
    }, null);
}

const applyPluginStageLabels: Record<ApplyPluginLogStage, string> = {
    flow: '应用译文',
    getCjsEndpoint: '获取 CJS 后端',
    applyPluginTranslation: 'CJS 替换译文',
    disablePlugin: '禁用插件',
    enablePlugin: '启用插件',
    refreshParent: '刷新插件列表',
};

function formatApplyPluginDuration(durationMs?: number): string {
    if (typeof durationMs !== 'number') return '';
    if (durationMs < 1000) return `${durationMs}ms`;
    return `${(durationMs / 1000).toFixed(2)}s`;
}

function formatApplyPluginLogMessage(event: Omit<ApplyPluginLogEvent, 'message'>, pluginId: string): string {
    const label = applyPluginStageLabels[event.stage];
    if (event.status === 'start') {
        return event.stage === 'flow' ? `${label}开始：${pluginId}` : `${label}开始`;
    }
    const duration = formatApplyPluginDuration(event.durationMs);
    const durationText = duration ? `（${duration}）` : '';
    if (event.status === 'success') return `${label}完成${durationText}`;
    if (event.status === 'skipped') return `${label}跳过${durationText}`;
    return `${label}失败${durationText}${event.error ? `：${event.error}` : ''}`;
}

export async function runPluginApplyTranslationFlow(options: ApplyPluginFlowOptions): Promise<ApplyPluginFlowResult> {
    const {
        plugin,
        pluginDir,
        activeSourceId,
        isEnabled,
        translationVersion,
        i18n,
        refreshParent,
        messages,
        now = () => Date.now(),
        warn = console.warn,
        onLog,
    } = options;
    const timings: ApplyPluginStageTiming[] = [];
    const flowStartedAt = now();

    const emitLog = (event: Omit<ApplyPluginLogEvent, 'message'> & { message?: string }) => {
        if (!onLog) return;
        const logEvent: ApplyPluginLogEvent = {
            ...event,
            message: event.message || formatApplyPluginLogMessage(event, plugin.id),
        };
        try {
            onLog(logEvent);
        } catch (error) {
            warn('[i18n] Apply translation log handler failed:', error);
        }
    };

    const timeStage = async <T>(stage: ApplyPluginTimingStage, action: () => Promise<T> | T): Promise<T> => {
        const startedAt = now();
        emitLog({ stage, status: 'start' });
        try {
            const result = await action();
            const durationMs = Math.max(0, now() - startedAt);
            timings.push({ stage, durationMs });
            emitLog({ stage, status: 'success', durationMs });
            return result;
        } catch (error) {
            const durationMs = Math.max(0, now() - startedAt);
            const errorMessage = String(error);
            timings.push({ stage, durationMs });
            emitLog({ stage, status: 'failure', durationMs, error: errorMessage });
            throw error;
        }
    };

    try {
        emitLog({ stage: 'flow', status: 'start' });
        if (!activeSourceId) throw new Error(messages.genericError);
        const applyAst = i18n.settings.applyAstTranslations !== false;
        const applyRegex = i18n.settings.applyRegexTranslations !== false;
        if (!applyAst && !applyRegex) {
            i18n.notice.warning(messages.noApplyTranslationKinds);
            emitLog({
                stage: 'flow',
                status: 'skipped',
                durationMs: Math.max(0, now() - flowStartedAt),
                message: messages.noApplyTranslationKinds,
            });
            return { applied: false, timings };
        }

        // @ts-ignore Obsidian desktop adapters expose getBasePath at runtime.
        const backupBasePath = path.join(path.normalize(i18n.app.vault.adapter.getBasePath()), i18n.manifest.dir || '');
        const cjsEndpoint = await timeStage('getCjsEndpoint', () => i18n.companionWorkerManager.getCjsEndpoint());
        const result = await timeStage('applyPluginTranslation', () => i18n.companionWorkerManager.applyPluginTranslation({
            pluginId: plugin.id,
            pluginDir,
            backupBasePath,
            persistence: { basePath: i18n.sourceManager.getBasePath() },
            translationSourceId: activeSourceId,
            applyAst,
            applyRegex,
            cjsEndpoint,
        }));
        if (!result.state) throw new Error(result.error || messages.genericError);
        i18n.stateManager.setPluginState(plugin.id, {
            id: plugin.id,
            isApplied: true,
            pluginVersion: plugin.version,
            translationVersion: result.translationVersion || translationVersion || '0.0.0',
        });
        if (isEnabled) {
            try {
                // @ts-ignore Obsidian plugin internals are not typed here.
                if (i18n.app.plugins.enabledPlugins.has(plugin.id)) {
                    // @ts-ignore Obsidian plugin internals are not typed here.
                    await timeStage('disablePlugin', () => i18n.app.plugins.disablePlugin(plugin.id));
                }
                // @ts-ignore Obsidian plugin internals are not typed here.
                await timeStage('enablePlugin', () => i18n.app.plugins.enablePlugin(plugin.id));
                i18n.notice.successPrefix(messages.reloadSuccessTitle, plugin.id);
            } catch (error) {
                warn('[i18n] Plugin reload failed after apply:', error);
                i18n.notice.warning(`${messages.loadFailedAfterApply} ${String(error)}`);
            }
        }
        await timeStage('refreshParent', () => refreshParent());
        emitLog({
            stage: 'flow',
            status: 'success',
            durationMs: Math.max(0, now() - flowStartedAt),
        });
        return { applied: true, timings };
    } catch (error) {
        const message = String(error);
        emitLog({
            stage: 'flow',
            status: 'failure',
            durationMs: Math.max(0, now() - flowStartedAt),
            error: message,
        });
        i18n.notice.result(false, message);
        return { applied: false, timings, error: message };
    }
}
