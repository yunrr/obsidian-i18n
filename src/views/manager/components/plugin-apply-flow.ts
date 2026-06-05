import * as path from 'path';
import type I18N from 'src/main';

export type ApplyPluginTimingStage =
    | 'applyPluginTranslation'
    | 'disablePlugin'
    | 'enablePlugin'
    | 'refreshParent';

export interface ApplyPluginStageTiming {
    stage: ApplyPluginTimingStage;
    durationMs: number;
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
    } = options;
    const timings: ApplyPluginStageTiming[] = [];

    const timeStage = async <T>(stage: ApplyPluginTimingStage, action: () => Promise<T> | T): Promise<T> => {
        const startedAt = now();
        try {
            const result = await action();
            const durationMs = Math.max(0, now() - startedAt);
            timings.push({ stage, durationMs });
            return result;
        } catch (error) {
            const durationMs = Math.max(0, now() - startedAt);
            timings.push({ stage, durationMs });
            throw error;
        }
    };

    try {
        if (!activeSourceId) throw new Error(messages.genericError);
        const applyAst = i18n.settings.applyAstTranslations !== false;
        const applyRegex = i18n.settings.applyRegexTranslations !== false;
        if (!applyAst && !applyRegex) {
            i18n.notice.warning(messages.noApplyTranslationKinds);
            return { applied: false, timings };
        }

        // @ts-ignore Obsidian desktop adapters expose getBasePath at runtime.
        const backupBasePath = path.join(path.normalize(i18n.app.vault.adapter.getBasePath()), i18n.manifest.dir || '');
        const result = await timeStage('applyPluginTranslation', () => i18n.companionWorkerManager.applyPluginTranslation({
            pluginId: plugin.id,
            pluginDir,
            backupBasePath,
            persistence: { basePath: i18n.sourceManager.getBasePath() },
            translationSourceId: activeSourceId,
            applyAst,
            applyRegex,
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
        return { applied: true, timings };
    } catch (error) {
        const message = String(error);
        i18n.notice.result(false, message);
        return { applied: false, timings, error: message };
    }
}
