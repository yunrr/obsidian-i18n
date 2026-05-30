import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as path from 'path';
import * as fs from 'fs-extra';
import { useTranslation } from 'react-i18next';
import { Notice } from 'obsidian';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Search, LayoutGrid, List, FileOutput, Languages, Loader2, RotateCcw, Square, AlertTriangle } from 'lucide-react';

import I18N from 'src/main';
import { OBThemeManifest, ThemeTranslationV1, BatchTaskFailureRecord } from 'src/types';
import { useGlobalStoreInstance } from '~/utils/store/global';
import { loadTranslationFile } from '../../manager/io-manager';
import { normalizeOpenAIUrl } from '~/utils/ai/url-helper';
import { LLM_PROVIDERS } from '~/ai/constants';
import {
    DEFAULT_AST_PROMPT_TEMPLATE,
    DEFAULT_REGEX_PROMPT_TEMPLATE,
    DEFAULT_THEME_PROMPT_TEMPLATE,
    generateAstSystemPrompt,
    generateRegexSystemPrompt,
    generateThemeSystemPrompt,
} from '~/ai/prompts';
import type {
    CompanionExtractionSettings,
    CompanionTaskProgress,
    CompanionThemeBatchExtractPayload,
    CompanionThemeBatchTranslatePayload,
    CompanionThemeFailureRetryPayload,
    CompanionTranslationConfig,
} from '~/manager/companion-worker-manager';

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
    themeCssPath?: string;
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

const SOURCE_SYNC_THROTTLE_MS = 1500;

const shouldTranslateText = (target?: string, source?: string) => !target || target.trim() === '' || target === source;
const getPositiveInt = (value: unknown, fallback: number) => {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
};

const getActiveLLMProfile = (settings: I18N['settings']) => {
    const config = LLM_PROVIDERS[settings.llmApi];
    if (!config) return null;
    const profiles = (settings as any)[`llm${config.labelKey}Profiles`] as any[];
    const activeId = (settings as any)[`llm${config.labelKey}ActiveProfileId`] as string;
    return profiles?.find(profile => profile.id === activeId) || profiles?.[0] || null;
};

const getCompanionTranslationConfig = (settings: I18N['settings']): CompanionTranslationConfig => {
    const provider = LLM_PROVIDERS[settings.llmApi];
    const activeProfile = getActiveLLMProfile(settings);
    if (!provider || provider.engine !== 'openai' || !activeProfile) {
        throw new Error('本地批量 worker 仅支持 OpenAI 兼容服务');
    }

    const rawUrl = normalizeOpenAIUrl(activeProfile.url || provider.baseUrl || '');
    if (!rawUrl) throw new Error('Missing OpenAI compatible API URL');

    return {
        chatCompletionsUrl: `${rawUrl.replace(/\/+$/, '')}/chat/completions`,
        apiKey: activeProfile.key,
        model: activeProfile.model || provider.defaultModel,
        timeoutMs: settings.llmTimeout || 60000,
        responseFormat: settings.llmResponseFormat,
        batchSize: getPositiveInt(settings.llmBatchSize, 1),
        overwriteExistingTranslations: settings.llmOverwriteExistingTranslations === true,
        concurrency: getPositiveInt(settings.llmConcurrencyLimit, 3),
        prompts: {
            ast: generateAstSystemPrompt(settings.llmAstPrompt || DEFAULT_AST_PROMPT_TEMPLATE, settings.llmLanguage, settings.llmStyle),
            regex: generateRegexSystemPrompt(settings.llmRegexPrompt || DEFAULT_REGEX_PROMPT_TEMPLATE, settings.llmLanguage, settings.llmStyle),
            theme: generateThemeSystemPrompt(settings.llmThemePrompt || DEFAULT_THEME_PROMPT_TEMPLATE, settings.llmLanguage, settings.llmStyle),
        },
    };
};

const getCompanionExtractionSettings = (settings: I18N['settings']): CompanionExtractionSettings => ({
    author: settings.author,
    reFlags: settings.reFlags,
    reLength: settings.reLength,
    reDatas: settings.reDatas,
    reRejectRe: settings.reRejectRe,
    reValidRe: settings.reValidRe,
    chineseSkipMode: settings.chineseSkipMode || 'source',
    astAssignments: settings.astAssignments,
    astFunctions: settings.astFunctions,
    astKeys: settings.astKeys,
    astMaxLength: settings.astMaxLength ?? 300,
    astRejectRe: settings.astRejectRe,
    astValidRe: settings.astValidRe,
});

const formatFailureTime = (failedAt: number) => failedAt ? new Date(failedAt).toLocaleString() : '';

const BatchFailureDetails: React.FC<{ records: BatchTaskFailureRecord[]; title: string }> = ({ records, title }) => {
    if (records.length === 0) return null;

    return (
        <div className="border border-destructive/30 bg-destructive/5 rounded-none px-3 py-2 space-y-2">
            <div className="flex items-center gap-2 text-[12px] font-medium text-destructive">
                <AlertTriangle className="w-4 h-4" />
                <span>{title}</span>
                <span className="text-muted-foreground">{records.length}</span>
            </div>
            <div className="max-h-48 overflow-auto space-y-2 pr-1">
                {records.map(record => (
                    <div key={record.id} className="border border-muted-foreground/20 bg-background/70 rounded-none p-2 text-[11px] space-y-1">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <span className="font-medium text-foreground">{record.resourceLabel || record.resourceId}</span>
                            <span className="text-muted-foreground">{record.batchType}</span>
                            <span className="text-muted-foreground">{record.items.length} 条</span>
                            <span className="text-muted-foreground">{formatFailureTime(record.failedAt)}</span>
                        </div>
                        <div className="text-destructive break-words whitespace-pre-wrap">{record.errorMessage}</div>
                        {record.items[0]?.source && (
                            <div className="text-muted-foreground break-words line-clamp-2">{record.items[0].source}</div>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
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
    const [showFailureDetails, setShowFailureDetails] = useState(false);
    const taskIdRef = useRef<string | null>(null);
    const syncRevisionRef = useRef({ sourceRevision: 0, recordRevision: 0 });
    const lastSourceSyncAtRef = useRef(0);

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
        let disposed = false;
        const loadThemes = async () => {
            const fallbackLoadThemes = () => {
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
                            }
                        }

                        themeList.push({
                            name: entry.name,
                            manifest,
                            dir: themeDir,
                            themeCssPath: path.join(themeDir, 'theme.css'),
                            isActive: entry.name === currentTheme,
                        });
                    }

                    setThemes(themeList);
                } catch (error) {
                    console.error('[i18n] Failed to load themes:', error);
                    setThemes([]);
                }
            };

            try {
                const discovered = await i18n.companionWorkerManager.discoverThemes();
                if (disposed) return;
                // @ts-ignore
                const currentTheme = app.customCss?.theme || '';
                setThemes(discovered.map(theme => ({
                    name: theme.name,
                    manifest: theme.manifest,
                    dir: theme.dir,
                    themeCssPath: theme.themeCssPath,
                    isActive: theme.name === currentTheme,
                })));
            } catch (error) {
                console.warn('[i18n] Failed to load themes from worker, falling back to filesystem scan:', error);
                if (!disposed) fallbackLoadThemes();
            }
        };

        loadThemes();
        return () => { disposed = true; };
    }, [app, refreshKey, i18n]);

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

    const countTranslationItems = useCallback((json: ThemeTranslationV1) => {
        return json?.dict?.length || 0;
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
            const themeCssPath = theme.themeCssPath || path.join(themeDir, 'theme.css');
            const sources = sourceIndex.byTheme[theme.name] || [];
            const activeSourceId = sourceIndex.activeByTheme[theme.name] || null;
            const translationPath = activeSourceId ? i18n.sourceManager.getSourceFilePath(activeSourceId) : '';
            const hasTranslation = !!translationPath && fs.existsSync(translationPath);
            const state = i18n.stateManager.getThemeState(theme.name);

            let isTranslated = false;
            let pendingTranslationCount = 0;
            let totalTranslationCount = 0;
            let translationVersion = '';
            let supportedVersion = '';
            let description = '';

            if (hasTranslation && translationPath) {
                try {
                    const localJson = loadTranslationFile(translationPath) as ThemeTranslationV1;
                    pendingTranslationCount = countPendingTranslationItems(localJson);
                    totalTranslationCount = countTranslationItems(localJson);
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
                totalTranslationCount,
                translationVersion,
                description,
                supportedVersion,
                cloudEntries: cloudEntriesByTheme[theme.name] || []
            };
        }

        return stats;
    }, [themes, i18n, refreshKey, sourceIndex, t, checkIsTranslated, countPendingTranslationItems, countTranslationItems, cloudEntriesByTheme, failedSourceIds]);

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
            if (!data?.hasTranslation) return false;
            return i18n.settings.llmOverwriteExistingTranslations === true
                ? (data?.totalTranslationCount || 0) > 0
                : (data?.pendingTranslationCount || 0) > 0;
        });
    }, [displayThemes, allThemeStates, i18n.settings.llmOverwriteExistingTranslations]);

    const themeExtractCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(THEME_EXTRACT_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const themeTranslateCheckpoint = useMemo(() => {
        return i18n.sourceManager.loadBatchTaskCheckpoint(THEME_TRANSLATE_CHECKPOINT_KEY);
    }, [i18n, sourceTick]);

    const handleRefresh = useCallback(() => {
        setRefreshKey(k => k + 1);
    }, []);

    const syncSourceStateFromDisk = useCallback(() => {
        lastSourceSyncAtRef.current = Date.now();
        i18n.sourceManager.reloadFromDisk();
        handleRefresh();
    }, [handleRefresh, i18n]);

    const syncWorkerProgress = useCallback((progress: CompanionTaskProgress) => {
        setBatchTask({
            mode: progress.mode,
            isRunning: progress.status === 'queued' || progress.status === 'running',
            currentLabel: progress.currentLabel,
            processedResources: progress.processedResources,
            totalResources: progress.totalResources,
            processedItems: progress.processedItems,
            totalItems: progress.totalItems,
            successCount: progress.successCount,
            failedCount: progress.failedCount,
            skippedCount: progress.skippedCount,
        });

        const revisions = syncRevisionRef.current;
        const hasRevisionChange = progress.sourceRevision !== revisions.sourceRevision || progress.recordRevision !== revisions.recordRevision;
        if (!hasRevisionChange) return;

        revisions.sourceRevision = progress.sourceRevision;
        revisions.recordRevision = progress.recordRevision;
        if (Date.now() - lastSourceSyncAtRef.current >= SOURCE_SYNC_THROTTLE_MS) {
            syncSourceStateFromDisk();
        }
    }, [syncSourceStateFromDisk]);

    const runWorkerTask = useCallback(async (type: 'theme-batch-extract' | 'theme-batch-translate' | 'theme-failure-retry', payload: unknown) => {
        const started = await i18n.companionWorkerManager.startTask(type, payload);
        taskIdRef.current = started.taskId;
        syncRevisionRef.current = { sourceRevision: 0, recordRevision: 0 };
        lastSourceSyncAtRef.current = 0;
        syncWorkerProgress(started.progress);

        let progress = started.progress;
        while (progress.status === 'queued' || progress.status === 'running') {
            await new Promise(resolve => window.setTimeout(resolve, 150));
            const status = await i18n.companionWorkerManager.getTaskStatus(started.taskId);
            progress = status.progress;
            syncWorkerProgress(progress);
        }

        taskIdRef.current = null;
        syncSourceStateFromDisk();

        if (progress.status === 'failed') throw new Error(progress.error || '本地伴生任务失败');
        return progress;
    }, [i18n, syncSourceStateFromDisk, syncWorkerProgress]);

    const startThemeBatchExtract = useCallback(async (resume: boolean) => {
        const resources: ThemeBatchResource[] = resume && themeExtractCheckpoint?.resources.length
            ? themeExtractCheckpoint.resources.map(resource => ({
                resourceId: resource.resourceId,
                label: resource.label,
                sourceId: resource.sourceId,
            }))
            : extractableThemes.map(theme => ({ resourceId: theme.name, label: theme.name }));

        const completedResources = resume ? themeExtractCheckpoint?.completedResources || 0 : 0;
        const totalResources = resume ? themeExtractCheckpoint?.totalResources || resources.length : resources.length;

        if (batchTask.isRunning || resources.length === 0) return;

        const themeMap = new Map(themes.map(theme => [theme.name, theme]));
        const workerResources = resources.flatMap(resource => {
            const theme = themeMap.get(resource.resourceId);
            const data = allThemeStates[resource.resourceId];
            if (!theme || !data) return [];
            return [{
                resourceId: resource.resourceId,
                label: resource.label,
                themeName: theme.name,
                themeDir: theme.dir,
                themeCssPath: data.themeCssPath,
            }];
        });

        if (workerResources.length === 0) {
            new Notice(t('Manager.Themes.Errors.ThemeCssNotFound'));
            return;
        }

        const skippedResumeResources = Math.max(0, resources.length - workerResources.length);
        const displayedCompletedResources = resume ? completedResources + skippedResumeResources : completedResources;
        const displayedTotalResources = resume ? totalResources : workerResources.length;

        setBatchTask({
            mode: 'extract',
            isRunning: true,
            currentLabel: '',
            processedResources: displayedCompletedResources,
            totalResources: displayedTotalResources,
            processedItems: 0,
            totalItems: 0,
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
        });

        try {
            const payload: CompanionThemeBatchExtractPayload = {
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                resources: workerResources,
                settings: getCompanionExtractionSettings(i18n.settings),
                concurrency: getPositiveInt(i18n.settings.batchExtractConcurrency, 3),
                checkpointKey: THEME_EXTRACT_CHECKPOINT_KEY,
                completedResources: displayedCompletedResources,
                totalResources: displayedTotalResources,
            };
            const progress = await runWorkerTask('theme-batch-extract', payload);
            if (progress.status === 'cancelled') {
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }
            new Notice(t('Manager.Themes.Notices.BatchExtractComplete', { success: progress.successCount, fail: progress.failedCount, skip: progress.skippedCount, defaultValue: `批量提取完成：成功 ${progress.successCount}，失败 ${progress.failedCount}，跳过 ${progress.skippedCount}` }));
        } catch (error) {
            console.error('[i18n] Batch theme extraction failed:', error);
            new Notice(t('Common.Notices.TranslateFail', { message: String(error) }));
        } finally {
            taskIdRef.current = null;
            setBatchTask(prev => ({ ...prev, isRunning: false, currentLabel: '' }));
        }
    }, [allThemeStates, batchTask.isRunning, extractableThemes, i18n, runWorkerTask, t, themeExtractCheckpoint, themes]);

    const handleBatchExtract = useCallback(() => startThemeBatchExtract(false), [startThemeBatchExtract]);
    const handleResumeExtract = useCallback(() => startThemeBatchExtract(true), [startThemeBatchExtract]);

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

        const completedResources = resume ? themeTranslateCheckpoint?.completedResources || 0 : 0;
        const totalResources = resume ? themeTranslateCheckpoint?.totalResources || resources.length : resources.length;
        const processedItems = resume ? themeTranslateCheckpoint?.processedItems || 0 : 0;
        const totalItems = resume ? themeTranslateCheckpoint?.totalItems || resources.reduce((sum, resource) => {
            const data = allThemeStates[resource.resourceId];
            return sum + (i18n.settings.llmOverwriteExistingTranslations === true ? data?.totalTranslationCount || 0 : data?.pendingTranslationCount || 0);
        }, 0) : resources.reduce((sum, resource) => {
            const data = allThemeStates[resource.resourceId];
            return sum + (i18n.settings.llmOverwriteExistingTranslations === true ? data?.totalTranslationCount || 0 : data?.pendingTranslationCount || 0);
        }, 0);

        setBatchTask({
            mode: 'translate',
            isRunning: true,
            currentLabel: '',
            processedResources: completedResources,
            totalResources,
            processedItems,
            totalItems,
            successCount: 0,
            failedCount: 0,
            skippedCount: 0,
        });

        try {
            const payload: CompanionThemeBatchTranslatePayload = {
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                resources,
                config: getCompanionTranslationConfig(i18n.settings),
                checkpointKey: THEME_TRANSLATE_CHECKPOINT_KEY,
                concurrency: getPositiveInt(i18n.settings.batchTranslateConcurrency, 2),
                completedResources,
                totalResources,
                processedItems,
                totalItems,
            };
            const progress = await runWorkerTask('theme-batch-translate', payload);
            if (progress.status === 'cancelled') {
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }
            new Notice(t('Manager.Themes.Notices.BatchTranslateComplete', { success: progress.successCount, fail: progress.failedCount, skip: progress.skippedCount, defaultValue: `批量翻译完成：成功 ${progress.successCount}，失败 ${progress.failedCount}，跳过 ${progress.skippedCount}` }));
        } catch (error) {
            console.error('[i18n] Batch theme translation failed:', error);
            new Notice(t('Common.Notices.TranslateFail', { message: String(error) }));
        } finally {
            taskIdRef.current = null;
            setBatchTask(prev => ({ ...prev, isRunning: false, currentLabel: '' }));
        }
    }, [allThemeStates, batchTask.isRunning, i18n, runWorkerTask, t, themeTranslateCheckpoint, translatableThemes]);

    const handleBatchTranslate = useCallback(() => startThemeBatchTranslate(false), [startThemeBatchTranslate]);
    const handleResumeTranslate = useCallback(() => startThemeBatchTranslate(true), [startThemeBatchTranslate]);

    const handleStopBatchTask = useCallback(() => {
        const taskId = taskIdRef.current;
        if (taskId) {
            i18n.companionWorkerManager.cancelTask(taskId)
                .then(({ progress }) => syncWorkerProgress(progress))
                .catch(error => console.warn('[i18n] Failed to cancel companion task:', error));
        }
        setBatchTask(prev => ({ ...prev, currentLabel: t('Manager.Common.Status.Stopping', '正在停止') }));
    }, [i18n, syncWorkerProgress, t]);

    const handleRetryThemeFailures = useCallback(async () => {
        if (batchTask.isRunning || themeFailureRecords.length === 0) return;

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

        try {
            const payload: CompanionThemeFailureRetryPayload = {
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                failures: themeFailureRecords,
                config: getCompanionTranslationConfig(i18n.settings),
                concurrency: getPositiveInt(i18n.settings.batchTranslateConcurrency, 2),
            };
            const progress = await runWorkerTask('theme-failure-retry', payload);
            if (progress.status === 'cancelled') {
                new Notice(t('Common.Notices.TaskStopped'));
                return;
            }
            new Notice(t('Manager.Common.Notices.RetryFailuresComplete', { success: progress.successCount, fail: progress.failedCount, skip: progress.skippedCount, defaultValue: `失败批次重试完成：成功 ${progress.successCount}，失败 ${progress.failedCount}，跳过 ${progress.skippedCount}` }));
        } catch (error) {
            console.error('[i18n] Failed to retry theme failures:', error);
            new Notice(t('Common.Notices.TranslateFail', { message: String(error) }));
        } finally {
            taskIdRef.current = null;
            setBatchTask(prev => ({ ...prev, isRunning: false, currentLabel: '' }));
        }
    }, [batchTask.isRunning, i18n, runWorkerTask, t, themeFailureRecords]);

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
                                onClick={() => setShowFailureDetails(prev => !prev)}
                            >
                                <AlertTriangle className="w-4 h-4" />
                                {showFailureDetails ? '隐藏失败原因' : '失败原因'}
                                <span className="text-muted-foreground">{themeFailureRecords.length}</span>
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

                {!batchTask.isRunning && showFailureDetails && (
                    <BatchFailureDetails records={themeFailureRecords} title="主题失败原因" />
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
