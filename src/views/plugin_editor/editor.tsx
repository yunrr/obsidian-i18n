import React, { useEffect, useRef, useState, useMemo } from 'react';
import * as path from 'path';
import * as fs from 'fs-extra';
import { ItemView, WorkspaceLeaf } from 'obsidian';
import { Root } from 'react-dom/client';

import { PluginTranslationV1Regex } from 'src/types';
import I18N from "src/main";

import { Button, Tabs, TabsContent, TabsList, TabsTrigger, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, Input, Label, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, Card, Badge, ResizablePanelGroup, ResizablePanel, ResizableHandle, ScrollArea } from '~/shadcn';
import { Save, Loader2, Plus, Trash2, ChevronDown, Folder, File, Info, Calendar, Hash, ChevronRight } from 'lucide-react';
import { useRegexStore } from './store';

import { EditorProps, DiagnoseError } from './types';
import { RegexEditor, AstEditor } from '.';

import { useGlobalStoreInstance } from '~/utils/store/global';
import { mountReactView } from '~/utils/core/react';
import { StringPicker } from '~/utils/ui/string-picker';
import { mergeAstItems, mergeRegexItems } from '@/src/utils/translator/light';
import { getEffectiveExtractionSettings } from '@/src/utils/translator/config';
import { createTranslationProvider } from '~/ai/provider-factory';

import { useTranslation } from 'react-i18next';
import { t as gt } from 'src/locales';

import { useAstTranslation } from './components/ast/use-ast-translation';
import { useRegexTranslation } from './components/regex/use-regex-translation';
import { MetadataCard } from './components/common/metadata-card';
import { AstSidebar } from './components/ast/ast-sidebar';
import { RegexSidebar } from './components/regex/regex-sidebar';
import { TemplateCard } from './components/common/template-card';
import { saveCurrentPluginEditorTranslation } from './save-current-translation';

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

    // Lifted Sidebar Tab State (Syncs across Views)
    const [activeSidebarTab, setActiveSidebarTab] = React.useState('overview');

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
    const [isSaving, setIsSaving] = useState(false);
    const [isDiagnosing, setIsDiagnosing] = useState(false);
    const [isUnusedScan, setIsUnusedScan] = useState(false);
    const [isSecurityScan, setIsSecurityScan] = useState(false);
    const [errorItems, setErrorItems] = useState<DiagnoseError[]>([]);
    const [hasChecked, setHasChecked] = useState(false);
    const [activeTab, setActiveTab] = useState('ast');
    const [isAddPathDialogOpen, setIsAddPathDialogOpen] = useState(false);
    const [newPathInput, setNewPathInput] = useState('');

    const getExtractionSettings = React.useCallback(() => getEffectiveExtractionSettings(i18n.settings), [i18n.settings]);

    const validateSecurityText = React.useCallback((target: string) => {
        const issues: { severity: 'critical' | 'warning'; message: string }[] = [];
        if (!target) return issues;
        const critical = [/\beval\s*\(/i, /\bFunction\s*\(/i, /\bsetTimeout\s*\(\s*['"`]/i, /\bsetInterval\s*\(\s*['"`]/i, /<script/i, /\bjavascript:/i];
        const warning = [/\bfetch\s*\(/i, /\bXMLHttpRequest\b/i, /\bWebSocket\b/i, /\brequire\s*\(/i, /\bprocess\./i, /\belectron\./i, /\blocalStorage\b/i, /\bdocument\.cookie\b/i];
        for (const regex of critical) if (regex.test(target)) issues.push({ severity: 'critical', message: `发现危险的执行指令: ${regex}` });
        for (const regex of warning) if (regex.test(target)) issues.push({ severity: 'warning', message: `发现可疑的代码模式: ${regex}` });
        return issues;
    }, []);


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
    const handleDiagnose = React.useCallback(async () => {
        if (isDiagnosing) return;
        setIsDiagnosing(true);
        setErrorItems([]);
        setHasChecked(true);
        try {
            await save(true);
            const { metadata } = useRegexStore.getState();
            if (!metadata) {
                notice.error(t('Editor.Errors.NoMetadata'));
                return;
            }

            const pluginId = metadata.plugin;
            const state = i18n.stateManager.getPluginState(pluginId);
            const isApplied = !!(state && state.isApplied);
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

            // @ts-ignore
            const pluginsApi = i18n.app.plugins;
            const wasEnabled = pluginsApi.enabledPlugins.has(pluginId);
            const applyAst = i18n.settings.applyAstTranslations !== false;
            const applyRegex = i18n.settings.applyRegexTranslations !== false;
            // @ts-ignore
            const backupBasePath = path.join(basePath, i18n.manifest.dir || '');

            const runProbe = async (probe: { files: Array<{ file: string; code: string }> }) => {
                const originals = new Map<string, string | null>();
                let success = false;
                let error = '';
                try {
                    for (const file of probe.files) {
                        const targetPath = path.join(pluginDir, file.file);
                        originals.set(file.file, fs.existsSync(targetPath) ? fs.readFileSync(targetPath, 'utf8') : null);
                        fs.ensureDirSync(path.dirname(targetPath));
                        fs.writeFileSync(targetPath, file.code, 'utf8');
                    }

                    if (pluginsApi.enabledPlugins.has(pluginId)) {
                        await pluginsApi.disablePlugin(pluginId);
                    }
                    await pluginsApi.enablePlugin(pluginId);
                    success = pluginsApi.enabledPlugins.has(pluginId) && !!pluginsApi.plugins[pluginId];
                } catch (e) {
                    success = false;
                    error = String(e);
                } finally {
                    for (const [file, content] of originals) {
                        const targetPath = path.join(pluginDir, file);
                        if (content === null) {
                            if (fs.existsSync(targetPath)) fs.removeSync(targetPath);
                        } else {
                            fs.writeFileSync(targetPath, content, 'utf8');
                        }
                    }
                    try {
                        if (pluginsApi.enabledPlugins.has(pluginId)) {
                            await pluginsApi.disablePlugin(pluginId);
                        }
                        if (wasEnabled) {
                            await pluginsApi.enablePlugin(pluginId);
                        }
                    } catch (restoreError) {
                        console.error('[i18n] Failed to restore plugin state after diagnose probe:', restoreError);
                    }
                }
                return { success, error };
            };

            let response = await i18n.companionWorkerManager.startPluginDiagnoseCleanup({
                pluginId,
                pluginDir,
                backupBasePath,
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                translationSourceId: activeSourceId,
                applyAst,
                applyRegex,
                runtimeProbe: true,
                isApplied,
            });

            while (response.status === 'probe' && response.sessionId && response.probe) {
                const probeResult = await runProbe(response.probe);
                response = await i18n.companionWorkerManager.stepPluginDiagnoseCleanup({
                    sessionId: response.sessionId,
                    probeId: response.probe.probeId,
                    success: probeResult.success,
                    error: probeResult.error,
                });
            }

            i18n.sourceManager.reloadFromDisk();
            const cleaned = i18n.sourceManager.readSourceFile(activeSourceId);
            if (cleaned?.dict) {
                useGlobalStoreInstance.setState({ editorPluginTranslation: cleaned });
                useRegexStore.setState({ currentFile: '' });
                setDictData(cleaned.dict);
                const nextFile = cleaned.dict['main.js'] ? 'main.js' : Object.keys(cleaned.dict)[0] || '';
                if (nextFile) setCurrentFile(nextFile);
            }

            const results: DiagnoseError[] = (response.removedItems || []).map((item) => ({
                type: item.kind,
                id: item.index,
                source: item.source,
                message: item.reason,
                severity: 'error',
            }));
            setErrorItems(results);
            if (response.status === 'baselineFailed') {
                notice.warning(t('Editor.Notices.DiagnosisRuntimeBaselineFailed'));
            } else if (results.length === 0) {
                notice.success(t('Editor.Notices.DiagnosisSuccess'));
            } else {
                notice.error(t('Editor.Notices.DiagnosisCleanupRemoved', { count: results.length }));
            }
            if (response.status === 'baselineFailed' && results.length > 0) {
                notice.error(t('Editor.Notices.DiagnosisCleanupRemoved', { count: results.length }));
            }
        } catch (e) {
            notice.error(t('Common.Status.Failure') + ' ' + t('Editor.Notices.DiagnosisSuccess') + ': ' + e);
        } finally {
            setIsDiagnosing(false);
        }
    }, [i18n, notice, t, isDiagnosing, save, setDictData, setCurrentFile]);

    const handleSecurityDiagnose = React.useCallback(async () => {
        if (isDiagnosing) return;
        setIsDiagnosing(true);
        setIsUnusedScan(false);
        setIsSecurityScan(true);
        setErrorItems([]);
        setHasChecked(true);

        try {
            const { regexItems, astItems } = useRegexStore.getState();
            const results: DiagnoseError[] = [];

            // 1. 扫描 AST 条目
            for (const item of astItems) {
                const target = item.target || '';
                const issues = validateSecurityText(target);
                for (const issue of issues) {
                    results.push({
                        type: 'ast',
                        id: item.id as any,
                        source: target,
                        severity: issue.severity,
                        message: issue.message
                    });
                }
            }

            // 2. 扫描 Regex 条目
            for (const item of regexItems) {
                const source = item.source || '';
                const target = item.target || '';
                const issues = validateSecurityText(target);
                for (const issue of issues) {
                    results.push({
                        type: 'regex',
                        id: item.id,
                        source: target,
                        severity: issue.severity,
                        message: issue.message
                    });
                }
            }

            setErrorItems(results);
            if (results.length === 0) {
                notice.success(t('Editor.Notices.DiagnosisSuccess'));
            } else {
                notice.error(t('Editor.Errors.SecurityRiskTotal', { count: results.length }));
            }
        } catch (e) {
            notice.error(t('Common.Status.Failure') + ': ' + e);
        } finally {
            setIsDiagnosing(false);
        }
    }, [notice, t, isDiagnosing, validateSecurityText]);

    const handleUnusedDiagnose = React.useCallback(async () => {
        if (isDiagnosing) return;
        setIsDiagnosing(true);
        setIsUnusedScan(true);
        setIsSecurityScan(false);
        setErrorItems([]);
        setHasChecked(true);

        try {
            const { regexItems, astItems, metadata, currentFile, sourceCache, setSourceCache } = useRegexStore.getState();
            if (!metadata) {
                notice.error(t('Editor.Errors.NoMetadata'));
                return;
            }

            const pluginId = metadata.plugin;

            if (!currentFile || !currentFile.endsWith('.js')) {
                notice.info(t('Editor.Errors.NotJs'));
                return;
            }

            // 获取源代码 (逻辑同 handleDiagnose)
            const state = i18n.stateManager.getPluginState(pluginId);
            const isApplied = !!(state && state.isApplied);
            let originalCode: string | null = sourceCache[currentFile];
            if (!originalCode) {
                if (!isApplied) {
                    try {
                        // @ts-ignore
                        const manifest = i18n.app.plugins.manifests[pluginId];
                        if (manifest) {
                            // @ts-ignore
                            const basePath = path.normalize(i18n.app.vault.adapter.getBasePath());
                            const pluginDir = path.join(basePath, manifest.dir || '');
                            const targetFilePath = path.join(pluginDir, currentFile);
                            if (fs.existsSync(targetFilePath)) {
                                originalCode = fs.readFileSync(targetFilePath, 'utf8');
                            }
                        }
                    } catch (e) { }
                }
                if (!originalCode) {
                    originalCode = await i18n.backupManager.getBackupContent(pluginId, currentFile);
                }
                if (originalCode) {
                    setSourceCache(currentFile, originalCode);
                }
            }

            if (!originalCode) {
                notice.error(t('Editor.Errors.NoBackup'));
                return;
            }

            const results: DiagnoseError[] = [];
            const extracted = await i18n.companionWorkerManager.codeExtract({
                code: originalCode,
                settings: getExtractionSettings(),
            });
            const hitAst = new Set((extracted.ast || []).flatMap(item => [
                `${item.type}:${item.name || ''}:${item.source}`,
                item.source,
            ]));
            const hitRegex = new Set((extracted.regex || []).map(item => item.source));

            astItems.forEach(item => {
                const fingerprint = `${item.type}:${item.name || ''}:${item.source}`;
                const isHit = hitAst.has(fingerprint) || hitAst.has(item.source) || originalCode.includes(item.source);
                if (!isHit) {
                    results.push({
                        type: 'ast',
                        id: item.id,
                        source: item.source,
                        isUnused: true
                    });
                }
            });

            regexItems.forEach(item => {
                if (!hitRegex.has(item.source) && !originalCode.includes(item.source)) {
                    results.push({
                        type: 'regex',
                        id: item.id,
                        source: item.source,
                        isUnused: true
                    });
                }
            });

            setErrorItems(results);
            if (results.length === 0) {
                notice.success(t('Editor.Notices.DiagnosisSuccess'));
            } else {
                notice.info(t('Editor.Errors.UnusedTotal', { count: results.length }));
            }
        } catch (e) {
            notice.error(t('Common.Status.Failure') + ': ' + e);
        } finally {
            setIsDiagnosing(false);
        }
    }, [i18n, notice, t, isDiagnosing, getExtractionSettings]);

    const handleClearDiagnose = React.useCallback(() => {
        setErrorItems([]);
        setHasChecked(false);
        setIsUnusedScan(false);
    }, []);

    const handleDeleteUnused = React.useCallback(() => {
        const unusedItems = errorItems.filter(i => i.isUnused);
        if (unusedItems.length === 0) return;

        if (!confirm(t('Editor.Notices.ConfirmDeleteUnused') || `确认删除这 ${unusedItems.length} 个冗余项吗？`)) return;

        const { astItems, regexItems } = useRegexStore.getState();

        const unusedAstIds = new Set(unusedItems.filter(i => i.type === 'ast').map(i => i.id));
        const unusedRegexIds = new Set(unusedItems.filter(i => i.type === 'regex').map(i => i.id));

        const newAstItems = astItems.filter(i => !unusedAstIds.has(i.id));
        const newRegexItems = regexItems.filter(i => !unusedRegexIds.has(i.id));

        // 重新分配 ID 保证连续性
        setAstItems(newAstItems.map((item, index) => ({ ...item, id: index })));
        setRegexItems(newRegexItems.map((item, index) => ({ ...item, id: index })));

        setErrorItems([]);
        setHasChecked(false);
        setIsUnusedScan(false);
        notice.success(t('Editor.Notices.SuccessDelete'));
    }, [errorItems, notice, t, setAstItems, setRegexItems]);

    const handleJumpError = React.useCallback((error: DiagnoseError) => {
        setActiveTab(error.type);
        // 通过 CustomEvent 触发表格滚动定位 (由子组件监听)
        window.dispatchEvent(new CustomEvent('i18n-jump-error', {
            detail: { type: error.type, id: error.id }
        }));
    }, []);

    const handleRestoreAllErrors = React.useCallback(() => {
        if (errorItems.length === 0) return;

        const newAstItems = [...useRegexStore.getState().astItems];
        const newRegexItems = [...useRegexStore.getState().regexItems];

        errorItems.forEach(error => {
            if (error.type === 'ast') {
                const idx = newAstItems.findIndex(i => i.id === error.id);
                if (idx !== -1) {
                    newAstItems[idx] = { ...newAstItems[idx], target: newAstItems[idx].source };
                }
            } else if (error.type === 'regex') {
                const idx = newRegexItems.findIndex(i => i.id === error.id);
                if (idx !== -1) {
                    newRegexItems[idx] = { ...newRegexItems[idx], target: newRegexItems[idx].source };
                }
            }
        });

        setAstItems(newAstItems);
        setRegexItems(newRegexItems);
        setErrorItems([]);
        setHasChecked(false);
        notice.success(t('Editor.Notices.SuccessRestore'));
    }, [errorItems, notice, t, setAstItems, setRegexItems]);

    // AI 修复单条错误项
    const handleAiFixError = React.useCallback(async (error: DiagnoseError) => {
        try {
            // 从 store 中获取当前 target（DiagnoseError 没有 target 字段）
            const state = useRegexStore.getState();
            let currentTarget = '';
            if (error.type === 'ast') {
                const item = state.astItems.find(i => i.id === error.id);
                currentTarget = item?.target || error.source;
            } else {
                const item = state.regexItems.find(i => i.id === error.id);
                currentTarget = item?.target || error.source;
            }

            const provider = createTranslationProvider();
            const fixedTarget = await provider.fixTranslation(
                error.source,
                currentTarget,
                error.message || '语法错误'
            );

            // 更新对应的翻译条目
            if (error.type === 'ast') {
                const currentAstItems = useRegexStore.getState().astItems;
                const updated = currentAstItems.map(item =>
                    item.id === error.id ? { ...item, target: fixedTarget } : item
                );
                setAstItems(updated);
            } else {
                const currentRegexItems = useRegexStore.getState().regexItems;
                const updated = currentRegexItems.map(item =>
                    item.id === error.id ? { ...item, target: fixedTarget } : item
                );
                setRegexItems(updated);
            }

            // 从 errorItems 中移除已修复的项
            setErrorItems(prev => prev.filter(e => !(e.id === error.id && e.type === error.type)));

            notice.success(t('Editor.Notices.AiFixSuccess'));
        } catch (err: any) {
            console.error('[AI Fix] 修复失败:', err);
            notice.error(`${t('Editor.Errors.AiFixFail')}: ${err.message}`);
        }
    }, [notice, t, setAstItems, setRegexItems, setErrorItems]);

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
                                    onUnusedDiagnose={handleUnusedDiagnose}
                                    onSecurityDiagnose={handleSecurityDiagnose}
                                    onDeleteUnused={handleDeleteUnused}
                                    onClearDiagnose={handleClearDiagnose}
                                    onRestoreAllErrors={handleRestoreAllErrors}
                                    isDiagnosing={isDiagnosing}
                                    isUnusedScan={isUnusedScan}
                                    isSecurityScan={isSecurityScan}
                                    errorItems={errorItems}
                                    hasChecked={hasChecked}
                                    setActiveTab={setActiveTab}
                                    isApplied={isApplied}
                                    onJumpError={handleJumpError}
                                    onAiFixError={handleAiFixError}
                                />
                            </TabsContent>
                            <TabsContent value="regex" className="flex-1 min-h-0 m-0 overflow-hidden outline-none">
                                <RegexSidebar
                                    regexController={regexController}
                                    onIncrementalExtract={incrementalExtractRegex}
                                    onOpenFile={handleOpenFile}
                                    onDiagnose={handleDiagnose}
                                    onUnusedDiagnose={handleUnusedDiagnose}
                                    onSecurityDiagnose={handleSecurityDiagnose}
                                    onDeleteUnused={handleDeleteUnused}
                                    onClearDiagnose={handleClearDiagnose}
                                    onRestoreAllErrors={handleRestoreAllErrors}
                                    isDiagnosing={isDiagnosing}
                                    isUnusedScan={isUnusedScan}
                                    isSecurityScan={isSecurityScan}
                                    errorItems={errorItems}
                                    hasChecked={hasChecked}
                                    setActiveTab={setActiveTab}
                                    isApplied={isApplied}
                                    onJumpError={handleJumpError}
                                    onAiFixError={handleAiFixError}
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
