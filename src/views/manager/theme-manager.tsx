import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as path from 'path';
import * as fs from 'fs-extra';
import { useTranslation } from 'react-i18next';
import { Notice } from 'obsidian';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, LayoutGrid, List, FileOutput, Languages, Loader2, RotateCcw, Square } from 'lucide-react';

import I18N from 'src/main';
import { OBThemeManifest, ThemeTranslationV1, BatchTaskFailureRecord } from 'src/types';
import { calculateChecksum, generateTheme, getThemeTranslationSources, hasChineseText, hasExtractedTranslationContent } from '~/utils';
import { useGlobalStoreInstance } from '~/utils';
import { loadTranslationFile } from '../../manager/io-manager';
import { createTranslationProvider } from '~/ai/provider-factory';
import type { ThemeTranslationItem } from '../theme_editor/types';

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

interface ThemeManagerProps {
    i18n: I18N;
}

interface ThemeInfo {
    name: string;
    manifest: OBThemeManifest | null;
    dir: string;
    isActive: boolean;
}

import { ThemeItem, ThemeItemData } from './components/theme-item';

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

interface ThemeBatchResource {
    resourceId: string;
    label: string;
    sourceId?: string | null;
}

const THEME_EXTRACT_CHECKPOINT_KEY = 'theme:extract';
const THEME_TRANSLATE_CHECKPOINT_KEY = 'theme:translate';
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

export const ThemeManager: React.FC<ThemeManagerProps> = ({ i18n }) => {
    const { t } = useTranslation();
    const app = i18n.app;

    const [searchTerm, setSearchTerm] = useState('');
    const [sortType, setSortType] = useState('0');
    const [viewMode, setViewModeState] = useState<'list' | 'grid'>(i18n.settings.themeViewMode || 'list');
    const [themes, setThemes] = useState<ThemeInfo[]>([]);
    const [refreshKey, setRefreshKey] = useState(0);
    const [statusFilter, setStatusFilter] = useState<'all' | 'applied' | 'unapplied' | 'translated' | 'untranslated' | 'partialFailed' | 'toExtract'>('all');
    const [cloudManifest, setCloudManifest] = useState<any[]>([]);
    const [batchTask, setBatchTask] = useState<BatchTaskState>(EMPTY_BATCH_TASK_STATE);
    const translateAbortControllerRef = useRef<AbortController | null>(null);
    const stopRequestedRef = useRef(false);

    const setViewMode = useCallback((mode: 'list' | 'grid') => {
        setViewModeState(mode);
        i18n.settings.themeViewMode = mode;
        i18n.saveSettings();
    }, [i18n]);

    useEffect(() => {
        const repo = i18n.settings.defaultCloudRepo;
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
    }, [i18n.settings.defaultCloudRepo, i18n]);

    const sourceTick = useGlobalStoreInstance((state) => state.sourceUpdateTick);

    const sortOptions = useMemo(() => [
        { key: '0', label: t('Common.Data.SortAsc') },
        { key: '1', label: t('Common.Data.SortDesc') }
    ], [t]);

    const filterOptions = useMemo(() => [
        { key: 'all', label: t('Manager.Common.Filters.All') },
        { key: 'toExtract', label: t('Manager.Themes.Filters.ToExtract') },
        { key: 'partialFailed', label: t('Manager.Themes.Filters.PartialFailed') },
        { key: 'untranslated', label: t('Manager.Themes.Filters.Untranslated') },
        { key: 'translated', label: t('Manager.Themes.Filters.Translated') },
        { key: 'unapplied', label: t('Manager.Themes.Filters.Unapplied') },
        { key: 'applied', label: t('Manager.Themes.Filters.Applied') }
    ], [t]);

    useEffect(() => {
        const loadThemes = () => {
            try {
                // @ts-ignore
                const basePath = path.normalize(app.vault.adapter.getBasePath());
                const themesDir = path.join(basePath, '.obsidian', 'themes');

                if (!fs.existsSync(themesDir)) {
                    setThemes([]);
                    return;
                }

                const entries = fs.readdirSync(themesDir, { withFileTypes: true });
                const themeList: ThemeInfo[] = [];
                // @ts-ignore
                const currentTheme = app.customCss?.theme || '';

                for (const entry of entries) {
                    if (!entry.isDirectory()) continue;
                    const themeDir = path.join(themesDir, entry.name);
                    const manifestPath = path.join(themeDir, 'manifest.json');

                    let manifest: OBThemeManifest | null = null;
                    if (fs.existsSync(manifestPath)) {
                        try {
                            manifest = fs.readJsonSync(manifestPath);
                        } catch (e) {
                            // ignore invalid manifest
                        }
                    }

                    themeList.push({
                        name: entry.name,
                        manifest,
                        dir: themeDir,
                        isActive: entry.name === currentTheme,
                    });
                }

                setThemes(themeList);
            } catch (error) {
                console.error('[i18n] Failed to load themes:', error);
                setThemes([]);
            }
        };

        loadThemes();
    }, [app, refreshKey]);

    const sourceIndex = useMemo(() => {
        const byTheme: Record<string, any[]> = {};
        const activeByTheme: Record<string, string | null> = {};
        const allSources = i18n.sourceManager?.getAllSources() || [];

        for (const source of allSources) {
            if (!byTheme[source.plugin]) {
                byTheme[source.plugin] = [];
            }
            byTheme[source.plugin].push(source);
            if (source.isActive) {
                activeByTheme[source.plugin] = source.id;
            }
        }

        for (const themeName of Object.keys(byTheme)) {
            if (!activeByTheme[themeName] && byTheme[themeName].length > 0) {
                activeByTheme[themeName] = byTheme[themeName][0].id;
            }
        }

        return { byTheme, activeByTheme };
    }, [i18n.sourceManager, sourceTick]);

    const cloudEntriesByTheme = useMemo(() => {
        const grouped: Record<string, any[]> = {};
        for (const entry of cloudManifest) {
            if (entry.type !== 'theme') continue;
            if (!grouped[entry.plugin]) {
                grouped[entry.plugin] = [];
            }
            grouped[entry.plugin].push(entry);
        }
        return grouped;
    }, [cloudManifest]);

    const countPendingTranslationItems = useCallback((json: ThemeTranslationV1) => {
        if (!json?.dict) return 0;
        return json.dict.filter(item => shouldTranslateText(item.target, item.source)).length;
    }, []);

    const themeFailureRecords = useMemo(() => {
        return i18n.sourceManager.getBatchTaskFailures('theme');
    }, [i18n, sourceTick]);

    const failedSourceIds = useMemo(() => {
        return new Set(themeFailureRecords.map(record => record.sourceId));
    }, [themeFailureRecords]);

    const checkIsTranslated = useCallback((json: ThemeTranslationV1, sourceId: string | null) => {
        if (!json.dict || !sourceId || failedSourceIds.has(sourceId)) return false;
        return countPendingTranslationItems(json) === 0;
    }, [countPendingTranslationItems, failedSourceIds]);

    const allThemeStates = useMemo(() => {
        const stats: Record<string, ThemeItemData> = {};

        for (const theme of themes) {
            const themeDir = theme.dir;
            const themeCssPath = path.join(themeDir, 'theme.css');
            const sources = sourceIndex.byTheme[theme.name] || [];
            const activeSourceId = sourceIndex.activeByTheme[theme.name] || null;
            const translationPath = activeSourceId ? i18n.sourceManager.getSourceFilePath(activeSourceId) : '';
            const hasTranslation = !!translationPath && fs.existsSync(translationPath);
            const state = i18n.stateManager.getThemeState(theme.name);

            let isTranslated = false;
            let pendingTranslationCount = 0;
            let translationVersion = '';
            let supportedVersion = '';
            let description = '';

            if (hasTranslation && translationPath) {
                try {
                    const localJson = loadTranslationFile(translationPath) as ThemeTranslationV1;
                    pendingTranslationCount = countPendingTranslationItems(localJson);
                    isTranslated = checkIsTranslated(localJson, activeSourceId);
                    translationVersion = localJson.metadata.version;
                    supportedVersion = localJson.metadata.supportedVersions;
                    description = localJson.metadata.description;
                } catch (e) {
                    // ignore invalid translation
                }
            }

            let statusColor: string = 'bg-muted-foreground';
            let statusText: string = t('Manager.Themes.Status.ToExtract');
            let statusDesc: string = t('Manager.Plugins.Hints.NoTransDesc');
            const isApplied = !!(state && state.isApplied);
            const hasFailedBatches = !!activeSourceId && failedSourceIds.has(activeSourceId);

            if (isApplied && isTranslated) {
                statusColor = 'bg-green-500 dark:bg-green-600';
                statusText = t('Manager.Themes.Status.Applied');
            } else if (hasFailedBatches) {
                statusColor = 'bg-orange-500 dark:bg-orange-600';
                statusText = t('Manager.Themes.Status.PartialFailed', '部分失败');
            } else if (isTranslated) {
                statusColor = 'bg-blue-500 dark:bg-blue-600';
                statusText = t('Manager.Themes.Status.Unapplied');
            } else if (hasTranslation) {
                statusColor = 'bg-amber-500 dark:bg-amber-600';
                statusText = t('Manager.Themes.Status.Untranslated');
            }
            statusDesc = theme.manifest ? `v${theme.manifest.version}` : '';

            stats[theme.name] = {
                statusColor,
                statusText,
                statusDesc,
                hasTranslation,
                translationPath: translationPath || '',
                themeDir,
                themeCssPath,
                sources,
                activeSourceId,
                hasFailedBatches,
                isApplied,
                isTranslated,
                pendingTranslationCount,
                translationVersion,
                description,
                supportedVersion,
                cloudEntries: cloudEntriesByTheme[theme.name] || []
            };
        }

        return stats;
    }, [themes, i18n, refreshKey, sourceIndex, t, checkIsTranslated, countPendingTranslationItems, cloudEntriesByTheme, failedSourceIds]);

    const displayThemes = useMemo(() => {
        let result = [...themes];
        if (searchTerm) {
            result = result.filter(item => item.name.toLowerCase().includes(searchTerm.toLowerCase()));
        }

        if (statusFilter !== 'all') {
            result = result.filter(theme => {
                const data = allThemeStates[theme.name];
                if (!data) return false;

                switch (statusFilter) {
                    case 'applied':
                        return data.isApplied;
                    case 'unapplied':
                        return data.isTranslated && !data.isApplied;
                    case 'translated':
                        return data.isTranslated;
                    case 'untranslated':
                        return data.hasTranslation && !data.isTranslated && !data.hasFailedBatches;
                    case 'partialFailed':
                        return data.hasFailedBatches;
                    case 'toExtract':
                        return !data.hasTranslation;
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
    }, [themes, searchTerm, sortType, statusFilter, allThemeStates]);

    const extractableThemes = useMemo(() => {
        return displayThemes.filter(theme => !allThemeStates[theme.name]?.hasTranslation);
    }, [displayThemes, allThemeStates]);

    const translatableThemes = useMemo(() => {
        return displayThemes.filter(theme => {
            const data = allThemeStates[theme.name];
            return !!data?.hasTranslation && (data?.pendingTranslationCount || 0) > 0;
        });
    }, [displayThemes, allThemeStates]);

    const themeExtractCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(THEME_EXTRACT_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const themeTranslateCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(THEME_TRANSLATE_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const isAbortError = useCallback((error: unknown) => {
        return error instanceof Error && (error.name === 'AbortError' || error.message === '翻译任务已取消');
    }, []);

    const clearLocalSourcesForTheme = useCallback((themeName: string) => {
        i18n.sourceManager
            .getSourcesForPlugin(themeName)
            .filter(source => source.origin === 'local' && source.type === 'theme')
            .forEach(source => i18n.sourceManager.removeSource(source.id));
    }, [i18n]);

    const buildThemeSourceUpdate = useCallback((source: any, translationJson: ThemeTranslationV1) => ({
        ...source,
        title: translationJson.metadata?.title || source.title,
        origin: 'local',
        cloud: undefined,
        checksum: calculateChecksum(translationJson),
    }), []);

    const saveThemeExtractCheckpoint = useCallback((resources: ThemeBatchResource[], completedIndexes: Set<number>, completedResources: number, totalResources: number) => {
        i18n.sourceManager.saveBatchTaskCheckpoint(THEME_EXTRACT_CHECKPOINT_KEY, {
            scope: 'theme',
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

    const saveThemeTranslateCheckpoint = useCallback((resources: ThemeBatchResource[], startIndex: number, completedResources: number, totalResources: number, totalItems: number, processedItems: number) => {
        i18n.sourceManager.saveBatchTaskCheckpoint(THEME_TRANSLATE_CHECKPOINT_KEY, {
            scope: 'theme',
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

    const clearThemeFailuresForSource = useCallback((sourceId: string) => {
        const ids = i18n.sourceManager
            .getBatchTaskFailures('theme')
            .filter(item => item.sourceId === sourceId)
            .map(item => item.id);
        i18n.sourceManager.removeBatchTaskFailures(ids);
    }, [i18n]);

    const buildThemeFailureRecord = useCallback((failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>): BatchTaskFailureRecord => ({
        ...failure,
        id: `${failure.sourceId}:${failure.batchType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        scope: 'theme',
        failedAt: Date.now(),
    }), []);

    const recordThemeFailure = useCallback((failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>) => {
        i18n.sourceManager.saveBatchTaskFailure(buildThemeFailureRecord(failure));
    }, [buildThemeFailureRecord, i18n]);

    const handleRefresh = useCallback(() => {
        setRefreshKey(k => k + 1);
    }, []);

    const updateBatchTask = useCallback((updates: Partial<BatchTaskState>) => {
        setBatchTask(prev => ({ ...prev, ...updates }));
    }, []);

    const startThemeBatchExtract = useCallback(async (resume: boolean) => {
        const resources: ThemeBatchResource[] = resume && themeExtractCheckpoint?.resources.length
            ? themeExtractCheckpoint.resources.map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId,
            }))
            : extractableThemes.map(theme => ({ resourceId: theme.name, label: theme.name }));

        if (batchTask.isRunning || resources.length === 0) return;

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

        const extractConcurrency = getPositiveInt(i18n.settings.batchExtractConcurrency, 3);
        let processedResources = 0;
        let successCount = 0;
        let failedCount = 0;
        let skippedCount = 0;
        const completedIndexes = new Set<number>();
        const pendingEntries: Array<{ pluginId: string; content: ThemeTranslationV1; options: { title: string; type: 'theme' } }> = [];
        const themeMap = new Map(themes.map(theme => [theme.name, theme]));

        const flushPendingEntries = () => {
            if (pendingEntries.length === 0) return;
            i18n.sourceManager.batchExtractAndSaveSources(pendingEntries.splice(0, pendingEntries.length));
        };

        const markResourceDone = (index: number) => {
            completedIndexes.add(index);
        };

        const saveStopCheckpoint = () => {
            flushPendingEntries();
            saveThemeExtractCheckpoint(resources, completedIndexes, processedResources, resources.length);
        };

        const saveProgressCheckpoint = () => {
            flushPendingEntries();
            saveThemeExtractCheckpoint(resources, completedIndexes, processedResources, resources.length);
        };

        try {
            await runConcurrentTasks(resources, extractConcurrency, () => stopRequestedRef.current, async (resource, index) => {
                if (stopRequestedRef.current) return;

                const theme = themeMap.get(resource.resourceId);
                const data = allThemeStates[resource.resourceId];
                updateBatchTask({ currentLabel: resource.label });

                let shouldSaveCheckpoint = false;
                try {
                    if (!theme || !data || !await fs.pathExists(data.themeCssPath)) {
                        throw new Error(t('Manager.Themes.Errors.ThemeCssNotFound'));
                    }

                    const cssStr = await fs.readFile(data.themeCssPath, 'utf8');
                    const manifestPath = path.join(theme.dir, 'manifest.json');
                    let manifest: OBThemeManifest = { name: theme.name, version: '0.0.0', minAppVersion: '', author: '', authorUrl: '' };
                    if (await fs.pathExists(manifestPath)) {
                        try {
                            manifest = await fs.readJson(manifestPath);
                        } catch (e) {
                            // keep fallback manifest
                        }
                    }

                    await yieldToMainThread();
                    if (hasChineseText(`${manifest.name || theme.name}\n${cssStr}`)) {
                        flushPendingEntries();
                        clearLocalSourcesForTheme(theme.name);
                        skippedCount++;
                        shouldSaveCheckpoint = true;
                    } else {
                        const translationJson = generateTheme(manifest, cssStr, i18n.settings);
                        const extractedSources = getThemeTranslationSources(translationJson);
                        if (!hasExtractedTranslationContent(extractedSources)) {
                            skippedCount++;
                            shouldSaveCheckpoint = true;
                        } else {
                            pendingEntries.push({
                                pluginId: theme.name,
                                content: translationJson,
                                options: { title: theme.name, type: 'theme' }
                            });
                            successCount++;

                            if (pendingEntries.length >= Math.max(5, extractConcurrency * 2)) {
                                flushPendingEntries();
                            }
                        }
                    }
                } catch (error) {
                    failedCount++;
                    console.error(`[i18n] Failed to batch extract theme ${resource.resourceId}:`, error);
                }

                processedResources++;
                markResourceDone(index);
                if (shouldSaveCheckpoint) {
                    saveProgressCheckpoint();
                }
                updateBatchTask({ processedResources, successCount, failedCount, skippedCount });
            });

            if (stopRequestedRef.current) {
                saveStopCheckpoint();
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }

            flushPendingEntries();
            i18n.sourceManager.clearBatchTaskCheckpoint(THEME_EXTRACT_CHECKPOINT_KEY);
            handleRefresh();
            new Notice(t('Manager.Themes.Notices.BatchExtractComplete', { success: successCount, fail: failedCount, skip: skippedCount, defaultValue: `批量提取完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}` }));
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
    }, [allThemeStates, batchTask.isRunning, clearLocalSourcesForTheme, extractableThemes, handleRefresh, i18n, saveThemeExtractCheckpoint, t, themeExtractCheckpoint, themes, updateBatchTask]);

    const handleBatchExtract = useCallback(() => startThemeBatchExtract(false), [startThemeBatchExtract]);
    const handleResumeExtract = useCallback(() => startThemeBatchExtract(true), [startThemeBatchExtract]);

    const translateThemeSource = useCallback(async (
        translationJson: ThemeTranslationV1,
        context: { resourceId: string; resourceLabel: string; sourceId: string },
        onItemsProcessed: (count: number) => void,
        onBatchPersist: () => void,
        signal?: AbortSignal,
        onBatchFailure: (failure: Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>) => void = recordThemeFailure,
    ) => {
        const provider = createTranslationProvider();
        const items: ThemeTranslationItem[] = translationJson.dict
            .map((item, index) => ({
                id: index,
                type: item.type,
                source: item.source,
                target: item.target,
            }))
            .filter(item => shouldTranslateText(item.target, item.source));

        if (items.length === 0) {
            return;
        }

        await provider.themeTranslate(items, async (batchResult) => {
            for (const result of batchResult) {
                if (typeof result.id !== 'number') continue;
                const dictItem = translationJson.dict[result.id];
                if (!dictItem) continue;
                dictItem.target = result.target;
            }
            onItemsProcessed(batchResult.length);
            onBatchPersist();
        }, signal, async (batchItems, error) => {
            onBatchFailure({
                ...context,
                batchType: 'theme',
                errorMessage: error.message,
                items: batchItems.map(item => ({
                    source: item.source,
                    target: item.target,
                    dictIndex: item.id,
                    type: item.type,
                })).filter(item => item.dictIndex >= 0),
            });
        });
    }, [recordThemeFailure]);

    const startThemeBatchTranslate = useCallback(async (resume: boolean) => {
        const resources: ThemeBatchResource[] = resume && themeTranslateCheckpoint?.resources.length
            ? themeTranslateCheckpoint.resources.map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId,
            }))
            : translatableThemes.map(theme => ({
                resourceId: theme.name,
                label: theme.name,
                sourceId: allThemeStates[theme.name]?.activeSourceId,
            }));

        if (batchTask.isRunning || resources.length === 0) return;

        const totalItems = resources.reduce((sum, resource) => {
            return sum + (allThemeStates[resource.resourceId]?.pendingTranslationCount || 0);
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
            saveThemeTranslateCheckpoint(resources, nextCheckpointIndex, processedResources, resources.length, totalItems, processedItems);
        };

        try {
            await runConcurrentTasks(resources, translateConcurrency, () => stopRequestedRef.current || !!translateAbortControllerRef.current?.signal.aborted, async (resource, index) => {
                if (stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) return;

                const data = allThemeStates[resource.resourceId];
                updateBatchTask({ currentLabel: resource.label });

                try {
                    const sourceId = resource.sourceId || data?.activeSourceId;
                    if (!sourceId || !data?.translationPath) {
                        skippedCount++;
                    } else {
                        const source = i18n.sourceManager.getSource(sourceId);
                        const translationPath = i18n.sourceManager.getSourceFilePath(sourceId);
                        const translationJson = loadTranslationFile(translationPath) as ThemeTranslationV1 | null;
                        const pendingCount = translationJson ? countPendingTranslationItems(translationJson) : 0;

                        if (!source || !translationJson || pendingCount === 0) {
                            skippedCount++;
                        } else {
                            await yieldToMainThread();
                            const persistCurrentSource = () => {
                                i18n.sourceManager.saveSourceFile(source.id, translationJson);
                                i18n.sourceManager.saveSource(buildThemeSourceUpdate(source, translationJson));
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

                            await translateThemeSource(translationJson, {
                                resourceId: resource.resourceId,
                                resourceLabel: resource.label,
                                sourceId: source.id,
                            }, updateProcessedItems, scheduleCurrentSourcePersist, translateAbortControllerRef.current?.signal, (failure) => {
                                pendingFailures.push(buildThemeFailureRecord(failure));
                            });
                            flushCurrentSourcePersist();
                            persistCurrentSource();
                            clearThemeFailuresForSource(source.id);
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
                    console.error(`[i18n] Failed to batch translate theme ${resource.resourceId}:`, error);
                }

                updateBatchTask({ processedResources, processedItems, successCount, failedCount, skippedCount });
            });

            if (stopRequestedRef.current || translateAbortControllerRef.current?.signal.aborted) {
                saveStopCheckpoint();
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }

            flushPendingFailures();
            i18n.sourceManager.clearBatchTaskCheckpoint(THEME_TRANSLATE_CHECKPOINT_KEY);
            handleRefresh();
            new Notice(t('Manager.Themes.Notices.BatchTranslateComplete', { success: successCount, fail: failedCount, skip: skippedCount, defaultValue: `批量翻译完成：成功 ${successCount}，失败 ${failedCount}，跳过 ${skippedCount}` }));
        } catch (error) {
            console.error('[i18n] Batch theme translation failed:', error);
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
    }, [allThemeStates, batchTask.isRunning, buildThemeFailureRecord, buildThemeSourceUpdate, clearThemeFailuresForSource, countPendingTranslationItems, handleRefresh, i18n, isAbortError, saveThemeTranslateCheckpoint, t, themeTranslateCheckpoint, translatableThemes, translateThemeSource, updateBatchTask]);

    const handleBatchTranslate = useCallback(() => startThemeBatchTranslate(false), [startThemeBatchTranslate]);
    const handleResumeTranslate = useCallback(() => startThemeBatchTranslate(true), [startThemeBatchTranslate]);

    const handleStopBatchTask = useCallback(() => {
        stopRequestedRef.current = true;
        translateAbortControllerRef.current?.abort();
        setBatchTask(prev => ({ ...prev, currentLabel: t('Manager.Common.Status.Stopping', '正在停止') }));
    }, [t]);

    const handleRetryThemeFailures = useCallback(async () => {
        if (batchTask.isRunning || themeFailureRecords.length === 0) return;

        const retryConcurrency = getPositiveInt(i18n.settings.batchTranslateConcurrency, 2);
        const failureGroups = Array.from(themeFailureRecords.reduce((map, failure) => {
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
            totalResources: themeFailureRecords.length,
            processedItems: 0,
            totalItems: themeFailureRecords.reduce((sum, failure) => sum + failure.items.length, 0),
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
            let translationJson: ThemeTranslationV1 | null = null;
            try {
                source = i18n.sourceManager.getSource(firstFailure.sourceId);
                translationJson = i18n.sourceManager.readSourceFile(firstFailure.sourceId) as ThemeTranslationV1 | null;
            } catch (error) {
                console.error(`[i18n] Failed to load theme retry source ${firstFailure.sourceId}:`, error);
            }

            if (!source || !translationJson) {
                skippedCount += failures.length;
                markProcessedRecords(failures.length);
                return;
            }

            const activeSource = source;
            const activeTranslationJson = translationJson;
            const provider = createTranslationProvider();
            let sourceDirty = false;
            let lastPersistAt = 0;
            const attemptedRecordIds = new Set<string>();
            const failedRecordIds = new Set<string>();
            const recordTotalItems = new Map<string, number>();
            const recordSucceededItems = new Map<string, number>();

            const persistSource = () => {
                if (!sourceDirty) return;
                i18n.sourceManager.saveSourceFile(activeSource.id, activeTranslationJson);
                i18n.sourceManager.saveSource(buildThemeSourceUpdate(activeSource, activeTranslationJson));
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

            const items: ThemeTranslationItem[] = [];
            const mappings = new Map<number, { failureId: string; index: number }>();
            let nextItemId = 0;

            for (const failure of failures) {
                if (failure.batchType !== 'theme') {
                    skippedCount++;
                    continue;
                }

                let itemCount = 0;
                for (const item of failure.items) {
                    if (item.dictIndex < 0) {
                        failedRecordIds.add(failure.id);
                        continue;
                    }
                    const id = nextItemId++;
                    items.push({
                        id,
                        type: item.type,
                        source: item.source,
                        target: item.target,
                    });
                    mappings.set(id, { failureId: failure.id, index: item.dictIndex });
                    itemCount++;
                }
                addRecordItems(failure.id, itemCount);
                if (itemCount === 0) skippedCount++;
            }

            try {
                if (items.length > 0) {
                    await provider.themeTranslate(items, async (batchResult) => {
                        for (const result of batchResult) {
                            const mapping = mappings.get(result.id);
                            if (!mapping) continue;
                            const dictItem = activeTranslationJson.dict[mapping.index];
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
                            const mapping = mappings.get(item.id);
                            if (mapping) failedRecordIds.add(mapping.failureId);
                        }
                    });
                }
            } catch (error) {
                if (isAbortError(error)) {
                    stopRequestedRef.current = true;
                } else {
                    for (const id of attemptedRecordIds) failedRecordIds.add(id);
                    console.error(`[i18n] Failed to retry theme source ${firstFailure.sourceId}:`, error);
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
    }, [batchTask.isRunning, buildThemeSourceUpdate, handleRefresh, i18n, isAbortError, t, themeFailureRecords, updateBatchTask]);

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

    const rowCount = Math.ceil(displayThemes.length / columns);

    const rowVirtualizer = useVirtualizer({
        count: rowCount,
        getScrollElement: () => parentRef.current,
        estimateSize: useCallback(() => viewMode === 'list' ? 44 + 4 : 200 + 12, [viewMode]),
        getItemKey: useCallback((index: number) => `${viewMode}-${index}`, [viewMode]),
        overscan: 5,
    });

    const virtualItems = rowVirtualizer.getVirtualItems();

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
                            placeholder={t('Manager.Themes.Placeholders.SearchThemes')}
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="pl-8 h-9 rounded-none border-muted-foreground/20 focus:ring-1 text-[13px] bg-muted/10 shadow-sm transition-colors hover:bg-muted/20"
                        />
                    </div>

                    <div className="flex items-center gap-1 border border-muted-foreground/20 rounded-none p-0.5 h-9 bg-muted/20 shadow-sm">
                        <Button
                            variant={viewMode === 'list' ? 'secondary' : 'ghost'}
                            size="icon"
                            className="h-8 w-8 rounded-none transition-all"
                            onClick={() => setViewMode('list')}
                        >
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

                    <Select value={sortType} onValueChange={setSortType}>
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
                        {t('Manager.Common.Labels.ScopeHint', { count: displayThemes.length, defaultValue: `当前筛选范围：${displayThemes.length} 项` })}
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
                        {!batchTask.isRunning && (themeExtractCheckpoint?.resources?.length ?? 0) > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleResumeExtract}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.ResumeExtract', '继续提取')}
                                <span className="text-muted-foreground">{themeExtractCheckpoint?.resources?.length ?? 0}</span>
                            </Button>
                        )}
                        {!batchTask.isRunning && (themeTranslateCheckpoint?.resources?.length ?? 0) > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleResumeTranslate}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.ResumeTranslate', '继续翻译')}
                                <span className="text-muted-foreground">{themeTranslateCheckpoint?.resources?.length ?? 0}</span>
                            </Button>
                        )}
                        {!batchTask.isRunning && themeFailureRecords.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-9 rounded-none gap-1.5 text-[13px]"
                                onClick={handleRetryThemeFailures}
                            >
                                <RotateCcw className="w-4 h-4" />
                                {t('Manager.Common.Actions.RetryFailures', '重试失败批次')}
                                <span className="text-muted-foreground">{themeFailureRecords.length}</span>
                            </Button>
                        )}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-9 rounded-none gap-1.5 text-[13px]"
                            onClick={handleBatchExtract}
                            disabled={batchTask.isRunning || extractableThemes.length === 0}
                        >
                            {batchTask.isRunning && batchTask.mode === 'extract' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileOutput className="w-4 h-4" />}
                            {t('Manager.Common.Actions.BatchExtract', '批量提取')}
                            <span className="text-muted-foreground">{extractableThemes.length}</span>
                        </Button>
                        <Button
                            variant="default"
                            size="sm"
                            className="h-9 rounded-none gap-1.5 text-[13px]"
                            onClick={handleBatchTranslate}
                            disabled={batchTask.isRunning || translatableThemes.length === 0}
                        >
                            {batchTask.isRunning && batchTask.mode === 'translate' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
                            {t('Manager.Common.Actions.BatchTranslate', '批量翻译')}
                            <span className="text-primary-foreground/80">{translatableThemes.length}</span>
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
                    <div
                        className={cn(
                            'gap-2 w-full overflow-hidden relative',
                            viewMode === 'grid' ? 'grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))]' : 'flex flex-col'
                        )}
                        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                    >
                        {virtualItems.map((virtualRow) => {
                            const startIndex = virtualRow.index * columns;
                            const itemsInRow = displayThemes.slice(startIndex, startIndex + columns);

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
                                    {itemsInRow.map((theme) => (
                                        <ThemeItem
                                            key={theme.name}
                                            theme={theme}
                                            i18n={i18n}
                                            data={allThemeStates[theme.name]}
                                            refreshParent={handleRefresh}
                                            viewMode={viewMode}
                                        />
                                    ))}
                                </div>
                            );
                        })}
                        {displayThemes.length === 0 && (
                            <div className="text-center text-muted-foreground py-8 col-span-full">
                                {t('Manager.Themes.Status.NoThemes')}
                            </div>
                        )}
                    </div>
                </div>
            </ScrollArea>
        </div>
    );
};
