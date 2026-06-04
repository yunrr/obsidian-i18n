export type RuntimePluginApi = {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
    getPlugin?: (id: string) => unknown;
    isPluginEnabled?: (id: string) => boolean;
    isPluginLoaded?: (id: string) => boolean;
    loadPlugin?: (id: string) => Promise<void>;
    unloadPlugin?: (id: string) => Promise<void>;
};

export type RuntimeCommandsApi = {
    commands?: Record<string, unknown>;
    removeCommand?: (id: string) => void;
};

export type PluginLoadState = {
    enabled: boolean;
    loaded: boolean;
};

export type PluginRestorePlan = {
    restoreLoaded: boolean;
    saveEnabledState: boolean;
    requireDisabledAfterStop: boolean;
};

export const PLUGIN_SWITCH_COOLDOWN_DEFAULT_MS = 3000;
export const PLUGIN_SWITCH_COOLDOWN_MIN_MS = 500;
export const PLUGIN_SWITCH_COOLDOWN_MAX_MS = 60000;
export const PLUGIN_LOAD_TIMEOUT_DEFAULT_MS = 15000;
export const PLUGIN_TIMEOUT_GRACE_DEFAULT_MS = 2000;
export const PLUGIN_TIMEOUT_GRACE_MIN_MS = 0;
export const PLUGIN_TIMEOUT_GRACE_MAX_MS = 60000;
export const PLUGIN_LOAD_TIMEOUT_MAX_MS = 15000;
export const PLUGIN_FORCE_UNLOAD_TIMEOUT_DEFAULT_MS = 1500;

export const normalizePluginSwitchCooldownMs = (value: unknown): number => {
    const numberValue = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN;
    if (!Number.isFinite(numberValue)) return PLUGIN_SWITCH_COOLDOWN_DEFAULT_MS;
    return Math.min(
        PLUGIN_SWITCH_COOLDOWN_MAX_MS,
        Math.max(PLUGIN_SWITCH_COOLDOWN_MIN_MS, Math.floor(numberValue)),
    );
};

export const normalizePluginTimeoutGraceMs = (value: unknown): number => {
    const numberValue = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN;
    if (!Number.isFinite(numberValue)) return PLUGIN_TIMEOUT_GRACE_DEFAULT_MS;
    return Math.min(
        PLUGIN_TIMEOUT_GRACE_MAX_MS,
        Math.max(PLUGIN_TIMEOUT_GRACE_MIN_MS, Math.floor(numberValue)),
    );
};

export const pluginSwitchTimeoutFromBaseline = (
    baselineMs: unknown,
    graceMs: unknown = PLUGIN_TIMEOUT_GRACE_DEFAULT_MS,
    fallbackMs = PLUGIN_LOAD_TIMEOUT_DEFAULT_MS,
): number => {
    const fallback = Math.max(1, Math.floor(fallbackMs));
    if (typeof baselineMs !== 'number' || !Number.isFinite(baselineMs) || baselineMs <= 0) {
        return fallback;
    }
    return Math.max(1, Math.ceil(baselineMs) + normalizePluginTimeoutGraceMs(graceMs));
};

export const pluginLoadTimeoutFromBaseline = (
    baselineLoadMs: unknown,
    graceMs: unknown = PLUGIN_TIMEOUT_GRACE_DEFAULT_MS,
): number => {
    if (typeof baselineLoadMs !== 'number' || !Number.isFinite(baselineLoadMs) || baselineLoadMs <= 0) {
        return PLUGIN_LOAD_TIMEOUT_DEFAULT_MS;
    }
    return pluginSwitchTimeoutFromBaseline(baselineLoadMs, graceMs, PLUGIN_LOAD_TIMEOUT_MAX_MS);
};

const readBooleanField = (record: unknown, field: string): boolean | null => {
    if (!record || typeof record !== 'object') return null;
    const value = (record as Record<string, unknown>)[field];
    return typeof value === 'boolean' ? value : null;
};

export const isPluginRecordLoaded = (record: unknown): boolean => {
    if (record === null || record === undefined) return false;
    if (typeof record === 'boolean') return record;

    const explicitLoaded =
        readBooleanField(record, '_loaded')
        ?? readBooleanField(record, 'loaded')
        ?? readBooleanField(record, 'isLoaded');
    if (explicitLoaded !== null) return explicitLoaded;

    return true;
};

const getRuntimePluginRecord = (pluginsApi: RuntimePluginApi, pluginId: string): unknown => {
    if (typeof pluginsApi.getPlugin === 'function') {
        try {
            return pluginsApi.getPlugin(pluginId);
        } catch (error) {
            console.warn('[i18n] app.plugins.getPlugin failed, falling back to plugin table:', error);
        }
    }
    return pluginsApi.plugins?.[pluginId] ?? null;
};

const setPluginRecordLoaded = (record: unknown, loaded: boolean) => {
    if (!record || typeof record !== 'object') return;
    const data = record as Record<string, unknown>;
    for (const key of ['_loaded', 'loaded', 'isLoaded']) {
        if (key in data || key === '_loaded') {
            try {
                data[key] = loaded;
            } catch {
                // Some Obsidian internals may expose read-only fields.
            }
        }
    }
};

const maybeCallPluginUnload = async (record: unknown) => {
    if (!record || typeof record !== 'object') return;
    const unload = (record as Record<string, unknown>).unload;
    if (typeof unload !== 'function') return;
    await Promise.resolve(unload.call(record));
};

const waitWithTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> => {
    let timer: any = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const removePluginCommands = (commandsApi: RuntimeCommandsApi | undefined, pluginId: string) => {
    const commands = commandsApi?.commands;
    if (!commands || typeof commands !== 'object') return;
    const prefix = `${pluginId}:`;
    for (const commandId of Object.keys(commands)) {
        if (!commandId.startsWith(prefix)) continue;
        try {
            if (typeof commandsApi.removeCommand === 'function') {
                commandsApi.removeCommand(commandId);
            } else {
                delete commands[commandId];
            }
        } catch {
            try {
                delete commands[commandId];
            } catch {
                // Best-effort cleanup for corrupted plugin shutdowns.
            }
        }
    }
};

const errorLikeToMessage = (value: unknown): string => {
    if (!value) return '';
    if (value instanceof Error) return value.message || value.name;
    if (typeof value === 'string') return value;
    if (typeof value !== 'object') return String(value);
    const record = value as Record<string, unknown>;
    for (const key of ['message', 'error', 'reason']) {
        const message = errorLikeToMessage(record[key]);
        if (message) return message;
    }
    return '';
};

const readPluginRecordFailureMessage = (record: unknown): string => {
    if (!record || typeof record !== 'object') return '';
    const data = record as Record<string, unknown>;
    for (const key of [
        'loadError',
        'loadFailure',
        'loadingError',
        'error',
        '_error',
        'lastError',
        'lastLoadError',
        'failure',
    ]) {
        const message = errorLikeToMessage(data[key]);
        if (message) return message;
    }
    return '';
};

const textMentionsPlugin = (text: string, pluginId: string, pluginName?: string): boolean => {
    const normalized = text.toLowerCase();
    const id = pluginId.trim().toLowerCase();
    const name = pluginName?.trim().toLowerCase() || '';
    return (!!id && normalized.includes(id)) || (!!name && normalized.includes(name));
};

const textLooksLikePluginFailure = (text: string): boolean => {
    const normalized = text.toLowerCase();
    return (
        normalized.includes('failed to load plugin')
        || normalized.includes('failed loading plugin')
        || normalized.includes('plugin failed')
        || normalized.includes('load plugin failed')
        || normalized.includes('启动失败')
        || normalized.includes('加载失败')
        || normalized.includes('无法加载插件')
        || normalized.includes('不能加载插件')
    );
};

export const getPluginFailureMessage = (
    pluginsApi: RuntimePluginApi,
    pluginId: string,
    noticeTexts: string[] = [],
    pluginName?: string,
): string => {
    const runtimeRecord = getRuntimePluginRecord(pluginsApi, pluginId);
    const recordMessage = readPluginRecordFailureMessage(runtimeRecord);
    if (recordMessage) return recordMessage;

    const tableMessage = readPluginRecordFailureMessage(pluginsApi.plugins?.[pluginId]);
    if (tableMessage) return tableMessage;

    for (const text of noticeTexts) {
        if (
            typeof text === 'string'
            && textLooksLikePluginFailure(text)
            && textMentionsPlugin(text, pluginId, pluginName)
        ) {
            return text;
        }
    }
    return '';
};

const isPluginRuntimeLoaded = (pluginsApi: RuntimePluginApi, pluginId: string): boolean => {
    if (typeof pluginsApi.isPluginLoaded === 'function') {
        try {
            return !!pluginsApi.isPluginLoaded(pluginId);
        } catch (error) {
            console.warn('[i18n] app.plugins.isPluginLoaded failed, falling back to plugin record:', error);
        }
    }
    return isPluginRecordLoaded(getRuntimePluginRecord(pluginsApi, pluginId));
};

const isPluginEnabled = (pluginsApi: RuntimePluginApi, pluginId: string): boolean => {
    if (typeof pluginsApi.isPluginEnabled === 'function') {
        try {
            return !!pluginsApi.isPluginEnabled(pluginId);
        } catch (error) {
            console.warn('[i18n] app.plugins.isPluginEnabled failed, falling back to enabledPlugins:', error);
        }
    }
    return !!pluginsApi.enabledPlugins?.has(pluginId);
};

export const getPluginLoadState = (pluginsApi: RuntimePluginApi, pluginId: string): PluginLoadState => ({
    enabled: isPluginEnabled(pluginsApi, pluginId),
    loaded: isPluginRuntimeLoaded(pluginsApi, pluginId),
});

export const getPluginRestorePlan = (state: PluginLoadState): PluginRestorePlan => ({
    restoreLoaded: state.loaded,
    saveEnabledState: state.enabled,
    requireDisabledAfterStop: false,
});

export const getRuntimeProbeSwitchError = (
    state: PluginLoadState,
    usedForcedUnload: boolean,
    forcedUnloadReason = '',
): string => {
    if (usedForcedUnload) {
        return forcedUnloadReason
            ? `插件无法正常关闭，已强制卸载：${forcedUnloadReason}`
            : '插件无法正常关闭，已强制卸载';
    }
    if (state.loaded) return '';
    return `插件启用后状态异常：enabled=${state.enabled}, loaded=${state.loaded}`;
};

export const forceUnloadPluginRuntime = async (
    pluginsApi: RuntimePluginApi,
    pluginId: string,
    options: { commandsApi?: RuntimeCommandsApi; timeoutMs?: number } = {},
): Promise<PluginLoadState> => {
    pluginsApi.enabledPlugins?.delete(pluginId);
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? PLUGIN_FORCE_UNLOAD_TIMEOUT_DEFAULT_MS));

    const initialRecord = getRuntimePluginRecord(pluginsApi, pluginId) ?? pluginsApi.plugins?.[pluginId];
    if (isPluginRecordLoaded(initialRecord)) {
        try {
            if (typeof pluginsApi.unloadPlugin === 'function') {
                await waitWithTimeout(
                    pluginsApi.unloadPlugin(pluginId),
                    timeoutMs,
                    `插件卸载超时：${pluginId}`,
                );
            }
        } catch (error) {
            console.warn(`[i18n] app.plugins.unloadPlugin failed for ${pluginId}, trying direct runtime unload:`, error);
        }
    }

    const currentRecord = getRuntimePluginRecord(pluginsApi, pluginId) ?? pluginsApi.plugins?.[pluginId] ?? initialRecord;
    if (isPluginRecordLoaded(currentRecord)) {
        try {
            await waitWithTimeout(
                maybeCallPluginUnload(currentRecord),
                timeoutMs,
                `插件实例卸载超时：${pluginId}`,
            );
        } catch (error) {
            console.warn(`[i18n] plugin.unload failed for ${pluginId}, forcing registry cleanup:`, error);
        }
    }

    setPluginRecordLoaded(currentRecord, false);
    setPluginRecordLoaded(initialRecord, false);
    removePluginCommands(options.commandsApi, pluginId);
    if (pluginsApi.plugins && pluginId in pluginsApi.plugins) {
        try {
            delete pluginsApi.plugins[pluginId];
        } catch {
            setPluginRecordLoaded(pluginsApi.plugins[pluginId], false);
        }
    }

    return getPluginLoadState(pluginsApi, pluginId);
};
