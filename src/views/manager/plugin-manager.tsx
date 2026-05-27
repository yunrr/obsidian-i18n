import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { PluginManifest, Notice } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs-extra';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, LayoutGrid, List, FileOutput, Languages, Loader2, RotateCcw, Square } from 'lucide-react';

import I18N from 'src/main';
import { PluginTranslationV1, BatchTaskFailureRecord } from 'src/types';
import { formatTimestamp, isValidPluginTranslationV1Format, calculateChecksum, generatePlugin, getPluginTranslationSources, hasChineseText, hasExtractedTranslationContent } from '../../utils';
import { loadTranslationFile } from '../../manager/io-manager';
import { useGlobalStoreInstance } from '~/utils';
import { createTranslationProvider } from '~/ai/provider-factory';
import type { AstItem, RegexItem } from '../plugin_editor/types';

import {
    Button,
    Input,
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
    ScrollArea,
    Progress,
} from '~/shadcn';
import { cn } from '~/shadcn/lib/utils';

interface PluginManagerProps {
    i18n: I18N;
    close: () => void;
}

import { PluginItem, PluginItemData } from './components/plugin-item';

type BatchMode = 'extract' | 'translate' | null;

interface BatchTaskState {
    mode: BatchMode;
    isRunning: boolean;
    currentLabel: string;
    processedResources: number;
    totalResources: number;
    processedItems: number;
    totalItems: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
}

interface PluginBatchResource {
    resourceId: string;
    label: string;
    sourceId?: string | null;
}

const PLUGIN_EXTRACT_CHECKPOINT_KEY = 'plugin:extract';
const PLUGIN_TRANSLATE_CHECKPOINT_KEY = 'plugin:translate';
const BATCH_PROGRESS_UPDATE_INTERVAL = 200;
const BATCH_PERSIST_INTERVAL = 1500;

const EMPTY_BATCH_TASK_STATE: BatchTaskState = {
    mode: null,
    isRunning: false,
    currentLabel: '',
    processedResources: 0,
    totalResources: 0,
    processedItems: 0,
    totalItems: 0,
    successCount: 0,
    failedCount: 0,
    skippedCount: 0,
};

const shouldTranslateText = (target?: string, source?: string) => !target || target.trim() === '' || target === source;
const yieldToMainThread = () => new Promise<void>(resolve => window.setTimeout(resolve, 0));
const getPositiveInt = (value: unknown, fallback: number) => {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};

const runConcurrentTasks = async <T,>(
    items: T[],
    limit: number,
    shouldStop: () => boolean,
    worker: (item: T, index: number) => Promise<void>
) => {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (!shouldStop()) {
            const index = nextIndex++;
            if (index >= items.length) return;
            await worker(items[index], index);
            await yieldToMainThread();
        }
    });
    await Promise.all(workers);
};

export const PluginManager: React.FC<PluginManagerProps> = ({ i18n, close }) => {
    const { t } = useTranslation();
    const app = i18n.app;
    const settings = i18n.settings;

    const [searchTerm, setSearchTerm] = useState(settings.searchText);
    const [sortType, setSortType] = useState(settings.sort);
    const [viewMode, setViewModeState] = useState<'list' | 'grid'>(settings.pluginViewMode || 'list');
    const [statusFilter, setStatusFilter] = useState<'all' | 'applied' | 'unapplied' | 'translated' | 'untranslated' | 'partialFailed' | 'error' | 'toExtract'>('all');
    const [plugins, setPlugins] = useState<PluginManifest[]>([]);
    const [enabledPlugins, setEnabledPlugins] = useState<Set<string>>(new Set());
    const [refreshKey, setRefreshKey] = useState(0);
    const [cloudManifest, setCloudManifest] = useState<any[]>([]);
    const [batchTask, setBatchTask] = useState<BatchTaskState>(EMPTY_BATCH_TASK_STATE);
    const translateAbortControllerRef = useRef<AbortController | null>(null);
    const stopRequestedRef = useRef(false);

    const setViewMode = useCallback((mode: 'list' | 'grid') => {
        setViewModeState(mode);
        settings.pluginViewMode = mode;
        i18n.saveSettings();
    }, [i18n, settings]);

    useEffect(() => {
        const repo = settings.defaultCloudRepo;
        if (!repo) {
            setCloudManifest([]);
            return;
        }
        const parts = repo.split('/');
        if (parts.length !== 2) return;
        const [owner, repoName] = parts;

        let isMounted = true;
        i18n.api.github.getFileContentWithFallback(owner, repoName, 'metadata.json')
            .then(res => {
                if (isMounted && res.state && Array.isArray(res.data)) {
                    setCloudManifest(res.data);
                }
            })
            .catch(e => console.error('Failed to fetch default cloud repo:', e));

        return () => {
            isMounted = false;
        };
    }, [settings.defaultCloudRepo, i18n]);

    const sourceTick = useGlobalStoreInstance((state) => state.sourceUpdateTick);

    const sortOptions = useMemo(() => [
        { key: '0', label: t('Common.Data.SortAsc') },
        { key: '1', label: t('Common.Data.SortDesc') }
    ], [t]);

    const filterOptions = useMemo(() => [
        { key: 'all', label: t('Manager.Common.Filters.All') },
        { key: 'toExtract', label: t('Manager.Plugins.Filters.ToExtract') },
        { key: 'error', label: t('Manager.Plugins.Filters.Error') },
        { key: 'partialFailed', label: t('Manager.Plugins.Filters.PartialFailed') },
        { key: 'untranslated', label: t('Manager.Plugins.Filters.Untranslated') },
        { key: 'translated', label: t('Manager.Plugins.Filters.Translated') },
        { key: 'unapplied', label: t('Manager.Plugins.Filters.Unapplied') },
        { key: 'applied', label: t('Manager.Plugins.Filters.Applied') }
    ], [t]);

    useEffect(() => {
        // @ts-ignore
        const allPlugins = Object.values(app.plugins.manifests) as PluginManifest[];
        const filteredPlugins = allPlugins.filter(item => item.id !== i18n.manifest.id);
        setPlugins(filteredPlugins);
        // @ts-ignore
        setEnabledPlugins(new Set(app.plugins.enabledPlugins));
    }, [app, refreshKey, i18n.manifest.id]);

    const sourceIndex = useMemo(() => {
        const byPlugin: Record<string, any[]> = {};
        const activeByPlugin: Record<string, string | null> = {};
        const allSources = i18n.sourceManager?.getAllSources() || [];

        for (const source of allSources) {
            if (!byPlugin[source.plugin]) {
                byPlugin[source.plugin] = [];
            }
            byPlugin[source.plugin].push(source);
            if (source.isActive) {
                activeByPlugin[source.plugin] = source.id;
            }
        }

        for (const pluginId of Object.keys(byPlugin)) {
            if (!activeByPlugin[pluginId] && byPlugin[pluginId].length > 0) {
                activeByPlugin[pluginId] = byPlugin[pluginId][0].id;
            }
        }

        return { byPlugin, activeByPlugin };
    }, [i18n.sourceManager, sourceTick]);

    const cloudEntriesByPlugin = useMemo(() => {
        const grouped: Record<string, any[]> = {};
        for (const entry of cloudManifest) {
            if (entry.type !== 'plugin') continue;
            if (!grouped[entry.plugin]) {
                grouped[entry.plugin] = [];
            }
            grouped[entry.plugin].push(entry);
        }
        return grouped;
    }, [cloudManifest]);

    const countPendingTranslationItems = useCallback((json: PluginTranslationV1) => {
        if (!json?.dict) return 0;

        let count = 0;
        for (const fileData of Object.values(json.dict)) {
            count += fileData.ast.filter(item => shouldTranslateText(item.target, item.source)).length;
            count += fileData.regex.filter(item => shouldTranslateText(item.target, item.source)).length;
        }
        return count;
    }, []);

    const pluginFailureRecords = useMemo(() => {
        return i18n.sourceManager.getBatchTaskFailures('plugin');
    }, [i18n, sourceTick]);

    const failedSourceIds = useMemo(() => {
        return new Set(pluginFailureRecords.map(record => record.sourceId));
    }, [pluginFailureRecords]);

    const checkIsTranslated = useCallback((json: PluginTranslationV1, sourceId: string | null) => {
        if (!json.dict || !sourceId || failedSourceIds.has(sourceId)) return false;
        return countPendingTranslationItems(json) === 0;
    }, [countPendingTranslationItems, failedSourceIds]);

    const allPluginStates = useMemo(() => {
        const stats: Record<string, PluginItemData> = {};
        // @ts-ignore
        const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());

        for (const plugin of plugins) {
            const pluginDir = path.join(basePath, plugin.dir || '');
            const activeSourceId = sourceIndex.activeByPlugin[plugin.id] || null;
            const langDoc = activeSourceId ? i18n.sourceManager.getSourceFilePath(activeSourceId) : '';
            const isLangDoc = !!langDoc && fs.pathExistsSync(langDoc);
            const manifestDoc = path.join(pluginDir, 'manifest.json');
            const mainDoc = path.join(pluginDir, 'main.js');

            const state = i18n.stateManager.getPluginState(plugin.id);
            const sources = sourceIndex.byPlugin[plugin.id] || [];
            const hasFailedBatches = !!activeSourceId && failedSourceIds.has(activeSourceId);

            let localJson: PluginTranslationV1 | undefined;
            let translationFormatMark = true;
            let isTranslated = false;
            let pendingTranslationCount = 0;
            if (isLangDoc) {
                try {
                    localJson = loadTranslationFile(langDoc);
                    translationFormatMark = isValidPluginTranslationV1Format(localJson);
                    if (translationFormatMark && localJson) {
                        pendingTranslationCount = countPendingTranslationItems(localJson);
                        isTranslated = checkIsTranslated(localJson, activeSourceId);
                    }
                } catch (e) {
                    translationFormatMark = false;
                }
            }

            let statusColor: string = 'bg-muted-foreground';
            let statusText: string = t('Manager.Plugins.Status.ToExtract');
            let statusDesc: string = t('Manager.Plugins.Hints.NoTransDesc');
            let mtime = 0;
            let translationVersion = '';
            let supportedVersion = '';

            if (localJson && translationFormatMark) {
                translationVersion = localJson.metadata.version;
                supportedVersion = localJson.metadata.supportedVersions;
                mtime = isLangDoc ? fs.statSync(langDoc).mtimeMs : Date.now();

                const isApplied = !!(state && state.isApplied);

                if (isApplied && isTranslated) {
                    statusColor = 'bg-green-500 dark:bg-green-600';
                    statusText = t('Manager.Plugins.Status.Applied');
                } else if (hasFailedBatches) {
                    statusColor = 'bg-orange-500 dark:bg-orange-600';
                    statusText = t('Manager.Plugins.Status.PartialFailed', '部分失败');
                } else if (isTranslated) {
                    statusColor = 'bg-blue-500 dark:bg-blue-600';
                    statusText = t('Manager.Plugins.Status.Unapplied');
                } else {
                    statusColor = 'bg-amber-500 dark:bg-amber-600';
                    statusText = t('Manager.Plugins.Status.Untranslated');
                }
                statusDesc = `${t('Manager.Plugins.Labels.Mtime')}: ${formatTimestamp(mtime)}`;
            } else if (isLangDoc && !translationFormatMark) {
                statusColor = 'bg-destructive';
                statusText = t('Manager.Common.Errors.Error');
                statusDesc = t('Manager.Common.Errors.ErrorDesc');
            }

            stats[plugin.id] = {
                statusColor,
                statusText,
                statusDesc,
                isLangDoc,
                langDoc,
                pluginDir,
                sources,
                activeSourceId,
                translationFormatMark,
                hasFailedBatches,
                hasFormatError: isLangDoc && !translationFormatMark,
                mainDoc,
                manifestDoc,
                isApplied: !!(state && state.isApplied),
                isTranslated,
                pendingTranslationCount,
                translationVersion,
                supportedVersion,
                cloudEntries: cloudEntriesByPlugin[plugin.id] || []
            };
        }
        return stats;
    }, [plugins, i18n, refreshKey, sourceIndex, t, checkIsTranslated, countPendingTranslationItems, cloudEntriesByPlugin, failedSourceIds]);

    const displayPlugins = useMemo(() => {
        let result = [...plugins];
        if (searchTerm) {
            result = result.filter(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()));
        }

        if (statusFilter !== 'all') {
            result = result.filter(plugin => {
                const data = allPluginStates[plugin.id];
                if (!data) return false;

                switch (statusFilter) {
                    case 'applied':
                        return data.isApplied;
                    case 'unapplied':
                        return data.isTranslated && !data.isApplied;
                    case 'translated':
                        return data.isTranslated;
                    case 'untranslated':
                        return data.isLangDoc && data.translationFormatMark && !data.isTranslated && !data.hasFailedBatches;
                    case 'partialFailed':
                        return data.hasFailedBatches;
                    case 'error':
                        return data.hasFormatError;
                    case 'toExtract':
                        return !data.isLangDoc;
                    default:
                        return true;
                }
            });
        }

        if (sortType === '0') {
            result.sort((a, b) => a.name.localeCompare(b.name));
        } else if (sortType === '1') {
            result.sort((a, b) => b.name.localeCompare(a.name));
        }
        return result;
    }, [plugins, searchTerm, sortType, statusFilter, allPluginStates]);

    const extractablePlugins = useMemo(() => {
        return displayPlugins.filter(plugin => !allPluginStates[plugin.id]?.isLangDoc);
    }, [displayPlugins, allPluginStates]);

    const translatablePlugins = useMemo(() => {
        return displayPlugins.filter(plugin => {
            const data = allPluginStates[plugin.id];
            return !!data?.translationFormatMark && (data?.pendingTranslationCount || 0) > 0;
        });
    }, [displayPlugins, allPluginStates]);

    const pluginExtractCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(PLUGIN_EXTRACT_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const pluginTranslateCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(PLUGIN_TRANSLATE_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const isAbortError = useCallback((error: unknown) => {
        return error instanceof Error && (error.name === 'AbortError' || error.message === '翻译任务已取消');
    }, []);

    const clearLocalSourcesForPlugin = useCallback((pluginId: string) => {
        i18n.sourceManager
            .getSourcesForPlugin(pluginId)
            .filter(source => source.origin === 'local' && source.type === 'plugin')
            .forEach(source => i18n.sourceManager.removeSource(source.id));
    }, [i18n]);

    const buildPluginSourceUpdate = useCallback((source: any, translationJson: PluginTranslationV1) => ({
        ...source,
        title: translationJson.metadata?.title || source.title,
        origin: 'local',
        cloud: undefined,
        checksum: calculateChecksum(translationJson),
    }), []);

    const savePluginExtractCheckpoint = useCallback((resources: PluginBatchResource[], completedIndexes: Set<number>, completedResources: number, totalResources: number) => {
        i18n.sourceManager.saveBatchTaskCheckpoint(PLUGIN_EXTRACT_CHECKPOINT_KEY, {
            scope: 'plugin',
            mode: 'extract',
            resources: resources.filter((_, index) => !completedIndexes.has(index)).map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId ?? null,
            })),
            totalResources,
            completedResources,
            totalItems: 0,
            processedItems: 0,
            stoppedAt: Date.now(),
        });
    }, [i18n]);

    const savePluginTranslateCheckpoint = useCallback((resources: PluginBatchResource[], startIndex: number, completedResources: number, totalResources: number, totalItems: number, processedItems: number) => {
        i18n.sourceManager.saveBatchTaskCheckpoint(PLUGIN_TRANSLATE_CHECKPOINT_KEY, {
            scope: 'plugin',
            mode: 'translate',
            resources: resources.slice(startIndex).map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId ?? null,
            })),
            totalResources,
            completedResources,
            totalItems,
            processedItems,
            stoppedAt: Date.now(),
        });
    }, [i18n]);

    const clearPluginFailuresForSource = useCallback((sourceId: string) => {
        const ids = i18n.sourceManager
            .getBatchTaskFailures('plugin')
            .filter(item => item.sourceId === sourceId)
            .map(item => item.id);
        i18n.sourceManager.removeBatchTaskFailures(ids);
    }, [i18n]);

    const buildPluginFailureRecord = useCallback((failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>): BatchTaskFailureRecord => ({
        ...failure,
        id: `${failure.sourceId}:${failure.batchType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        scope: 'plugin',
        failedAt: Date.now(),
    }), []);

    const recordPluginFailure = useCallback((failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>) => {
        i18n.sourceManager.saveBatchTaskFailure(buildPluginFailureRecord(failure));
    }, [buildPluginFailureRecord, i18n]);

    const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = e.target.value;
        setSearchTerm(val);
        settings.searchText = val;
        i18n.saveSettings();
    };

    const handleSortChange = (val: string) => {
        setSortType(val);
        settings.sort = val;
        i18n.saveSettings();
    };

    const parentRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);

    useEffect(() => {
        if (!parentRef.current) return;
        const resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                setContainerWidth(entry.contentRect.width);
            }
        });
        resizeObserver.observe(parentRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    const columns = useMemo(() => {
        if (viewMode === 'list') return 1;
        const count = Math.floor((containerWidth + 16) / (320 + 16));
        return Math.max(1, count);
    }, [viewMode, containerWidth]);

    const rowCount = Math.ceil(displayPlugins.length / columns);

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => parentRef.current,
        estimateSize: useCallback(() => viewMode === 'list' ? 44 + 4 : 200 + 12, [viewMode]),
        getItemKey: useCallback((index: number) => `${viewMode}-${index}`, [viewMode]),
        overscan: 5,
    });

    const virtualItems = rowVirtualizer.getVirtualItems();

    const reloadPlugin = useCallback(async (id: string) => {
        try {
            // @ts-ignore
            if (app.plugins.enabledPlugins.has(id)) {
                // @ts-ignore
                await app.plugins.disablePlugin(id);
                // @ts-ignore
                await app.plugins.enablePlugin(id);
                new Notice(t('Manager.Plugins.Notices.ReloadPlugin', { id }));
                return true;
            }
            return false;
        } catch (error) {
            new Notice(t('Manager.Plugins.Errors.ReloadPluginFailed', { error }));
            return false;
        }
    }, [app, t]);

    const handleRefresh = useCallback(() => {
        setRefreshKey(k => k + 1);
    }, []);

    const updateBatchTask = useCallback((updates: Partial<BatchTaskState>) => {
        setBatchTask(prev => ({ ...prev, ...updates }));
    }, []);

    const startPluginBatchExtract = useCallback(async (resume: boolean) => {
        const resources: PluginBatchResource[] = resume && pluginExtractCheckpoint?.resources.length
            ? pluginExtractCheckpoint.resources.map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId,
            }))
            : extractablePlugins.map(plugin => ({ resourceId: plugin.id, label: plugin.name }));

        if (batchTask.isRunning || resources.length === 0) return;

        const extractConcurrency = getPositiveInt(i18n.settings.batchExtractConcurrency, 3);
        stopRequestedRef.current = false;
        setBatchTask({
            mode: 'extract',
            isRunning: true,
            currentLabel: '',
            processedResources: 0,
            totalResources: resources.length,
            processedItems: 0,
            totalItems: 0,
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
        });

        let processedResources = 0;
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const completedIndexes = new Set<number>();
        const pendingEntries: Array<{ pluginId: string; content: PluginTranslationV1; options: { title: string } }> = [];

        const flushPendingEntries = () => {
            if (pendingEntries.length === 0) return;
            i18n.sourceManager.batchExtractAndSaveSources(pendingEntries.splice(0, pendingEntries.length));
        };

        const markResourceDone = (index: number) => {
            completedIndexes.add(index);
        };

        const saveStopCheckpoint = () => {
            flushPendingEntries();
            savePluginExtractCheckpoint(resources, completedIndexes, processedResources, resources.length);
        };

        const saveProgressCheckpoint = () => {
            flushPendingEntries();
            savePluginExtractCheckpoint(resources, completedIndexes, processedResources, resources.length);
        };

        try {
            await runConcurrentTasks(resources, extractConcurrency, () => stopRequestedRef.current, async (resource, index) => {
                const plugin = plugins.find(item => item.id === resource.resourceId);
                const data = allPluginStates[resource.resourceId];
                updateBatchTask({ currentLabel: resource.label });

                let shouldSaveCheckpoint = false;
                try {
                    if (!plugin || !data || !await fs.pathExists(data.mainDoc)) {
                        throw new Error(t('Manager.Plugins.Errors.MainNotFound'));
                    }

                    const [mainStr, manifestJSON] = await Promise.all([
                        fs.readFile(data.mainDoc, 'utf8'),
                        fs.readJson(data.manifestDoc)
                    ]);

                    if (hasChineseText(`${manifestJSON.name || plugin.name}\n${manifestJSON.description || ''}\n${mainStr}`)) {
                        flushPendingEntries();
                        clearLocalSourcesForPlugin(plugin.id);
                        skippedCount++;
                        shouldSaveCheckpoint = true;
                    } else {
                        const translationJson = generatePlugin(plugin.version, manifestJSON, mainStr, settings.language, i18n.settings);
                        const extractedSources = getPluginTranslationSources(translationJson);
                        if (!hasExtractedTranslationContent(extractedSources)) {
                            skippedCount++;
                            shouldSaveCheckpoint = true;
                        } else {
                            pendingEntries.push({ pluginId: plugin.id, content: translationJson, options: { title: plugin.name } });
                            successCount++;

                            if (pendingEntries.length >= Math.max(5, extractConcurrency * 2)) {
                                flushPendingEntries();
                            }
                        }
                    }
                } catch (error) {
                    failedCount++;
                    console.error(`[i18n] Failed to batch extract plugin ${resource.resourceId}:`, error);
                }

                processedResources++;
                markResourceDone(index);
                if (shouldSaveCheckpoint) {
                    saveProgressCheckpoint();
                }
                updateBatchTask({
                    processedResources,
                    successCount,
                    failedCount,
                    skippedCount,
                });
            });

            if (stopRequestedRef.current) {
                saveStopCheckpoint();
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }

            flushPendingEntries();
            i18n.sourceManager.clearBatchTaskCheckpoint(PLUGIN_EXTRACT_CHECKPOINT_KEY);
            handleRefresh();
            new Notice(t('Manager.Plugins.Notices.BatchExtractComplete', { success: successCount, fail: failedCount, skip: skippedCount, defaultValue: `批量提取完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}` }));
        } finally {
            stopRequestedRef.current = false;
            setBatchTask(prev => ({
                ...prev,
                isRunning: false,
                currentLabel: '',
                processedResources,
                successCount,
                failedCount,
                skippedCount,
            }));
        }
    }, [allPluginStates, batchTask.isRunning, clearLocalSourcesForPlugin, extractablePlugins, handleRefresh, i18n, plugins, pluginExtractCheckpoint, savePluginExtractCheckpoint, settings.language, t, updateBatchTask]);

    const handleBatchExtract = useCallback(() => startPluginBatchExtract(false), [startPluginBatchExtract]);
    const handleResumeExtract = useCallback(() => startPluginBatchExtract(true), [startPluginBatchExtract]);

    const applyAstBatchResults = useCallback((translationJson: PluginTranslationV1, mappings: Map<number, { file: string; index: number }>, batchResult: AstItem[]) => {
        for (const result of batchResult) {
            const mapping = mappings.get(result.id);
            if (!mapping) continue;
            translationJson.dict[mapping.file].ast[mapping.index].target = result.target;
        }
    }, []);

    const applyRegexBatchResults = useCallback((translationJson: PluginTranslationV1, mappings: Map<number, { file: string; index: number }>, batchResult: RegexItem[]) => {
        for (const result of batchResult) {
            const mapping = mappings.get(result.id);
            if (!mapping) continue;
            translationJson.dict[mapping.file].regex[mapping.index].target = result.target;
        }
    }, []);

    const translatePluginSource = useCallback(async (
        translationJson: PluginTranslationV1,
        context: { resourceId: string; resourceLabel: string; sourceId: string },
        onItemsProcessed: (count: number) => void,
        onBatchPersist: () => void,
        signal?: AbortSignal,
        onBatchFailure: (failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>) => void = recordPluginFailure,
    ) => {
        const provider = createTranslationProvider();
        const astItems: AstItem[] = [];
        const regexItems: RegexItem[] = [];
        const astMappings = new Map<number, { file: string; index: number }>();
        const regexMappings = new Map<number, { file: string; index: number }>();
        let nextId = 0;

        for (const [file, dict] of Object.entries(translationJson.dict || {})) {
            dict.ast.forEach((item, index) => {
                if (!shouldTranslateText(item.target, item.source)) return;
                const id = nextId++;
                astItems.push({
                    id,
                    type: item.type,
                    name: item.name,
                    source: item.source,
                    target: item.target,
                });
                astMappings.set(id, { file, index });
            });

            dict.regex.forEach((item, index) => {
                if (!shouldTranslateText(item.target, item.source)) return;
                const id = nextId++;
                regexItems.push({
                    id,
                    source: item.source,
                    target: item.target,
                });
                regexMappings.set(id, { file, index });
            });
        }

        const translateTasks: Promise<void>[] = [];

        if (astItems.length > 0) {
            translateTasks.push(provider.astTranslate(astItems, async (batchResult) => {
                applyAstBatchResults(translationJson, astMappings, batchResult);
                onItemsProcessed(batchResult.length);
                onBatchPersist();
            }, signal, async (batchItems, error) => {
                onBatchFailure({
                    ...context,
                    batchType: 'ast',
                    errorMessage: error.message,
                    items: batchItems.map(item => {
                        const mapping = astMappings.get(item.id);
                        return {
                            source: item.source,
                            target: item.target,
                            dictIndex: mapping?.index ?? -1,
                            file: mapping?.file,
                            type: item.type,
                            name: item.name,
                        };
                    }).filter(item => item.dictIndex >= 0 && item.file),
                });
            }).then(() => undefined));
        }

        if (regexItems.length > 0) {
            translateTasks.push(provider.regexTranslate(regexItems, async (batchResult) => {
                applyRegexBatchResults(translationJson, regexMappings, batchResult);
                onItemsProcessed(batchResult.length);
                onBatchPersist();
            }, signal, async (batchItems, error) => {
                onBatchFailure({
                    ...context,
                    batchType: 'regex',
                    errorMessage: error.message,
                    items: batchItems.map(item => {
                        const mapping = regexMappings.get(item.id);
                        return {
                            source: item.source,
                            target: item.target,
                            dictIndex: mapping?.index ?? -1,
                            file: mapping?.file,
                        };
                    }).filter(item => item.dictIndex >= 0 && item.file),
                });
            }).then(() => undefined));
        }

        await Promise.all(translateTasks);
    }, [applyAstBatchResults, applyRegexBatchResults, recordPluginFailure]);

    const startPluginBatchTranslate = useCallback(async (resume: boolean) => {
        const resources: PluginBatchResource[] = resume && pluginTranslateCheckpoint?.resources.length
            ? pluginTranslateCheckpoint.resources.map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId,
            }))
            : translatablePlugins.map(plugin => ({
                resourceId: plugin.id,
                label: plugin.name,
                sourceId: allPluginStates[plugin.id]?.activeSourceId,
            }));

        if (batchTask.isRunning || resources.length === 0) return;

        const totalItems = resources.reduce((sum, resource) => {
            return sum + (allPluginStates[resource.resourceId]?.pendingTranslationCount || 0);
        }, 0);

        stopRequestedRef.current = false;
        translateAbortControllerRef.current = new AbortController();
        setBatchTask({
            mode: 'translate',
            isRunning: true,
            currentLabel: '',
            processedResources: 0,
            totalResources: resources.length,
            processedItems: 0,
            totalItems,
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
        });

        const translateConcurrency = getPositiveInt(i18n.settings.batchTranslateConcurrency, 2);
        let processedResources = 0;
        let processedItems = 0;
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        let nextCheckpointIndex = 0;
        const completedIndexes = new Set<number>();
        const pendingFailures: BatchTaskFailureRecord[] = [];
        const flushPendingFailures = () => {
            if (pendingFailures.length === 0) return;
            i18n.sourceManager.saveBatchTaskFailures(pendingFailures.splice(0, pendingFailures.length));
        };

        const markResourceDone = (index: number) => {
            completedIndexes.add(index);
            while (completedIndexes.has(nextCheckpointIndex)) nextCheckpointIndex++;
        };

        const saveStopCheckpoint = () => {
            flushPendingFailures();
            savePluginTranslateCheckpoint(resources, nextCheckpointIndex, processedResources, resources.length, totalItems, processedItems);
        };

        try {
            await runConcurrentTasks(resources, translateConcurrency, () => stopRequestedRef.current || !!translateAbortControllerRef.current?.signal.aborted, async (resource, index) => {
                if (stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) return;

                const data = allPluginStates[resource.resourceId];
                updateBatchTask({ currentLabel: resource.label });

                try {
                    const sourceId = resource.sourceId || data?.activeSourceId;
                    if (!sourceId || !data?.langDoc || !data.translationFormatMark) {
                        skippedCount++;
                    } else {
                        const source = i18n.sourceManager.getSource(sourceId);
                        const translationPath = i18n.sourceManager.getSourceFilePath(sourceId);
                        const translationJson = loadTranslationFile(translationPath) as PluginTranslationV1 | null;
                        const pendingCount = translationJson ? countPendingTranslationItems(translationJson) : 0;

                        if (!source || !translationJson || pendingCount === 0) {
                            skippedCount++;
                        } else {
                            await yieldToMainThread();
                            const persistCurrentSource = () => {
                                i18n.sourceManager.saveSourceFile(source.id, translationJson);
                                i18n.sourceManager.saveSource(buildPluginSourceUpdate(source, translationJson));
                            };
                            let lastPersistAt = 0;
                            let lastProgressUpdateAt = 0;
                            let hasPendingPersist = false;

                            const scheduleCurrentSourcePersist = () => {
                                hasPendingPersist = true;
                                const now = Date.now();
                                if (now - lastPersistAt < BATCH_PERSIST_INTERVAL) return;
                                persistCurrentSource();
                                lastPersistAt = now;
                                hasPendingPersist = false;
                            };

                            const flushCurrentSourcePersist = () => {
                                if (!hasPendingPersist) return;
                                persistCurrentSource();
                                lastPersistAt = Date.now();
                                hasPendingPersist = false;
                            };

                            const updateProcessedItems = (count: number) => {
                                processedItems += count;
                                const now = Date.now();
                                if (now - lastProgressUpdateAt < BATCH_PROGRESS_UPDATE_INTERVAL) return;
                                updateBatchTask({ processedItems });
                                lastProgressUpdateAt = now;
                            };

                            await translatePluginSource(translationJson, {
                                resourceId: resource.resourceId,
                                resourceLabel: resource.label,
                                sourceId: source.id,
                            }, updateProcessedItems, scheduleCurrentSourcePersist, translateAbortControllerRef.current?.signal, (failure) => {
                                pendingFailures.push(buildPluginFailureRecord(failure));
                            });
                            flushCurrentSourcePersist();
                            persistCurrentSource();
                            clearPluginFailuresForSource(source.id);
                            updateBatchTask({ processedItems });
                            successCount++;
                        }
                    }
                    processedResources++;
                    markResourceDone(index);
                } catch (error) {
                    if (isAbortError(error)) {
                        stopRequestedRef.current = true;
                        saveStopCheckpoint();
                        return;
                    }
                    failedCount++;
                    processedResources++;
                    markResourceDone(index);
                    console.error(`[i18n] Failed to batch translate plugin ${resource.resourceId}:`, error);
                }

                updateBatchTask({
                    processedResources,
                    processedItems,
                    successCount,
                    failedCount,
                    skippedCount,
                });
            });

            if (stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) {
                saveStopCheckpoint();
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }

            flushPendingFailures();
            i18n.sourceManager.clearBatchTaskCheckpoint(PLUGIN_TRANSLATE_CHECKPOINT_KEY);
            handleRefresh();
            new Notice(t('Manager.Plugins.Notices.BatchTranslateComplete', { success: successCount, fail: failedCount, skip: skippedCount, defaultValue: `批量翻译完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}` }));
        } catch (error) {
            console.error('[i18n] Batch plugin translation failed:', error);
            new Notice(t('Common.Notices.TranslateFail', { message: String(error) }));
        } finally {
            flushPendingFailures();
            stopRequestedRef.current = false;
            translateAbortControllerRef.current = null;
            setBatchTask(prev => ({
                ...prev,
                isRunning: false,
                currentLabel: '',
                processedResources,
                processedItems,
                successCount,
                failedCount,
                skippedCount,
            }));
        }
    }, [allPluginStates, batchTask.isRunning, buildPluginFailureRecord, buildPluginSourceUpdate, clearPluginFailuresForSource, countPendingTranslationItems, handleRefresh, i18n, isAbortError, pluginTranslateCheckpoint, savePluginTranslateCheckpoint, t, translatablePlugins, translatePluginSource, updateBatchTask]);

    const handleBatchTranslate = useCallback(() => startPluginBatchTranslate(false), [startPluginBatchTranslate]);
    const handleResumeTranslate = useCallback(() => startPluginBatchTranslate(true), [startPluginBatchTranslate]);

    const handleStopBatchTask = useCallback(() => {
        stopRequestedRef.current = true;
        translateAbortControllerRef.current?.abort();
        setBatchTask(prev => ({ ...prev, currentLabel: t('Manager.Common.Status.Stopping', '正在停止') }));
    }, [t]);

    const handleRetryPluginFailures = useCallback(async () => {
        if (batchTask.isRunning || pluginFailureRecords.length === 0) return;

        const retryConcurrency = getPositiveInt(i18n.settings.batchTranslateConcurrency, 2);
        const failureGroups = Array.from(pluginFailureRecords.reduce((map, failure) => {
            const group = map.get(failure.sourceId) || [];
            group.push(failure);
            map.set(failure.sourceId, group);
            return map;
        }, new Map<string, BatchTaskFailureRecord[]>()).values());

        stopRequestedRef.current = false;
        translateAbortControllerRef.current = new AbortController();
        setBatchTask({
            mode: 'translate',
            isRunning: true,
            currentLabel: '',
            processedResources: 0,
            totalResources: pluginFailureRecords.length,
            processedItems: 0,
            totalItems: pluginFailureRecords.reduce((sum, failure) => sum + failure.items.length, 0),
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
        });

        let processedResources = 0;
        let processedItems = 0;
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;

        const updateRetryProgress = () => {
            updateBatchTask({ processedResources, processedItems, successCount, failedCount, skippedCount });
        };

        const markProcessedRecords = (count: number) => {
            processedResources += count;
            updateRetryProgress();
        };

        const processFailureGroup = async (failures: BatchTaskFailureRecord[]) => {
            if (failures.length === 0 || stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) return;

            const firstFailure = failures[0];
            updateBatchTask({ currentLabel: firstFailure.resourceLabel });

            let source: any | null = null;
            let translationJson: PluginTranslationV1 | null = null;
            try {
                source = i18n.sourceManager.getSource(firstFailure.sourceId);
                translationJson = i18n.sourceManager.readSourceFile(firstFailure.sourceId) as PluginTranslationV1 | null;
            } catch (error) {
                console.error(`[i18n] Failed to load plugin retry source ${firstFailure.sourceId}:`, error);
            }

            if (!source || !translationJson) {
                skippedCount += failures.length;
                markProcessedRecords(failures.length);
                return;
            }

            const provider = createTranslationProvider();
            let sourceDirty = false;
            let lastPersistAt = 0;
            const attemptedRecordIds = new Set<string>();
            const failedRecordIds = new Set<string>();
            const recordTotalItems = new Map<string, number>();
            const recordSucceededItems = new Map<string, number>();

            const persistSource = () => {
                if (!sourceDirty) return;
                i18n.sourceManager.saveSourceFile(source.id, translationJson);
                i18n.sourceManager.saveSource(buildPluginSourceUpdate(source, translationJson));
                sourceDirty = false;
                lastPersistAt = Date.now();
            };

            const schedulePersistSource = () => {
                if (!sourceDirty) return;
                if (Date.now() - lastPersistAt < BATCH_PERSIST_INTERVAL) return;
                persistSource();
            };

            const addRecordItems = (failureId: string, count: number) => {
                if (count <= 0) return;
                attemptedRecordIds.add(failureId);
                recordTotalItems.set(failureId, (recordTotalItems.get(failureId) || 0) + count);
            };

            const markRecordItemSucceeded = (failureId: string) => {
                recordSucceededItems.set(failureId, (recordSucceededItems.get(failureId) || 0) + 1);
            };

            const getCompletedRecordIds = () => Array.from(attemptedRecordIds).filter(id => {
                if (failedRecordIds.has(id)) return false;
                return (recordSucceededItems.get(id) || 0) >= (recordTotalItems.get(id) || 0);
            });

            const astItems: AstItem[] = [];
            const regexItems: RegexItem[] = [];
            const astMappings = new Map<number, { failureId: string; file: string; index: number }>();
            const regexMappings = new Map<number, { failureId: string; file: string; index: number }>();
            let nextAstId = 0;
            let nextRegexId = 0;

            for (const failure of failures) {
                if (failure.batchType === 'ast') {
                    let itemCount = 0;
                    for (const item of failure.items) {
                        if (!item.file || item.dictIndex < 0) {
                            failedRecordIds.add(failure.id);
                            continue;
                        }
                        const id = nextAstId++;
                        astItems.push({
                            id,
                            type: item.type || '',
                            name: item.name || '',
                            source: item.source,
                            target: item.target,
                        });
                        astMappings.set(id, { failureId: failure.id, file: item.file, index: item.dictIndex });
                        itemCount++;
                    }
                    addRecordItems(failure.id, itemCount);
                    if (itemCount === 0) skippedCount++;
                } else if (failure.batchType === 'regex') {
                    let itemCount = 0;
                    for (const item of failure.items) {
                        if (!item.file || item.dictIndex < 0) {
                            failedRecordIds.add(failure.id);
                            continue;
                        }
                        const id = nextRegexId++;
                        regexItems.push({ id, source: item.source, target: item.target });
                        regexMappings.set(id, { failureId: failure.id, file: item.file, index: item.dictIndex });
                        itemCount++;
                    }
                    addRecordItems(failure.id, itemCount);
                    if (itemCount === 0) skippedCount++;
                } else {
                    skippedCount++;
                }
            }

            const retryTasks: Promise<void>[] = [];

            if (astItems.length > 0) {
                retryTasks.push(provider.astTranslate(astItems, async (batchResult) => {
                    for (const result of batchResult) {
                        const mapping = astMappings.get(result.id);
                        if (!mapping) continue;
                        const dictItem = translationJson.dict[mapping.file]?.ast[mapping.index];
                        if (!dictItem) {
                            failedRecordIds.add(mapping.failureId);
                            continue;
                        }
                        dictItem.target = result.target;
                        sourceDirty = true;
                        markRecordItemSucceeded(mapping.failureId);
                    }
                    processedItems += batchResult.length;
                    schedulePersistSource();
                    updateBatchTask({ processedItems });
                }, translateAbortControllerRef.current?.signal, async (batchItems) => {
                    for (const item of batchItems) {
                        const mapping = astMappings.get(item.id);
                        if (mapping) failedRecordIds.add(mapping.failureId);
                    }
                }).then(() => undefined));
            }

            if (regexItems.length > 0) {
                retryTasks.push(provider.regexTranslate(regexItems, async (batchResult) => {
                    for (const result of batchResult) {
                        const mapping = regexMappings.get(result.id);
                        if (!mapping) continue;
                        const dictItem = translationJson.dict[mapping.file]?.regex[mapping.index];
                        if (!dictItem) {
                            failedRecordIds.add(mapping.failureId);
                            continue;
                        }
                        dictItem.target = result.target;
                        sourceDirty = true;
                        markRecordItemSucceeded(mapping.failureId);
                    }
                    processedItems += batchResult.length;
                    schedulePersistSource();
                    updateBatchTask({ processedItems });
                }, translateAbortControllerRef.current?.signal, async (batchItems) => {
                    for (const item of batchItems) {
                        const mapping = regexMappings.get(item.id);
                        if (mapping) failedRecordIds.add(mapping.failureId);
                    }
                }).then(() => undefined));
            }

            try {
                await Promise.all(retryTasks);
            } catch (error) {
                if (isAbortError(error)) {
                    stopRequestedRef.current = true;
                } else {
                    for (const id of attemptedRecordIds) failedRecordIds.add(id);
                    console.error(`[i18n] Failed to retry plugin source ${firstFailure.sourceId}:`, error);
                }
            } finally {
                persistSource();
                const completedRecordIds = getCompletedRecordIds();
                if (completedRecordIds.length > 0) {
                    i18n.sourceManager.removeBatchTaskFailures(completedRecordIds);
                    successCount += completedRecordIds.length;
                }

                const failedRecords = Array.from(attemptedRecordIds).filter(id => failedRecordIds.has(id));
                if (!stopRequestedRef.current && !translateAbortControllerRef.current?.signal.aborted) {
                    failedCount += failedRecords.length;
                    markProcessedRecords(failures.length);
                } else {
                    markProcessedRecords(completedRecordIds.length);
                }
            }
        };

        try {
            await runConcurrentTasks(failureGroups, retryConcurrency, () => stopRequestedRef.current || !!translateAbortControllerRef.current?.signal.aborted, processFailureGroup);

            handleRefresh();
            if (stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) {
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }

            new Notice(t('Manager.Common.Notices.RetryFailuresComplete', { success: successCount, fail: failedCount, skip: skippedCount, defaultValue: `失败批次重试完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}` }));
        } finally {
            stopRequestedRef.current = false;
            translateAbortControllerRef.current = null;
            setBatchTask(prev => ({
                ...prev,
                isRunning: false,
                currentLabel: '',
                processedResources,
                processedItems,
                successCount,
                failedCount,
                skippedCount,
            }));
        }
    }, [batchTask.isRunning, buildPluginSourceUpdate, handleRefresh, i18n, isAbortError, pluginFailureRecords, t, updateBatchTask]);

    const batchProgressValue = useMemo(() => {
        if (!batchTask.totalResources) return 0;
        if (batchTask.mode === 'translate' && batchTask.totalItems > 0) {
            return (batchTask.processedItems / batchTask.totalItems) * 100;
        }
        return (batchTask.processedResources / batchTask.totalResources) * 100;
    }, [batchTask]);

    return (
        <div className="flex flex-col h-full bg-background text-foreground overflow-hidden">
            <div className="flex flex-col gap-4 py-2 px-4 border-b shrink-0">
                <div className="flex gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground/70" />
                        <Input
                            placeholder={t('Manager.Plugins.Placeholders.SearchPlugins')}
                            value={searchTerm}
                            onChange={handleSearchChange}
                            className="pl-8 h-9 rounded-none border-muted-foreground/20 focus:ring-1 text-[13px] bg-muted/10 shadow-sm transition-colors hover:bg-muted/20"
                        />
                    </div>

                    <div className="flex items-center gap-1 border border-muted-foreground/20 rounded-none p-0.5 h-9 bg-muted/20 shadow-sm">
                        <Button variant={viewMode === 'list' ? 'secondary' : 'ghost'} size="icon" className="h-8 w-8 rounded-none transition-all" onClick={() => setViewMode('list')}>
                            <List className="h-4 w-4 text-muted-foreground/80" />
                        </Button>
                        <Button
                            variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
                            size="icon"
                            className="h-8 w-8 rounded-none transition-all"
                            onClick={() => setViewMode('grid')}
                        >
                            <LayoutGrid className="h-4 w-4 text-muted-foreground/80" />
                        </Button>
                    </div>

                    <Select value={statusFilter} onValueChange={(val: any) => setStatusFilter(val)}>
                        <SelectTrigger className="w-[120px] h-9 rounded-none border-muted-foreground/20 shadow-sm text-[13px]" size="default">
                            <SelectValue placeholder={t('Manager.Common.Filters.All')} />
                        </SelectTrigger>
                        <SelectContent>
                            {filterOptions.map((opt) => (
                                <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Select value={sortType} onValueChange={handleSortChange}>
                        <SelectTrigger className="w-[130px] h-9 rounded-none border-muted-foreground/20 shadow-sm text-[13px]" size="default">
                            <SelectValue placeholder={t('Common.Data.SortAsc')} />
                        </SelectTrigger>
                        <SelectContent>
                            {sortOptions.map((opt) => (
                                <SelectItem key={opt.key} value={opt.key}>{opt.label}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>

                <div className="flex flex-wrap items-center gap-2 justify-between">
                    <div className="text-[12px] text-muted-foreground">
                        {t('Manager.Common.Labels.ScopeHint', { count: displayPlugins.length, defaultValue: `当前筛选范围：${displayPlugins.length} 项` })}
                    </div>
                    <div className="flex items-center gap-2">
                        {batchTask.isRunning && (
                            <Button
                                variant="destructive"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleStopBatchTask}
                            >
                                <Square className="w-4 h-4" />
                                {t('Manager.Common.Actions.StopTask', '停止任务')}
                            </Button>
                        )}
                        {!batchTask.isRunning && (pluginExtractCheckpoint?.resources?.length ?? 0) > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleResumeExtract}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.ResumeExtract', '继续提取')}
                                <span className="text-muted-foreground">{pluginExtractCheckpoint?.resources?.length ?? 0}</span>
                            </Button>
                        )}
                        {!batchTask.isRunning && (pluginTranslateCheckpoint?.resources?.length ?? 0) > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleResumeTranslate}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.ResumeTranslate', '继续翻译')}
                                <span className="text-muted-foreground">{pluginTranslateCheckpoint?.resources?.length ?? 0}</span>
                            </Button>
                        )}
                        {!batchTask.isRunning && pluginFailureRecords.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleRetryPluginFailures}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.RetryFailures', '重试失败批次')}
                                <span className="text-muted-foreground">{pluginFailureRecords.length}</span>
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 rounded-none gap-1.5 text-[13px]"
                            onClick={handleBatchExtract}
                            disabled={batchTask.isRunning || extractablePlugins.length === 0}
                        >
                            {batchTask.isRunning && batchTask.mode === 'extract' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileOutput className="w-4 h-4" />}
                            {t('Manager.Common.Actions.BatchExtract', '批量提取')}
                            <span className="text-muted-foreground">{extractablePlugins.length}</span>
                        </Button>
                        <Button
                            variant="default"
                            size="sm"
                            className="h-9 rounded-none gap-1.5 text-[13px]"
                            onClick={handleBatchTranslate}
                            disabled={batchTask.isRunning || translatablePlugins.length === 0}
                        >
                            {batchTask.isRunning && batchTask.mode === 'translate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
                            {t('Manager.Common.Actions.BatchTranslate', '批量翻译')}
                            <span className="text-primary-foreground/80">{translatablePlugins.length}</span>
                        </Button>
                    </div>
                </div>

                {(batchTask.isRunning || batchTask.mode) && batchTask.totalResources > 0 && (
                    <div className="border border-muted-foreground/20 bg-muted/10 rounded-none px-3 py-2 space-y-2">
                        <div className="flex items-center justify-between gap-3 text-[12px]">
                            <span className="font-medium text-foreground/90 truncate">
                                {batchTask.mode === 'extract'
                                    ? t('Manager.Common.Status.BatchExtracting', '正在批量提取')
                                    : t('Manager.Common.Status.BatchTranslating', '正在批量翻译')}
                                {batchTask.currentLabel ? ` · ${batchTask.currentLabel}` : ''}
                            </span>
                            <span className="text-muted-foreground shrink-0">
                                {batchTask.processedResources}/{batchTask.totalResources}
                                {batchTask.mode === 'translate' && batchTask.totalItems > 0 ? ` · ${batchTask.processedItems}/${batchTask.totalItems}` : ''}
                            </span>
                        </div>
                        <Progress value={batchProgressValue} className="h-2 rounded-none" />
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                            <span>{t('Common.Status.Success')}: {batchTask.successCount}</span>
                            <span>{t('Common.Status.Failure')}: {batchTask.failedCount}</span>
                            {batchTask.skippedCount > 0 && <span>{t('Common.Status.Skipped', '跳过')}: {batchTask.skippedCount}</span>}
                        </div>
                    </div>
                )}
            </div>

            <ScrollArea className="flex-1 min-h-0" viewportRef={parentRef}>
                <div className="py-2 px-4">
                    <div className={cn('gap-2 w-full overflow-hidden relative', viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))]' : 'flex flex-col')}
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
                        {virtualItems.map((virtualRow) => {
                            const startIndex = virtualRow.index * columns;
                            const itemsInRow = displayPlugins.slice(startIndex, startIndex + columns);

                            return (
                                <div
                                    key={virtualRow.key}
                                    style={{
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        width: '100%',
                                        height: `${virtualRow.size}px`,
                                        transform: `translateY(${virtualRow.start}px)`,
                                        display: 'grid',
                                        gridTemplateColumns: `repeat(${columns}, 1fr)`,
                                        gap: viewMode === 'list' ? '0px' : '12px',
                                        paddingBottom: viewMode === 'list' ? '4px' : '12px',
                                    }}
                                >
                                    {itemsInRow.map((plugin) => (
                                        <PluginItem
                                            key={plugin.id}
                                            plugin={plugin}
                                            i18n={i18n}
                                            settings={settings}
                                            isEnabled={enabledPlugins.has(plugin.id)}
                                            data={allPluginStates[plugin.id]}
                                            reloadPlugin={reloadPlugin}
                                            refreshParent={handleRefresh}
                                            close={close}
                                            viewMode={viewMode}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                        {displayPlugins.length === 0 && (
                            <div className="text-center text-muted-foreground py-8 col-span-full">
                                {t('Manager.Plugins.Status.NoPlugins')}
                            </div>
                        )}
                    </div>
                </div>
            </ScrollArea>
        </div>
    );
};
