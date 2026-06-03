export type RuntimePluginApi = {
    plugins?: Record<string, unknown>;
    enabledPlugins?: Set<string>;
    getPlugin?: (id: string) => unknown;
    isPluginEnabled?: (id: string) => boolean;
    isPluginLoaded?: (id: string) => boolean;
    loadPlugin?: (id: string) => Promise<void>;
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
