import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root } from 'react-dom/client';

import I18N from "src/main";

import { Button, Tabs, TabsContent, TabsList, TabsTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Input, Label, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Card, Badge, ResizablePanelGroup, ResizablePanel, ResizableHandle, ScrollArea } from '~/shadcn';
import { Save, Loader2, Plus, Trash2, ChevronDown, Folder, File, Info, Calendar, Hash, ChevronRight } from 'lucide-react';
import { useRegexStore } from './store';

import { EditorProps, DiagnoseError, DiagnoseProgress } from './types';
import { RegexEditor, AstEditor } from '.';

import { useGlobalStoreInstance } from '~/utils/store/global';
import { mountReactView } from '~/utils/core/react';
import { StringPicker } from '~/utils/ui/string-picker';
import { mergeAstItems, mergeRegexItems } from '@/src/utils/translator/light';
import { getEffectiveExtractionSettings } from '@/src/utils/translator/config';

import { useTranslation } from 'react-i18next';
import { t as gt } from 'src/locales';

import { useAstTranslation } from './components/ast/use-ast-translation';
import { useRegexTranslation } from './components/regex/use-regex-translation';
import { MetadataCard } from './components/common/metadata-card';
import { AstSidebar } from './components/ast/ast-sidebar';
import { RegexSidebar } from './components/regex/regex-sidebar';
import { TemplateCard } from './components/common/template-card';
import { saveCurrentPluginEditorTranslation } from './save-current-translation';
import {
    getPluginFailureMessage,
    getPluginLoadState,
    getPluginRestorePlan,
    getRuntimeProbeSwitchError,
    normalizePluginSwitchCooldownMs,
    normalizePluginTimeoutGraceMs,
    PLUGIN_LOAD_TIMEOUT_DEFAULT_MS,
    pluginSwitchTimeoutFromBaseline,
    RuntimeCommandsApi,
    RuntimePluginApi,
} from './runtime-plugin-state';

// ====================================================================================================
// 子组件 & 辅助功能
// ====================================================================================================

const SaveButton: React.FC<{ onSave: () => void; isSaving: boolean }> = React.memo(({ onSave, isSaving }) => {
    const { t } = useTranslation();
    const astItems = useRegexStore.use.astItems();
    const regexItems = useRegexStore.use.regexItems();
    return (
        <Button
            variant="default"
            size="sm"
            onClick={onSave}
            disabled={isSaving}
            className="shadow-sm hover:shadow-md transition-all active:scale-95 bg-primary hover:bg-primary/90"
        >
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {t('Editor.Actions.Save')}
            <Badge variant="secondary" className="ml-2 bg-primary-foreground/20 text-primary-foreground border-none px-1 h-4">
                {astItems.length + regexItems.length}
            </Badge>
        </Button>
    );
});


/**
 * 自动保存管理器
 * 监听翻译项变化，在停止输入一定时间后触发保存
 */
const AutoSaveManager: React.FC<{ onSave: (silent?: boolean) => void, enabled: boolean }> = ({ onSave, enabled }) => {
    const astItems = useRegexStore.use.astItems();
    const regexItems = useRegexStore.use.regexItems();
    const timerRef = useRef<NodeJS.Timeout | null>(null);
    const firstRenderRef = useRef(true);

    useEffect(() => {
        // 第一次挂载时不触发
        if (firstRenderRef.current) {
            firstRenderRef.current = false;
            return;
        }

        if (!enabled) return;

        // 清除旧定时器
        if (timerRef.current) clearTimeout(timerRef.current);

        // 设置新定时器 (500ms 防抖)
        timerRef.current = setTimeout(() => {
            onSave(true); // 自动保存时静默，不弹出提示
        }, 500);

        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [astItems, regexItems, enabled, onSave]);

    return null;
};

type PluginApi = RuntimePluginApi & {
    manifests: Record<string, unknown>;
    plugins: Record<string, unknown>;
    enabledPlugins: Set<string>;
    disablePlugin(id: string): Promise<void>;
    enablePlugin(id: string): Promise<void>;
    loadPlugin?(id: string): Promise<void>;
    unloadPlugin?(id: string): Promise<void>;
    disablePluginAndSave?(id: string): Promise<void>;
    enablePluginAndSave?(id: string): Promise<void>;
};

class DiagnoseStoppedError extends Error {
    constructor() {
        super('运行前检查已停止');
        this.name = 'DiagnoseStoppedError';
    }
}

type PluginDiagnoseRuntime = {
    pluginId: string;
    basePath: string;
    pluginsApi: PluginApi;
    switchCooldownMs: number;
    sessionId?: string;
};

type RuntimeProbeRequest = {
    probeId: string;
    files: Array<{ file: string }>;
    label: string;
};

type PluginDiagnoseDraft = {
    dict: Record<string, unknown>;
    metadata?: unknown;
};

type EnablePluginProbeResult = {
    state: ReturnType<typeof getPluginLoadState>;
    loadDurationMs: number;
};

type RuntimeProbeResult = {
    success: boolean;
    error: string;
    terminalFailure?: boolean;
    loadDurationMs?: number;
    stopDurationMs?: number;
};

type DisablePluginProbeResult = {
    state: ReturnType<typeof getPluginLoadState>;
    durationMs: number;
    stopError: string;
};

const countTranslationDictItems = (dict: unknown): number => {
    if (!dict || typeof dict !== 'object') return 0;
    let count = 0;
    for (const fileDict of Object.values(dict as Record<string, unknown>)) {
        if (!fileDict || typeof fileDict !== 'object') continue;
        const data = fileDict as Record<string, unknown>;
        count += Array.isArray(data.ast) ? data.ast.length : 0;
        count += Array.isArray(data.regex) ? data.regex.length : 0;
    }
    return count;
};

const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
        reject(new DiagnoseStoppedError());
        return;
    }
    const timer = window.setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
    }, ms);
    const abort = () => {
        window.clearTimeout(timer);
        reject(new DiagnoseStoppedError());
    };
    signal?.addEventListener('abort', abort, { once: true });
});
const PLUGIN_POLL_INTERVAL_MS = 100;
const PLUGIN_STOP_TIMEOUT_MS = 10000;
const PLUGIN_LOAD_TIMEOUT_MS = PLUGIN_LOAD_TIMEOUT_DEFAULT_MS;

const getManifestName = (manifest: unknown): string => {
    if (!manifest || typeof manifest !== 'object') return '';
    const name = (manifest as Record<string, unknown>).name;
    return typeof name === 'string' ? name : '';
};

const readNoticeTexts = (): string[] => {
    if (typeof document === 'undefined') return [];
    const texts = new Set<string>();
    document.querySelectorAll('.notice, .notice-message').forEach((element) => {
        const text = element.textContent?.trim();
        if (text) texts.add(text);
    });
    return Array.from(texts);
};

const readNewNoticeTexts = (snapshot: Set<string>): string[] => (
    readNoticeTexts().filter(text => !snapshot.has(text))
);

const buildDiagnoseDraft = (
    currentFile: string,
    dictData: Record<string, any>,
    astItems: Array<Record<string, any>>,
    regexItems: Array<Record<string, any>>,
    metadata: unknown,
): PluginDiagnoseDraft => {
    const dict = { ...dictData };
    if (currentFile) {
        dict[currentFile] = {
            ast: astItems.map(item => ({
                type: item.type,
                name: item.name,
                source: item.source,
                target: item.target,
            })),
            regex: regexItems.map(item => ({
                source: item.source,
                target: item.target,
            })),
        };
    }
    return {
        dict,
        metadata: metadata && typeof metadata === 'object'
            ? { ...(metadata as Record<string, unknown>) }
            : metadata,
    };
};

const waitForPluginLoaded = async (
    pluginsApi: PluginApi,
    pluginId: string,
    options: {
        timeoutMs?: number;
        signal?: AbortSignal;
        noticeSnapshot?: Set<string>;
        pluginName?: string;
        ignoredRuntimeFailure?: string;
    } = {},
) => {
    const timeoutMs = options.timeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        throwIfDiagnoseStopped(options.signal);
        const state = getPluginLoadState(pluginsApi, pluginId);
        if (state.loaded) return state;
        const noticeFailure = getPluginFailureMessage(
            {} as RuntimePluginApi,
            pluginId,
            options.noticeSnapshot ? readNewNoticeTexts(options.noticeSnapshot) : [],
            options.pluginName,
        );
        if (noticeFailure) {
            throw new Error(noticeFailure);
        }
        const runtimeFailure = getPluginFailureMessage(pluginsApi, pluginId, [], options.pluginName);
        if (runtimeFailure && runtimeFailure !== options.ignoredRuntimeFailure) {
            throw new Error(runtimeFailure);
        }
        await wait(PLUGIN_POLL_INTERVAL_MS, options.signal);
    }
    return getPluginLoadState(pluginsApi, pluginId);
};

const waitForPluginStopped = async (
    pluginsApi: PluginApi,
    pluginId: string,
    requireDisabled = false,
    timeoutMs = PLUGIN_STOP_TIMEOUT_MS,
    signal?: AbortSignal,
) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        throwIfDiagnoseStopped(signal);
        const state = getPluginLoadState(pluginsApi, pluginId);
        if (!state.loaded && (!requireDisabled || !state.enabled)) return state;
        await wait(PLUGIN_POLL_INTERVAL_MS, signal);
    }
    return getPluginLoadState(pluginsApi, pluginId);
};

const withTimeout = async <T,>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
): Promise<T> => {
    let timer: number | null = null;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer !== null) window.clearTimeout(timer);
    }
};

const formatPluginErrors = (...items: Array<[string, unknown | null]>) => {
    const details = items
        .filter(([, error]) => !!error)
        .map(([label, error]) => `${label}：${String(error)}`);
    return details.length > 0 ? `，${details.join('；')}` : '';
};

const formatDiagnosticError = (error: unknown) => {
    if (error instanceof Error) return `${error.name}: ${error.message}`;
    return String(error);
};

const restorePluginAfterProbe = async (
    pluginsApi: PluginApi,
    pluginId: string,
    startedState: ReturnType<typeof getPluginLoadState>,
    switchCooldownMs: number,
    commandsApi?: RuntimeCommandsApi,
    timeoutGraceMs?: number,
    baselineLoadDurationMs?: number | null,
    baselineStopDurationMs?: number | null,
) => {
    const normalizedSwitchCooldownMs = normalizePluginSwitchCooldownMs(switchCooldownMs);
    const restorePlan = getPluginRestorePlan(startedState);
    const stopTimeoutMs = baselineStopDurationMs === null || baselineStopDurationMs === undefined
        ? PLUGIN_STOP_TIMEOUT_MS
        : pluginSwitchTimeoutFromBaseline(baselineStopDurationMs, timeoutGraceMs, PLUGIN_STOP_TIMEOUT_MS);
    const beforeRestoreState = getPluginLoadState(pluginsApi, pluginId);
    if (beforeRestoreState.loaded || beforeRestoreState.enabled) {
        await disablePluginForProbe(pluginsApi, pluginId, { commandsApi, timeoutMs: stopTimeoutMs });
        await wait(normalizedSwitchCooldownMs);
    }
    if (restorePlan.restoreLoaded) {
        await enablePluginForProbe(pluginsApi, pluginId, {
            save: restorePlan.saveEnabledState,
            requireLoaded: true,
            loadTimeoutMs: baselineLoadDurationMs === null || baselineLoadDurationMs === undefined
                ? PLUGIN_LOAD_TIMEOUT_MS
                : pluginSwitchTimeoutFromBaseline(baselineLoadDurationMs, timeoutGraceMs, PLUGIN_LOAD_TIMEOUT_MS),
        });
        await wait(normalizedSwitchCooldownMs);
    } else {
        const stoppedState = getPluginLoadState(pluginsApi, pluginId);
        if (stoppedState.loaded || stoppedState.enabled) {
            await disablePluginForProbe(pluginsApi, pluginId, { commandsApi, timeoutMs: stopTimeoutMs });
        }
    }
};

const disablePluginForProbe = async (
    pluginsApi: PluginApi,
    pluginId: string,
    options: {
        signal?: AbortSignal;
        timeoutMs?: number;
        commandsApi?: RuntimeCommandsApi;
    } = {},
): Promise<DisablePluginProbeResult> => {
    const startedAt = Date.now();
    throwIfDiagnoseStopped(options.signal);
    let state = getPluginLoadState(pluginsApi, pluginId);
    if (!state.loaded && !state.enabled) {
        return {
            state,
            durationMs: Date.now() - startedAt,
            stopError: '',
        };
    }

    let disableError: unknown = null;
    const timeoutMs = options.timeoutMs ?? PLUGIN_STOP_TIMEOUT_MS;
    try {
        await withTimeout(
            pluginsApi.disablePlugin(pluginId).then(() => waitForPluginStopped(
                pluginsApi,
                pluginId,
                false,
                timeoutMs,
                options.signal,
            )),
            timeoutMs,
            `插件关闭超时：${pluginId}`,
        );
    } catch (error) {
        if (error instanceof DiagnoseStoppedError) {
            throw error;
        }
        disableError = error;
        console.warn(`[i18n] app.plugins.disablePlugin failed or timed out for ${pluginId}:`, error);
    }

    state = getPluginLoadState(pluginsApi, pluginId);
    const stopError = disableError instanceof Error
        ? disableError.message
        : disableError
            ? String(disableError)
            : state.loaded || state.enabled
                ? `插件关闭后状态异常：enabled=${state.enabled}, loaded=${state.loaded}`
                : '';
    return {
        state,
        durationMs: Date.now() - startedAt,
        stopError,
    };
};

const enablePluginForProbe = async (
    pluginsApi: PluginApi,
    pluginId: string,
    options: {
        save?: boolean;
        requireLoaded?: boolean;
        signal?: AbortSignal;
        loadTimeoutMs?: number;
        pluginName?: string;
    } = {},
): Promise<EnablePluginProbeResult> => {
    let enableError: unknown = null;
    const noticeSnapshot = new Set(readNoticeTexts());
    const ignoredRuntimeFailure = getPluginFailureMessage(pluginsApi, pluginId, [], options.pluginName);
    const enableStartedAt = Date.now();
    try {
        if (options.save && pluginsApi.enablePluginAndSave) {
            await pluginsApi.enablePluginAndSave(pluginId);
        } else {
            await pluginsApi.enablePlugin(pluginId);
        }
    } catch (error) {
        enableError = error;
    }

    let state = options.requireLoaded
        ? await waitForPluginLoaded(pluginsApi, pluginId, {
            timeoutMs: options.loadTimeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS,
            signal: options.signal,
            noticeSnapshot,
            pluginName: options.pluginName,
            ignoredRuntimeFailure,
        })
        : getPluginLoadState(pluginsApi, pluginId);
    if (options.requireLoaded && !state.loaded) {
        const suffix = formatPluginErrors(
            [options.save ? 'enablePluginAndSave 错误' : 'enablePlugin 错误', enableError],
        );
        throw new Error(`插件启用后状态异常：enabled=${state.enabled}, loaded=${state.loaded}${suffix}`);
    }

    if (enableError) {
        console.warn('[i18n] Plugin enable API reported an error, but final state is acceptable:', enableError);
    }
    return {
        state,
        loadDurationMs: Date.now() - enableStartedAt,
    };
};

const throwIfDiagnoseStopped = (signal?: AbortSignal) => {
    if (signal?.aborted) {
        throw new DiagnoseStoppedError();
    }
};

// 组件
const ReactEditor: React.FC<EditorProps> = (_) => {
    const i18n = useGlobalStoreInstance.getState().i18n;
    const { t } = useTranslation();
    const logger = i18n.logger;
    const notice = i18n.notice;
    const loggerPrefix = t('Editor.Titles.Main');

    // 插件翻译文件
    const pluginTranslation = useGlobalStoreInstance.getState().editorPluginTranslation;

    // Lifted Translation State (Persists across tab switching)
    const astController = useAstTranslation();
    const regexController = useRegexTranslation();

    // 只获取 setter 函数（稳定引用），不订阅实际数据
    const setRegexItems = useRegexStore.use.setRegexItems();
    const setAstItems = useRegexStore.use.setAstItems();
    const setMetadata = useRegexStore.use.setMetadata();
    const setDictData = useRegexStore.use.setDictData();
    const setCurrentFile = useRegexStore.use.setCurrentFile();
    const addFile = useRegexStore.use.addFile();
    const deleteFile = useRegexStore.use.deleteFile();

    // 使用 ref 标记是否已初始化，防止 useEffect 重复执行时用原始数据覆盖用户编辑中的内容
    const initializedRef = useRef(false);
    const savingRef = useRef(false);
    const diagnoseAbortRef = useRef<AbortController | null>(null);
    const diagnoseRuntimeRef = useRef<PluginDiagnoseRuntime | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [isDiagnosing, setIsDiagnosing] = useState(false);
    const [isCleaningIssues, setIsCleaningIssues] = useState(false);
    const [errorItems, setErrorItems] = useState<DiagnoseError[]>([]);
    const [diagnoseProgress, setDiagnoseProgress] = useState<DiagnoseProgress | null>(null);
    const [hasChecked, setHasChecked] = useState(false);
    const [activeTab, setActiveTab] = useState('ast');
    const [isAddPathDialogOpen, setIsAddPathDialogOpen] = useState(false);
    const [newPathInput, setNewPathInput] = useState('');
    const [switchCooldownMs, setSwitchCooldownMs] = useState(() => (
        normalizePluginSwitchCooldownMs(i18n.settings.preflightPluginSwitchCooldownMs)
    ));
    const [timeoutGraceMs, setTimeoutGraceMs] = useState(() => (
        normalizePluginTimeoutGraceMs(i18n.settings.preflightPluginTimeoutGraceMs)
    ));

    const getExtractionSettings = React.useCallback(() => getEffectiveExtractionSettings(i18n.settings), [i18n.settings]);

    const handleSwitchCooldownChange = React.useCallback((value: number) => {
        const normalized = normalizePluginSwitchCooldownMs(value);
        setSwitchCooldownMs(normalized);
        i18n.settings.preflightPluginSwitchCooldownMs = normalized;
        void i18n.saveSettings();
        return normalized;
    }, [i18n]);

    const handleTimeoutGraceChange = React.useCallback((value: number) => {
        const normalized = normalizePluginTimeoutGraceMs(value);
        setTimeoutGraceMs(normalized);
        i18n.settings.preflightPluginTimeoutGraceMs = normalized;
        void i18n.saveSettings();
        return normalized;
    }, [i18n]);

    useEffect(() => {
        // 如果已经初始化过，不再用原始数据覆盖 store
        if (initializedRef.current) return;

        if (pluginTranslation?.dict) {
            useRegexStore.setState({ currentFile: '' });
            setDictData(pluginTranslation.dict);

            const initialFile = pluginTranslation.dict['main.js'] ? 'main.js' : Object.keys(pluginTranslation.dict)[0];
            if (initialFile) {
                setCurrentFile(initialFile);
            }
        }

        // Metadata 数据初始化
        if (pluginTranslation?.metadata) {
            setMetadata(pluginTranslation.metadata);
        }

        initializedRef.current = true;
    }, [pluginTranslation, setDictData, setCurrentFile, setMetadata, logger]);

    // =================================== Function ===================================
    const save = React.useCallback(async (silent = false) => {
        if (savingRef.current) return;
        savingRef.current = true;
        setIsSaving(true);
        try {
            const globalState = useGlobalStoreInstance.getState();
            const pluginTranslationPath = globalState.editorPluginTranslationPath;
            const i18n = globalState.i18n;
            const notice = i18n.notice;

            try {
                if (pluginTranslationPath) {
                    await saveCurrentPluginEditorTranslation();

                    if (!silent) {
                        notice.successPrefix(loggerPrefix, t("Common.Notices.SaveSuccess"));
                    }
                } else {
                    notice.errorPrefix(loggerPrefix, t("Common.Notices.SaveFailPath"));
                }
            } catch (e) {
                notice.errorPrefix(loggerPrefix, t("Common.Notices.SaveFail"), e);
            }
        } finally {
            savingRef.current = false;
            setIsSaving(false);
        }
    }, [loggerPrefix, t]);

    // ================================================== Incremental Extract ==================================================
    const incrementalExtractAst = React.useCallback(async () => {
        try {
            const { metadata } = useRegexStore.getState();
            if (!metadata) return;

            // 安全检查：如果已应用，禁止增量提取
            const isApplied = !!i18n.stateManager.getPluginState(metadata.plugin)?.isApplied;
            if (isApplied) {
                notice.error(t('Editor.Actions.IncrementalExtractDisabledTip'));
                return;
            }

            const pluginId = metadata.plugin;
            const currentFile = useRegexStore.getState().currentFile;
            // @ts-ignore
            const manifest = i18n.app.plugins.manifests[pluginId];
            if (!manifest) return;

            // @ts-ignore
            const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());
            const fileDoc = path.join(basePath, manifest.dir || '', currentFile);

            if (!fs.existsSync(fileDoc)) {
                notice.error(t('Common.Notices.MainNotFound').replace('main.js', currentFile) + ` (${currentFile})`);
                return;
            }

            const mainStr = fs.readFileSync(fileDoc).toString();
            const extracted = await i18n.companionWorkerManager.codeExtract({
                code: mainStr,
                settings: getExtractionSettings(),
            });
            const newAstItems = extracted.ast || [];
            const currentAstItems = useRegexStore.getState().astItems;

            const merged = mergeAstItems(currentAstItems, newAstItems as any);
            setAstItems(merged.map((item, index) => ({ ...item, id: index })));
            notice.success(t('Editor.Notices.SuccessIncrementalExtract'));
        } catch (e) {
            notice.error(t('Editor.Errors.SyntaxErrorAst') + ': ' + e);
        }
    }, [i18n, notice, t, setAstItems, getExtractionSettings]);

    const incrementalExtractRegex = React.useCallback(async () => {
        try {
            const { metadata } = useRegexStore.getState();
            if (!metadata) return;

            // 安全检查：如果已应用，禁止增量提取
            const isApplied = !!i18n.stateManager.getPluginState(metadata.plugin)?.isApplied;
            if (isApplied) {
                notice.error(t('Editor.Actions.IncrementalExtractDisabledTip'));
                return;
            }

            const pluginId = metadata.plugin;
            const currentFile = useRegexStore.getState().currentFile;
            // @ts-ignore
            const manifest = i18n.app.plugins.manifests[pluginId];
            if (!manifest) return;

            // @ts-ignore
            const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());
            const fileDoc = path.join(basePath, manifest.dir || '', currentFile);

            if (!fs.existsSync(fileDoc)) {
                notice.error(t('Common.Notices.MainNotFound', { file: currentFile }));
                return;
            }

            const mainStr = fs.readFileSync(fileDoc).toString();
            const extracted = await i18n.companionWorkerManager.codeExtract({
                code: mainStr,
                settings: getExtractionSettings(),
            });
            const newRegexItems = extracted.regex || [];
            const currentRegexItems = useRegexStore.getState().regexItems;

            // 合并新旧数据
            const merged = mergeRegexItems(currentRegexItems, newRegexItems);

            // 更新 store (重新分配 ID)
            setRegexItems(merged.map((item, index) => ({ ...item, id: index })));
            notice.success(t('Editor.Notices.SuccessIncrementalExtract'));
        } catch (e) {
            notice.error(t('Editor.Errors.SyntaxErrorRegex') + ': ' + e);
        }
    }, [i18n, notice, t, setRegexItems, getExtractionSettings]);

    // ================================================== Open File ==================================================
    const handleOpenFile = React.useCallback(async () => {
        try {
            const { metadata } = useRegexStore.getState();
            if (!metadata) return;

            const pluginId = metadata.plugin;
            const currentFile = useRegexStore.getState().currentFile;
            // @ts-ignore
            const manifest = i18n.app.plugins.manifests[pluginId];
            if (!manifest) return;

            // @ts-ignore
            const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());
            const fileDoc = path.join(basePath, manifest.dir || '', currentFile);

            if (!fs.existsSync(fileDoc)) {
                notice.error(t('Common.Notices.MainNotFound', { file: currentFile }));
                return;
            }

            const { i18nOpen } = await import('~/utils/common/general');
            i18nOpen(i18n, fileDoc);
        } catch (e) {
            notice.error(t('Editor.Actions.OpenFile') + ' ' + t('Common.Status.Failure') + ': ' + e);
        }
    }, [i18n, notice, t]);


    // ================================================== Diagnose ==================================================
    const handleStopDiagnose = React.useCallback(() => {
        const controller = diagnoseAbortRef.current;
        if (!isDiagnosing || !controller || controller.signal.aborted) return;
        controller.abort();
        notice.info(t('Editor.Notices.DiagnosisStopping'));
    }, [i18n, isDiagnosing, notice, t]);

    const handleDiagnose = React.useCallback(async () => {
        if (isDiagnosing) return;
        const abortController = new AbortController();
        diagnoseAbortRef.current = abortController;
        setIsDiagnosing(true);
        setErrorItems([]);
        setDiagnoseProgress(null);
        setHasChecked(true);
        let stopPluginForBackendWrite: ((useAbortSignal?: boolean) => Promise<void>) | null = null;
        let restoreAfterBackendChange: (() => Promise<void>) | null = null;
        try {
            const signal = abortController.signal;
            const { metadata } = useRegexStore.getState();
            if (!metadata) {
                notice.error(t('Editor.Errors.NoMetadata'));
                return;
            }

            const pluginId = metadata.plugin;
            // @ts-ignore
            const manifest = i18n.app.plugins.manifests[pluginId];
            if (!manifest) {
                notice.error(t('Editor.Errors.NoManifest'));
                return;
            }
            // @ts-ignore
            const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());
            const pluginDir = path.join(basePath, manifest.dir || '');
            const pluginTranslationPath = useGlobalStoreInstance.getState().editorPluginTranslationPath;
            const sourceIdFromPath = pluginTranslationPath
                ? path.basename(pluginTranslationPath, path.extname(pluginTranslationPath))
                : '';
            const activeSourceId = sourceIdFromPath || i18n.sourceManager.getActiveSourceId(pluginId);
            if (!activeSourceId) {
                notice.error(t('Editor.Errors.NoMetadata'));
                return;
            }
            const { currentFile, astItems, regexItems, dictData } = useRegexStore.getState();
            const draft = buildDiagnoseDraft(currentFile, dictData, astItems, regexItems, metadata);
            throwIfDiagnoseStopped(signal);

            const pluginsApi = i18n.app.plugins as PluginApi;
            const commandsApi = (i18n.app as any).commands as RuntimeCommandsApi | undefined;
            const normalizedSwitchCooldownMs = normalizePluginSwitchCooldownMs(switchCooldownMs);
            diagnoseRuntimeRef.current = {
                pluginId,
                basePath,
                pluginsApi,
                switchCooldownMs: normalizedSwitchCooldownMs,
            };
            const applyAst = i18n.settings.applyAstTranslations !== false;
            const applyRegex = i18n.settings.applyRegexTranslations !== false;
            const state = i18n.stateManager.getPluginState(pluginId);
            const isApplied = !!(state && state.isApplied);
            // @ts-ignore
            const backupBasePath = path.join(basePath, i18n.manifest.dir || '');
            const manifestName = getManifestName(manifest);
            let baselineLoadDurationMs: number | null = null;
            let baselineStopDurationMs: number | null = null;
            let notifiedRecovery = false;

            const startedState = getPluginLoadState(pluginsApi, pluginId);
            restoreAfterBackendChange = async () => {
                try {
                    await restorePluginAfterProbe(
                        pluginsApi,
                        pluginId,
                        startedState,
                        normalizedSwitchCooldownMs,
                        commandsApi,
                        timeoutGraceMs,
                        baselineLoadDurationMs,
                        baselineStopDurationMs,
                    );
                } catch (restoreError) {
                    console.error('[i18n] Failed to restore plugin state after diagnose probe:', restoreError);
                }
            };

            stopPluginForBackendWrite = async (useAbortSignal = true) => {
                const waitSignal = useAbortSignal ? signal : undefined;
                const state = getPluginLoadState(pluginsApi, pluginId);
                if (state.loaded || state.enabled) {
                    const stopped = await disablePluginForProbe(pluginsApi, pluginId, {
                        signal: waitSignal,
                        timeoutMs: baselineStopDurationMs === null
                            ? PLUGIN_STOP_TIMEOUT_MS
                            : pluginSwitchTimeoutFromBaseline(baselineStopDurationMs, timeoutGraceMs, PLUGIN_STOP_TIMEOUT_MS),
                        commandsApi,
                    });
                    if (stopped.stopError) {
                        throw new Error(stopped.stopError);
                    }
                    await wait(normalizedSwitchCooldownMs, waitSignal);
                }
            };

            const runProbe = async (probe: RuntimeProbeRequest): Promise<RuntimeProbeResult> => {
                try {
                    throwIfDiagnoseStopped(signal);
                    const loadTimeoutMs = baselineLoadDurationMs === null
                        ? PLUGIN_LOAD_TIMEOUT_MS
                        : pluginSwitchTimeoutFromBaseline(baselineLoadDurationMs, timeoutGraceMs, PLUGIN_LOAD_TIMEOUT_MS);
                    const enabled = await enablePluginForProbe(pluginsApi, pluginId, {
                        requireLoaded: true,
                        signal,
                        loadTimeoutMs,
                        pluginName: manifestName,
                    });
                    if (probe.label === '原始运行验证' && enabled.state.loaded) {
                        baselineLoadDurationMs = enabled.loadDurationMs;
                    }
                    await wait(normalizedSwitchCooldownMs, signal);
                    const loadState = getPluginLoadState(pluginsApi, pluginId);
                    const stopTimeoutMs = baselineStopDurationMs === null
                        ? PLUGIN_STOP_TIMEOUT_MS
                        : pluginSwitchTimeoutFromBaseline(baselineStopDurationMs, timeoutGraceMs, PLUGIN_STOP_TIMEOUT_MS);
                    const stopped = await disablePluginForProbe(pluginsApi, pluginId, {
                        signal,
                        timeoutMs: stopTimeoutMs,
                        commandsApi,
                    });
                    if (probe.label === '原始运行验证') {
                        baselineStopDurationMs = stopped.durationMs;
                    }
                    const switchError = stopped.stopError || getRuntimeProbeSwitchError(loadState, false);
                    await wait(normalizedSwitchCooldownMs, signal);
                    return {
                        success: !switchError,
                        error: switchError,
                        terminalFailure: !!stopped.stopError,
                        loadDurationMs: enabled.loadDurationMs,
                        stopDurationMs: stopped.durationMs,
                    };
                } catch (error) {
                    if (error instanceof DiagnoseStoppedError) {
                        throw error;
                    }
                    return {
                        success: false,
                        error: formatDiagnosticError(error),
                    };
                }
            };

            const notifyRecoveredReplacements = (restoredFiles: unknown, restoredEntries: unknown) => {
                const fileCount = typeof restoredFiles === 'number' ? restoredFiles : 0;
                const entryCount = typeof restoredEntries === 'number' ? restoredEntries : 0;
                if (notifiedRecovery || (fileCount <= 0 && entryCount <= 0)) return;
                notifiedRecovery = true;
                notice.info(`已自动恢复上次运行前检查遗留的替换文件（${fileCount} 个文件）`);
            };

            const recovery = await i18n.companionWorkerManager.restorePluginDiagnoseRecovery({
                pluginId,
                pluginDir,
                persistence: { basePath: i18n.sourceManager.getBasePath() },
            });
            notifyRecoveredReplacements(recovery.restoredFiles, recovery.restoredEntries);
            throwIfDiagnoseStopped(signal);

            await stopPluginForBackendWrite();
            const cjsEndpoint = await i18n.companionWorkerManager.getCjsEndpoint();
            throwIfDiagnoseStopped(signal);
            let response = await i18n.companionWorkerManager.startPluginDiagnoseCleanup({
                pluginId,
                pluginDir,
                backupBasePath,
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                translationSourceId: activeSourceId,
                draft,
                cjsEndpoint,
                applyAst,
                applyRegex,
                runtimeProbe: true,
                isApplied,
            });
            notifyRecoveredReplacements(response.recoveredFiles, response.recoveredEntries);
            throwIfDiagnoseStopped(signal);
            i18n.sourceManager.reloadFromDisk();
            useGlobalStoreInstance.setState({
                editorPluginTranslation: {
                    ...pluginTranslation,
                    dict: draft.dict as any,
                    metadata: draft.metadata as any,
                },
            });
            if (response.sessionId && diagnoseRuntimeRef.current) {
                diagnoseRuntimeRef.current.sessionId = response.sessionId;
            }
            setDiagnoseProgress(response.progress || null);

            while (response.status === 'probe' && response.sessionId && response.probe) {
                throwIfDiagnoseStopped(signal);
                if (diagnoseRuntimeRef.current) {
                    diagnoseRuntimeRef.current.sessionId = response.sessionId;
                }
                const probeResult = await runProbe(response.probe);
                throwIfDiagnoseStopped(signal);
                response = await i18n.companionWorkerManager.stepPluginDiagnoseCleanup({
                    sessionId: response.sessionId,
                    probeId: response.probe.probeId,
                    success: probeResult.success,
                    error: probeResult.error,
                    terminalFailure: probeResult.terminalFailure,
                });
                throwIfDiagnoseStopped(signal);
                if (response.sessionId && diagnoseRuntimeRef.current) {
                    diagnoseRuntimeRef.current.sessionId = response.sessionId;
                }
                if (response.status === 'probe') {
                    await stopPluginForBackendWrite();
                }
                setDiagnoseProgress(response.progress || null);
            }
            await restoreAfterBackendChange();

            const results: DiagnoseError[] = (response.issueItems || []).map((item) => ({
                type: item.kind,
                id: item.index,
                file: item.file,
                source: item.source,
                target: item.target,
                message: item.reason,
            }));
            setErrorItems(results);
            if (response.status === 'baselineFailed') {
                notice.warning(t('Editor.Notices.DiagnosisRuntimeBaselineFailed'));
                if (results.length > 0) {
                    notice.error(t('Editor.Notices.DiagnosisIssuesFound', { count: results.length }));
                }
            } else if (results.length === 0) {
                notice.success(t('Editor.Notices.DiagnosisSuccess'));
            } else {
                notice.error(t('Editor.Notices.DiagnosisIssuesFound', { count: results.length }));
            }
        } catch (e) {
            if (e instanceof DiagnoseStoppedError) {
                const sessionId = diagnoseRuntimeRef.current?.sessionId;
                if (sessionId) {
                    try {
                        await i18n.companionWorkerManager.cancelPluginDiagnoseCleanup({ sessionId });
                        await stopPluginForBackendWrite?.(false);
                        await restoreAfterBackendChange?.();
                    } catch (cancelError) {
                        console.error('[i18n] Failed to cancel plugin diagnose cleanup:', cancelError);
                    }
                } else {
                    await restoreAfterBackendChange?.();
                }
                setHasChecked(false);
                setDiagnoseProgress(null);
                notice.info(t('Editor.Notices.DiagnosisStopped'));
            } else {
                const sessionId = diagnoseRuntimeRef.current?.sessionId;
                if (sessionId) {
                    try {
                        await i18n.companionWorkerManager.cancelPluginDiagnoseCleanup({ sessionId });
                        await stopPluginForBackendWrite?.(false);
                        await restoreAfterBackendChange?.();
                    } catch (cleanupError) {
                        console.error('[i18n] Failed to cleanup plugin diagnose after error:', cleanupError);
                    }
                } else {
                    await restoreAfterBackendChange?.();
                }
                notice.error(t('Common.Status.Failure') + ' ' + t('Editor.Notices.DiagnosisFailed') + ': ' + e);
            }
        } finally {
            if (diagnoseAbortRef.current === abortController) {
                diagnoseAbortRef.current = null;
            }
            diagnoseRuntimeRef.current = null;
            setDiagnoseProgress(null);
            setIsDiagnosing(false);
        }
    }, [i18n, notice, t, isDiagnosing, save, setDictData, setCurrentFile, switchCooldownMs, timeoutGraceMs]);

    const handleJumpError = React.useCallback((error: DiagnoseError) => {
        if (error.file) {
            setCurrentFile(error.file);
        }
        setActiveTab(error.type);
        // 通过 CustomEvent 触发表格滚动定位 (由子组件监听)
        window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('i18n-jump-error', {
                detail: { type: error.type, id: error.id }
            }));
        }, 50);
    }, [setCurrentFile]);

    const handleCleanDiagnoseIssues = React.useCallback(async () => {
        if (isCleaningIssues || errorItems.length === 0) return;
        setIsCleaningIssues(true);
        try {
            const { metadata } = useRegexStore.getState();
            const pluginId = metadata?.plugin;
            const pluginTranslationPath = useGlobalStoreInstance.getState().editorPluginTranslationPath;
            const sourceIdFromPath = pluginTranslationPath
                ? path.basename(pluginTranslationPath, path.extname(pluginTranslationPath))
                : '';
            const activeSourceId = sourceIdFromPath || (pluginId ? i18n.sourceManager.getActiveSourceId(pluginId) : '');
            if (!pluginId || !activeSourceId) {
                notice.error(t('Editor.Errors.NoMetadata'));
                return;
            }

            const response = await i18n.companionWorkerManager.applyPluginDiagnoseCleanup({
                pluginId,
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                translationSourceId: activeSourceId,
                issues: errorItems.map((item) => ({
                    file: item.file,
                    kind: item.type,
                    index: item.id,
                    source: item.source,
                    target: item.target,
                    reason: item.message || '',
                })),
            });

            i18n.sourceManager.reloadFromDisk();
            const cleaned = i18n.sourceManager.readSourceFile(activeSourceId);
            if (cleaned?.dict) {
                useGlobalStoreInstance.setState({ editorPluginTranslation: cleaned });
                useRegexStore.setState({ currentFile: '' });
                setDictData(cleaned.dict);
                const nextFile = cleaned.dict['main.js'] ? 'main.js' : Object.keys(cleaned.dict)[0] || '';
                if (nextFile) setCurrentFile(nextFile);
            }
            setErrorItems([]);
            setHasChecked(false);
            notice.success(t('Editor.Notices.DiagnosisCleanupApplied', { count: response.removedCount }));
        } catch (e) {
            notice.error(t('Common.Status.Failure') + ': ' + e);
        } finally {
            setIsCleaningIssues(false);
        }
    }, [i18n, notice, t, errorItems, isCleaningIssues, setDictData, setCurrentFile]);

    // 快捷键: Ctrl + S 保存
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S' || e.code === 'KeyS')) {
                e.preventDefault();
                e.stopPropagation();
                save();
            }
        };

        window.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.removeEventListener('keydown', handleKeyDown, true);
        };
    }, [save]);

    // 广播诊断错误到表格组件，用于行高亮
    useEffect(() => {
        window.dispatchEvent(new CustomEvent('i18n-diagnose-errors', {
            detail: { errors: errorItems }
        }));
    }, [errorItems]);

    const metadata = useRegexStore.use.metadata();
    const dictData = useRegexStore.use.dictData();
    const currentFile = useRegexStore.use.currentFile();
    const astItems = useRegexStore.use.astItems();
    const fileOptions = Object.keys(dictData || {});

    // 获取当前插件的翻译应用状态 (isApplied)
    const isApplied = React.useMemo(() => {
        if (!metadata?.plugin || !i18n?.stateManager) return false;
        return !!i18n.stateManager.getPluginState(metadata.plugin)?.isApplied;
    }, [metadata?.plugin, i18n?.stateManager, isSaving]); // isSaving 变化时重新计算作为一种同步触发源

    const handleAddFile = () => {
        if (newPathInput.trim()) {
            addFile(newPathInput.trim());
            setNewPathInput('');
            setIsAddPathDialogOpen(false);
        }
    };

    const switchFile = (file: string) => {
        if (file === currentFile) return;
        // 直接切换，setCurrentFile 内部现在会原子化处理进度保存和新数据加载
        setCurrentFile(file);
    };

    // ================================================== Render ================================================== 
    return (
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col gap-0 bg-background/50 backdrop-blur-md">
            <AutoSaveManager key={currentFile} onSave={save} enabled={!!i18n.settings.autoSave} />
            <ResizablePanelGroup direction="horizontal" className="h-full border-none">
                {/* 左侧资源管理侧边栏 */}
                <ResizablePanel defaultSize={20} minSize={10} maxSize={30} className="h-full">
                    <div className="flex flex-col h-full py-2 pl-2 pr-1">
                        <div className="flex flex-col h-full flex-1 min-h-0 rounded-lg border">
                            {/* 固定标题栏 */}
                            <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0 min-h-[36px]">
                                <Folder className="w-4 h-4 text-primary shrink-0" />
                                <span className="text-sm font-semibold truncate">{metadata?.plugin || t('Manager.Plugins.TabName')}</span>
                            </div>
                            <div className="flex flex-col w-full flex-1 min-h-0 p-2">
                                {/* 可滚动的卡片区域 */}
                                <ScrollArea className="flex-1 min-h-0 pr-3 -mr-3">
                                    <div className="space-y-3 pb-2">
                                        {/* 编辑器切换 & 保存卡片 */}
                                        <TemplateCard title={t('Editor.Titles.Main')} icon={Folder}>
                                            <div className="flex flex-col gap-3">
                                                <SaveButton onSave={save} isSaving={isSaving} />
                                                <TabsList className="w-full h-9 p-1.5 bg-muted/50 grid grid-cols-2">
                                                    <TabsTrigger className="text-xs data-[state=active]:shadow-sm" value="ast">AST</TabsTrigger>
                                                    <TabsTrigger className="text-xs data-[state=active]:shadow-sm" value="regex">Regex</TabsTrigger>
                                                </TabsList>
                                                <Badge variant="outline" className="w-full justify-center bg-background/50 border-primary/20 text-primary font-normal truncate text-xs h-8">
                                                    {currentFile}
                                                </Badge>
                                            </div>
                                        </TemplateCard>

                                        {/* 文件列表卡片 */}
                                        <TemplateCard
                                            title={t('Editor.Titles.Files')}
                                            icon={File}
                                            extra={
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-8 w-8 hover:bg-primary/10 text-primary"
                                                    onClick={() => setIsAddPathDialogOpen(true)}
                                                >
                                                    <Plus className="w-3.5 h-3.5" />
                                                </Button>
                                            }
                                        >
                                            <div className="flex flex-col gap-0.5">
                                                {fileOptions.map(file => (
                                                    <div
                                                        key={file}
                                                        className={`
                                                            group flex items-center justify-between px-2 h-8 rounded-md cursor-pointer transition-all text-sm
                                                            ${currentFile === file ? 'bg-primary text-primary-foreground shadow-sm' : 'hover:bg-primary/5 text-muted-foreground hover:text-foreground'}
                                                        `}
                                                        onClick={() => switchFile(file)}
                                                    >
                                                        <div className="flex items-center flex-1 min-w-0">
                                                            {currentFile === file ? <ChevronRight className="w-3.5 h-3.5 mr-1 flex-shrink-0 animate-in fade-in slide-in-from-left-2" /> : <div className="w-3.5 h-3.5 mr-1" />}
                                                            <span className="truncate">{file}</span>
                                                        </div>
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className={`
                                                                h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity rounded-full
                                                                ${currentFile === file ? 'hover:bg-primary-foreground/20 text-primary-foreground' : 'text-destructive hover:bg-destructive/10'}
                                                            `}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (confirm(t('Editor.Dialogs.ConfirmDeletePath'))) {
                                                                    deleteFile(file);
                                                                    // 清理对应的诊断状态，防止旧数据的错误干扰新文件的编辑
                                                                    setErrorItems([]);
                                                                    setHasChecked(false);
                                                                }
                                                            }}
                                                        >
                                                            <Trash2 className="w-3 h-3" />
                                                        </Button>
                                                    </div>
                                                ))}
                                            </div>
                                        </TemplateCard>

                                        {/* 元数据卡片区 */}
                                        <MetadataCard />
                                    </div>
                                </ScrollArea>
                            </div>
                        </div>
                    </div>
                </ResizablePanel>

                <ResizableHandle withHandle />

                {/* 中间：主内容编辑器区 */}
                <ResizablePanel defaultSize={60} minSize={30} className="h-full">
                    <main className="w-full h-full flex flex-col px-1 overflow-hidden bg-background/20">
                        <div className="flex-1 min-h-0 overflow-hidden relative">
                            <TabsContent value="ast" className="h-full m-0 overflow-hidden outline-none data-[state=active]:animate-in fade-in duration-300">
                                <div className="h-full overflow-auto p-2 pt-0">
                                    <AstEditor />
                                </div>
                            </TabsContent>
                            <TabsContent value="regex" className="h-full m-0 overflow-hidden outline-none data-[state=active]:animate-in fade-in duration-300">
                                <div className="h-full overflow-auto p-2 pt-0">
                                    <RegexEditor />
                                </div>
                            </TabsContent>
                        </div>
                    </main>
                </ResizablePanel>

                <ResizableHandle withHandle />

                {/* 右侧：操作面板侧边栏 */}
                <ResizablePanel defaultSize={20} minSize={10} maxSize={30} className="h-full">
                    <div className="flex flex-col h-full py-2 pr-2 pl-1">
                        <div className="flex flex-col h-full flex-1 min-h-0 rounded-lg border">
                            <TabsContent value="ast" className="flex-1 min-h-0 m-0 overflow-hidden outline-none">
                                <AstSidebar
                                    astController={astController}
                                    onIncrementalExtract={incrementalExtractAst}
                                    translationEntries={astItems as any}
                                    onOpenFile={handleOpenFile}
                                    onDiagnose={handleDiagnose}
                                    onStopDiagnose={handleStopDiagnose}
                                    isDiagnosing={isDiagnosing}
                                    errorItems={errorItems}
                                    hasChecked={hasChecked}
                                    setActiveTab={setActiveTab}
                                    isApplied={isApplied}
                                    onJumpError={handleJumpError}
                                    onCleanIssues={handleCleanDiagnoseIssues}
                                    isCleaningIssues={isCleaningIssues}
                                    diagnoseProgress={diagnoseProgress}
                                    switchCooldownMs={switchCooldownMs}
                                    onSwitchCooldownChange={handleSwitchCooldownChange}
                                    timeoutGraceMs={timeoutGraceMs}
                                    onTimeoutGraceChange={handleTimeoutGraceChange}
                                />
                            </TabsContent>
                            <TabsContent value="regex" className="flex-1 min-h-0 m-0 overflow-hidden outline-none">
                                <RegexSidebar
                                    regexController={regexController}
                                    onIncrementalExtract={incrementalExtractRegex}
                                    onOpenFile={handleOpenFile}
                                    onDiagnose={handleDiagnose}
                                    onStopDiagnose={handleStopDiagnose}
                                    isDiagnosing={isDiagnosing}
                                    errorItems={errorItems}
                                    hasChecked={hasChecked}
                                    setActiveTab={setActiveTab}
                                    isApplied={isApplied}
                                    onJumpError={handleJumpError}
                                    onCleanIssues={handleCleanDiagnoseIssues}
                                    isCleaningIssues={isCleaningIssues}
                                    diagnoseProgress={diagnoseProgress}
                                    switchCooldownMs={switchCooldownMs}
                                    onSwitchCooldownChange={handleSwitchCooldownChange}
                                    timeoutGraceMs={timeoutGraceMs}
                                    onTimeoutGraceChange={handleTimeoutGraceChange}
                                />
                            </TabsContent>
                        </div>
                    </div>
                </ResizablePanel>
            </ResizablePanelGroup>

            <Dialog open={isAddPathDialogOpen} onOpenChange={setIsAddPathDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>{t('Editor.Dialogs.PromptNewPath')}</DialogTitle>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="path" className="text-right">
                                {t('Editor.Labels.PathLabel')}
                            </Label>
                            <Input
                                id="path"
                                value={newPathInput}
                                onChange={(e) => setNewPathInput(e.target.value)}
                                placeholder={t('Editor.Labels.PathPlaceholder')}
                                className="col-span-3"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        handleAddFile();
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddPathDialogOpen(false)}>{t('Common.Actions.Cancel')}</Button>
                        <Button onClick={handleAddFile}>{t('Common.Actions.Confirm')}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </Tabs>
    );
};


export const EDITOR_VIEW_TYPE = 'editor-view-type';

export class EditorView extends ItemView {
    root: Root | null = null;
    i18n: I18N;
    shadowRoot: ShadowRoot | null = null;
    leftCollapsed: boolean = false;
    rightCollapsed: boolean = false;

    constructor(leaf: WorkspaceLeaf, i18n: I18N) {
        super(leaf);
        this.i18n = i18n;
    }

    getViewType() {
        return EDITOR_VIEW_TYPE;
    }

    getDisplayText() {
        return gt('Editor.Titles.Main');
    }

    getIcon() {
        return "pencil";
    }

    async onOpen() {
        // 保存当前侧边栏状态
        // @ts-ignore
        this.leftCollapsed = this.app.workspace.leftSplit.collapsed;
        // @ts-ignore
        this.rightCollapsed = this.app.workspace.rightSplit.collapsed;

        // 自动折叠侧边栏
        // @ts-ignore
        this.app.workspace.leftSplit.collapse();
        // @ts-ignore
        this.app.workspace.rightSplit.collapse();

        const { root, shadowRoot } = mountReactView(
            this.contentEl,
            this.i18n,
            React.createElement(ReactEditor)
        );
        this.root = root;
        this.shadowRoot = shadowRoot;
    }

    async onClose() {
        // 恢复侧边栏状态
        if (!this.leftCollapsed) {
            // @ts-ignore
            this.app.workspace.leftSplit.expand();
        }
        if (!this.rightCollapsed) {
            // @ts-ignore
            this.app.workspace.rightSplit.expand();
        }

        this.root?.unmount();
        this.shadowRoot?.empty();
    }
}
