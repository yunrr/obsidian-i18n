/**
 * 翻译源管理器 (扁平化结构 v2)
 * 负责管理多翻译源的元数据、激活状态和文件路径
 */
import * as fs from 'fs-extra';
import * as path from 'path';
import { TranslationSourceMeta, TranslationSource, EMPTY_META, EMPTY_BATCH_TASK_RECORD, BatchTaskRecordMeta, BatchTaskCheckpoint, BatchTaskFailureRecord } from '../types';
import { calculateChecksum } from '../utils/translator/light';
import { nanoid } from 'nanoid';
import { useGlobalStoreInstance } from '~/utils/store/global';
import { t } from '../locales'; // Correct import path
import { loadTranslationFile, saveTranslationFile, TRANSLATION_FILE_EXTENSION } from './io-manager';

export class SourceManager {
    private basePath: string;           // i18n插件目录
    public sourcesDir: string;         // translation-sources目录
    private metaPath: string;           // meta.json路径
    private checkpointPath: string;     // backup-checkpoint.json路径
    private batchTaskRecordPath: string;
    private meta: TranslationSourceMeta;

    constructor(i18nPluginDir: string) {
        this.basePath = i18nPluginDir;
        this.sourcesDir = path.join(i18nPluginDir, 'translations');
        this.metaPath = path.join(i18nPluginDir, 'metadata.json');
        this.checkpointPath = path.join(i18nPluginDir, 'backup-checkpoint.json');
        this.batchTaskRecordPath = path.join(i18nPluginDir, 'batch-task-records.json');
        this.meta = this.loadMeta();
    }

    // ========== 元数据管理 ========== 

    /**
     * 加载元数据 (支持自动迁移旧版本)
     */
    private loadMeta(): TranslationSourceMeta {
        try {
            if (fs.existsSync(this.metaPath)) {
                const raw = fs.readJsonSync(this.metaPath);
                // 自动迁移旧版本数据
                if (raw.sources) {
                    let needsSave = false;
                    for (const source of Object.values(raw.sources) as any[]) {
                        // 迁移 type → origin（旧版 type 值为 'cloud'|'local'）
                        if (!source.origin && (source.type === 'cloud' || source.type === 'local')) {
                            source.origin = source.type;
                            source.type = 'plugin'; // 旧数据全部是插件翻译
                            needsSave = true;
                        }
                        // 迁移 pluginId → plugin
                        if ('pluginId' in source && !('plugin' in source)) {
                            source.plugin = source.pluginId;
                            delete source.pluginId;
                            needsSave = true;
                        }
                        // 清理已废弃的字段
                        for (const field of ['language', 'version', 'supportedVersions']) {
                            if (field in source) {
                                delete source[field];
                                needsSave = true;
                            }
                        }
                    }
                    if (needsSave) {
                        fs.ensureDirSync(this.sourcesDir);
                        fs.writeJsonSync(this.metaPath, raw, { spaces: 2 });
                    }
                }
                return raw;
            }
        } catch (error) {
            console.error('[SourceManager] Failed to load meta:', error);
        }
        return JSON.parse(JSON.stringify(EMPTY_META));
    }

    /**
     * 保存元数据
     */
    private saveMeta(): void {
        try {
            fs.ensureDirSync(this.sourcesDir);
            fs.writeJsonSync(this.metaPath, this.meta, { spaces: 2 });
            useGlobalStoreInstance.getState().triggerSourceUpdate();
        } catch (error) {
            console.error('[SourceManager] Failed to save meta:', error);
            throw error;
        }
    }

    private loadBatchTaskRecord(): BatchTaskRecordMeta {
        try {
            if (fs.existsSync(this.batchTaskRecordPath)) {
                const raw = fs.readJsonSync(this.batchTaskRecordPath);
                return {
                    schemaVersion: raw?.schemaVersion || 1,
                    checkpoints: raw?.checkpoints || {},
                    failures: Array.isArray(raw?.failures) ? raw.failures : [],
                    updatedAt: raw?.updatedAt || 0,
                };
            }
        } catch (error) {
            console.error('[SourceManager] Failed to load batch task record:', error);
        }
        return JSON.parse(JSON.stringify(EMPTY_BATCH_TASK_RECORD));
    }

    private saveBatchTaskRecord(record: BatchTaskRecordMeta): void {
        try {
            fs.ensureDirSync(this.basePath);
            fs.writeJsonSync(this.batchTaskRecordPath, {
                ...record,
                updatedAt: Date.now(),
            }, { spaces: 2 });
            useGlobalStoreInstance.getState().triggerSourceUpdate();
        } catch (error) {
            console.error('[SourceManager] Failed to save batch task record:', error);
        }
    }

    private updateBatchTaskRecord(updater: (record: BatchTaskRecordMeta) => void): BatchTaskRecordMeta {
        const record = this.loadBatchTaskRecord();
        updater(record);
        this.saveBatchTaskRecord(record);
        return record;
    }

    // ========== 基础查询 ==========

    public getBasePath(): string {
        return this.basePath;
    }

    public reloadFromDisk(): void {
        this.meta = this.loadMeta();
        useGlobalStoreInstance.getState().triggerSourceUpdate();
    }

    /**
     * 根据ID获取翻译源
     */
    getSource(sourceId: string): TranslationSource | null {
        return this.meta.sources[sourceId] || null;
    }

    /**
     * 删除翻译源
     */
    deleteSource(sourceId: string): void {
        if (this.meta.sources[sourceId]) {
            delete this.meta.sources[sourceId];
            this.saveMeta();
        }
    }

    /**
     * 清理所有翻译源 (删除文件和元数据)
     */
    public clearAll(): void {
        this.meta.sources = {};
        if (fs.existsSync(this.sourcesDir)) {
            fs.emptyDirSync(this.sourcesDir);
        }
        this.saveMeta();
    }

    /**
     * 获取所有翻译源
     */
    getAllSources(): TranslationSource[] {
        return Object.values(this.meta.sources);
    }

    /**
     * 获取插件的所有翻译源
     */
    getSourcesForPlugin(pluginId: string): TranslationSource[] {
        return Object.values(this.meta.sources).filter(s => s.plugin === pluginId);
    }

    /**
     * 获取当前激活的翻译源ID
     */
    getActiveSourceId(pluginId: string): string | null {
        const sources = this.getSourcesForPlugin(pluginId);
        const active = sources.find(s => s.isActive);

        // 如果没有明确激活的，默认返回第一个
        if (!active && sources.length > 0) {
            return sources[0].id;
        }

        return active?.id || null;
    }

    /**
     * 获取当前激活的翻译源信息
     */
    getActiveSource(pluginId: string): TranslationSource | null {
        const activeId = this.getActiveSourceId(pluginId);
        if (!activeId) return null;
        return this.meta.sources[activeId] || null;
    }

    // ========== 增删改 ==========

    private upsertSourceInMemory(source: TranslationSource): void {
        const now = Date.now();
        const existing = this.meta.sources[source.id];

        if (existing) {
            this.meta.sources[source.id] = {
                ...existing,
                ...source,
                updatedAt: now
            };
            return;
        }

        this.meta.sources[source.id] = {
            ...source,
            createdAt: source.createdAt || now,
            updatedAt: now
        };
    }

    private setActiveInMemory(sourceId: string, active: boolean): boolean {
        const source = this.meta.sources[sourceId];
        if (!source) return false;

        let changed = false;

        if (active) {
            Object.values(this.meta.sources)
                .filter(s => s.plugin === source.plugin)
                .forEach(s => {
                    const shouldBeActive = s.id === sourceId;
                    if (s.isActive !== shouldBeActive) {
                        s.isActive = shouldBeActive;
                        changed = true;
                    }
                });
            return changed;
        }

        if (!source.isActive) return false;
        source.isActive = false;
        return true;
    }

    /**
     * 添加/更新翻译源
     */
    saveSource(source: TranslationSource, options?: { activate?: boolean }): void {
        this.upsertSourceInMemory(source);
        if (options?.activate) {
            this.setActiveInMemory(source.id, true);
        }
        this.saveMeta();
    }

    /**
     * 批量添加/更新翻译源 (减少磁盘写入)
     */
    batchSaveSources(sources: TranslationSource[]): void {
        for (const source of sources) {
            this.upsertSourceInMemory(source);
        }
        this.saveMeta();
    }

    /**
     * 删除翻译源
     */
    removeSource(sourceId: string): void {
        const source = this.meta.sources[sourceId];
        if (!source) return;

        const wasActive = source.isActive;
        const pluginId = source.plugin;

        // 删除元数据
        delete this.meta.sources[sourceId];

        // 如果删除的是激活源，尝试激活同插件的第一个
        if (wasActive) {
            const remaining = this.getSourcesForPlugin(pluginId);
            if (remaining.length > 0) {
                remaining[0].isActive = true;
            }
        }

        // 删除对应文件
        const filePath = this.getSourceFilePath(sourceId);
        if (fs.existsSync(filePath)) {
            fs.removeSync(filePath);
        }

        this.saveMeta();
    }

    /**
     * 设置激活状态（自动取消同插件的其他激活）
     */
    setActive(sourceId: string, active: boolean): void {
        if (!this.setActiveInMemory(sourceId, active)) return;
        this.saveMeta();
    }


    // ========== 路径管理 ==========

    /**
     * 获取翻译源文件路径
     */
    getSourceFilePath(sourceId: string): string {
        return path.join(this.sourcesDir, `${sourceId}.${TRANSLATION_FILE_EXTENSION}`);
    }

    /**
     * 获取激活翻译源的文件路径
     */
    getActiveSourcePath(pluginId: string): string | null {
        const activeId = this.getActiveSourceId(pluginId);
        if (!activeId) return null;
        return this.getSourceFilePath(activeId);
    }

    /**
     * 获取翻译文件的有效路径（优先激活源）
     */
    getTranslationPath(pluginId: string, pluginDir: string): string {
        const activePath = this.getActiveSourcePath(pluginId);
        if (activePath && fs.existsSync(activePath)) {
            return activePath;
        }
        return '';
    }

    // ========== 批量操作 ==========

    /**
     * 获取所有有翻译源的插件ID
     */
    getPluginIds(): string[] {
        const ids = new Set<string>();
        Object.values(this.meta.sources).forEach(s => ids.add(s.plugin));
        return Array.from(ids);
    }

    /**
     * 检查是否有任何翻译源
     */
    hasAnySources(pluginId: string): boolean {
        return this.getSourcesForPlugin(pluginId).length > 0;
    }

    // ========== 辅助方法 ==========

    /**
     * 生成随机ID (使用 NanoID 32字符)
     */
    private generateRandomId(): string {
        return nanoid(32);
    }

    /**
     * 生成翻译源ID (使用 NanoID 32字符)
     */
    generateSourceId(title: string): string {
        return nanoid(32);
    }

    /**
     * 保存翻译源文件
     */
    saveSourceFile(sourceId: string, content: any): void {
        const filePath = path.join(this.sourcesDir, `${sourceId}.${TRANSLATION_FILE_EXTENSION}`);
        saveTranslationFile(filePath, content);
    }

    /**
     * 读取翻译源文件
     */
    readSourceFile(sourceId: string): any {
        const filePath = this.getSourceFilePath(sourceId);
        return loadTranslationFile(filePath);
    }

    /**
     * 获取翻译源文件中的 metadata
     */
    getSourceMetadata(sourceId: string): any | null {
        try {
            const content = this.readSourceFile(sourceId);
            return content?.metadata || null;
        } catch {
            return null;
        }
    }

    /**
     * 执行提取流程 (始终新建)
     */
    public async extractAndSaveSource(pluginId: string, content: any, options: TranslationExtractionOptions): Promise<string> {
        const sourceId = this.generateRandomId();

        const translationSource: TranslationSource = {
            id: sourceId,
            plugin: pluginId,
            title: options.title || t('func.extract_local'),
            type: options.type || 'plugin',
            origin: 'local',
            isActive: true,
            checksum: calculateChecksum(content),
            updatedAt: Date.now(),
            createdAt: Date.now()
        };

        // 取消同插件的其他激活
        Object.values(this.meta.sources).filter(s => s.plugin === pluginId).forEach(s => s.isActive = false);

        // 保存文件 (使用新格式)
        this.saveSourceFile(sourceId, content);

        // 保存元数据
        this.saveSource(translationSource);

        return sourceId;
    }

    public batchExtractAndSaveSources(entries: Array<{ pluginId: string; content: any; options: TranslationExtractionOptions }>): string[] {
        const sourceIds: string[] = [];

        for (const entry of entries) {
            const sourceId = this.generateRandomId();
            const translationSource: TranslationSource = {
                id: sourceId,
                plugin: entry.pluginId,
                title: entry.options.title || t('func.extract_local'),
                type: entry.options.type || 'plugin',
                origin: 'local',
                isActive: true,
                checksum: calculateChecksum(entry.content),
                updatedAt: Date.now(),
                createdAt: Date.now()
            };

            Object.values(this.meta.sources)
                .filter(source => source.plugin === entry.pluginId)
                .forEach(source => {
                    source.isActive = false;
                });

            this.saveSourceFile(sourceId, entry.content);
            this.upsertSourceInMemory(translationSource);
            sourceIds.push(sourceId);
        }

        if (sourceIds.length > 0) {
            this.saveMeta();
        }

        return sourceIds;
    }

    // ========== 检查点 (Checkpoint) 管理 ==========

    /**
     * 保存备份检查点
     */
    saveCheckpoint(data: any): void {
        try {
            fs.writeJsonSync(this.checkpointPath, {
                ...data,
                timestamp: Date.now()
            }, { spaces: 2 });
        } catch (error) {
            console.error('[SourceManager] Failed to save checkpoint:', error);
        }
    }

    /**
     * 加载备份检查点
     */
    loadCheckpoint(): any | null {
        try {
            if (fs.existsSync(this.checkpointPath)) {
                return fs.readJsonSync(this.checkpointPath);
            }
        } catch (error) {
            console.error('[SourceManager] Failed to load checkpoint:', error);
        }
        return null;
    }

    /**
     * 清除备份检查点
     */
    clearCheckpoint(): void {
        try {
            if (fs.existsSync(this.checkpointPath)) {
                fs.removeSync(this.checkpointPath);
            }
        } catch (error) {
            console.error('[SourceManager] Failed to clear checkpoint:', error);
        }
    }

    saveBatchTaskCheckpoint(key: string, checkpoint: BatchTaskCheckpoint): void {
        this.updateBatchTaskRecord(record => {
            record.checkpoints[key] = checkpoint;
        });
    }

    loadBatchTaskCheckpoint(key: string): BatchTaskCheckpoint | null {
        const record = this.loadBatchTaskRecord();
        return record.checkpoints[key] || null;
    }

    clearBatchTaskCheckpoint(key: string): void {
        this.updateBatchTaskRecord(record => {
            delete record.checkpoints[key];
        });
    }

    getBatchTaskFailures(scope?: BatchTaskFailureRecord['scope']): BatchTaskFailureRecord[] {
        const record = this.loadBatchTaskRecord();
        const failures = scope ? record.failures.filter(item => item.scope === scope) : record.failures;
        return failures.sort((a, b) => b.failedAt - a.failedAt);
    }

    saveBatchTaskFailure(failure: BatchTaskFailureRecord): void {
        this.saveBatchTaskFailures([failure]);
    }

    saveBatchTaskFailures(failures: BatchTaskFailureRecord[]): void {
        if (failures.length === 0) return;
        this.updateBatchTaskRecord(record => {
            for (const failure of failures) {
                const duplicateIndex = record.failures.findIndex(item => item.id === failure.id);
                if (duplicateIndex >= 0) {
                    record.failures[duplicateIndex] = failure;
                } else {
                    record.failures.unshift(failure);
                }
            }
            if (record.failures.length > 500) {
                record.failures = record.failures.slice(0, 500);
            }
        });
    }

    removeBatchTaskFailures(ids: string[]): void {
        if (ids.length === 0) return;
        const idSet = new Set(ids);
        this.updateBatchTaskRecord(record => {
            record.failures = record.failures.filter(item => !idSet.has(item.id));
        });
    }

    clearBatchTaskFailures(scope?: BatchTaskFailureRecord['scope']): void {
        this.updateBatchTaskRecord(record => {
            if (!scope) {
                record.failures = [];
                return;
            }
            record.failures = record.failures.filter(item => item.scope !== scope);
        });
    }
}




export interface TranslationExtractionOptions {
    title?: string;
    description?: string;
    type?: 'plugin' | 'theme';
}

