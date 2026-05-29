import I18N from '../main';
import { Notice } from 'obsidian';
import { t } from '../locales';
import { RegistryItem, CommunityStatsData, ManifestEntry, getCloudFilePath } from '../views/cloud/types';
import { calculateChecksum } from '../utils/translator/translation';
import { TranslationSource, IState } from '../types';
import { RegistryCacheManager } from './registry-cache';
import { useAutoStore } from '../views/manager/auto-store';
import { HistoryManager } from './history-manager';

export class AutoManager {
    private i18n: I18N;
    private isRunning = false;
    private registryCache: RegistryCacheManager;
    private historyManager: HistoryManager;
    private manifestCache: { repoAddress: string; entry: ManifestEntry }[] = [];
    private manifestCacheByPlugin = new Map<string, { repoAddress: string; entry: ManifestEntry }[]>();

    private indexManifests(manifests: { repoAddress: string; entry: ManifestEntry }[]) {
        const index = new Map<string, { repoAddress: string; entry: ManifestEntry }[]>();
        for (const manifest of manifests) {
            const matches = index.get(manifest.entry.plugin);
            if (matches) matches.push(manifest);
            else index.set(manifest.entry.plugin, [manifest]);
        }
        return index;
    }

    private getCachedManifestMatches(pluginId: string) {
        if (this.manifestCacheByPlugin.size === 0 && this.manifestCache.length > 0) {
            this.manifestCacheByPlugin = this.indexManifests(this.manifestCache);
        }
        return this.manifestCacheByPlugin.get(pluginId) || [];
    }

    constructor(i18n: I18N) {
        this.i18n = i18n;
        this.registryCache = new RegistryCacheManager(i18n);
        this.historyManager = new HistoryManager(i18n.app, i18n.manifest.dir || '');
    }

    /**
     * 自动模式启动入口
     */
    public async initialize() {
        this.syncStore();
    }

    /**
     * 同步设置到 Store
     */
    private async syncStore(history?: any[]) {
        const store = useAutoStore.getState();
        const finalHistory = history ?? await this.historyManager.loadHistory();
        const plugins = this.i18n.stateManager.getAllPluginStates();
        const themes = this.i18n.stateManager.getAllThemeStates();
        const appliedCount = [...Object.values(plugins), ...Object.values(themes)].filter((s: IState) => s.isApplied).length;

        store.hydrate(this.i18n.settings, {
            appliedCount,
            history: finalHistory
        });
    }

    /**
     * 后台静默探测任务
     */
    public async runDiscovery() {
        if (!this.i18n.settings.autoDiscovery) return;
        return this.runSmartAuto({ silent: true, isDiscovery: true });
    }

    /**
     * 定时后台检查逻辑
     */
    public async checkAndRunDiscovery() {
        if (!this.i18n.settings.autoDiscovery) return;
        if (this.isRunning) return;

        const now = Date.now();
        const lastCheck = this.i18n.settings.lastAutoCheckTime || 0;
        const intervalMs = this.i18n.settings.autoCheckInterval * 60 * 60 * 1000;

        if (intervalMs === 0) return;

        if (now - lastCheck >= intervalMs) {
            console.log('[AutoManager] Running scheduled background discovery...');
            await this.runSmartAuto({
                isDiscovery: true,
                isIncremental: true,
                silent: true
            });
        }
    }

    /**
     * 一键智能自动化处理
     */
    public async runSmartAuto(options: { silent?: boolean, isIncremental?: boolean, isDiscovery?: boolean } = {}) {
        const store = useAutoStore.getState();

        if (this.isRunning) {
            if (!options.silent) new Notice(t('Manager.Status.Running'));
            return;
        }

        const isSilent = options.silent;
        this.isRunning = true;
        store.setStatus('running');
        store.clearAll();

        if (!isSilent) this.i18n.notice.info(t('Manager.Status.AutoStarting'));

        try {
            await this.i18n.stateManager.validateVersions(this.i18n.app);

            const trustedRepos = this.i18n.settings.autoTrustedRepos;
            if (!trustedRepos || trustedRepos.length === 0) {
                store.setStatus('error');
                if (!isSilent) this.i18n.notice.warning(t('Manager.Errors.NoTrustedRepos'));
                return;
            }

            const [registry, stats] = await Promise.all([
                this.registryCache.getRegistry(),
                this.registryCache.getStats(),
            ]);

            const installedPlugins = this.getInstalledPlugins();
            const installedThemes = await this.getInstalledThemes();
            let allInstalled = [...installedPlugins, ...installedThemes];

            const excludeList = new Set(this.i18n.settings.autoExcludeList || []);
            allInstalled = allInstalled.filter(item => !excludeList.has(item.id));

            if (options.isIncremental || options.isDiscovery) {
                allInstalled = allInstalled.filter(item => {
                    const state = item.type === 'theme'
                        ? this.i18n.stateManager.getThemeState(item.id)
                        : this.i18n.stateManager.getPluginState(item.id);

                    if (!state || !state.isApplied) return true;
                    if (item.version !== state.pluginVersion) return true;
                    return false;
                });

                if (allInstalled.length === 0) {
                    store.setStatus('success');
                    this.isRunning = false;
                    return;
                }
            }

            store.initTasks(allInstalled.map(item => ({
                id: item.id,
                type: item.type,
                name: item.id,
                status: 'pending'
            })));

            if (!isSilent) this.i18n.notice.info(t('Manager.Status.ScanningInstalled', { count: allInstalled.length }));

            const trustedSet = new Set(trustedRepos);
            let relevantRepos = registry.filter((item: RegistryItem) => trustedSet.has(item.repoAddress));

            if (relevantRepos.length === 0) {
                store.setStatus('error');
                if (!isSilent) this.i18n.notice.warning(t('Manager.Errors.TrustedRepoNotInRegistry'));
                return;
            }

            const BATCH_SIZE = 5;
            this.manifestCache = [];
            for (let i = 0; i < relevantRepos.length; i += BATCH_SIZE) {
                const batch = relevantRepos.slice(i, i + BATCH_SIZE);
                await Promise.all(batch.map(async (item) => {
                    const [rOwner, rRepo] = item.repoAddress.split('/');
                    const manifestRes = await this.i18n.api.github.getFileContentWithFallback(rOwner, rRepo, 'metadata.json');
                    if (manifestRes.state && Array.isArray(manifestRes.data)) {
                        manifestRes.data.forEach((entry: ManifestEntry) => {
                            this.manifestCache.push({ repoAddress: item.repoAddress, entry });
                        });
                    }
                }));
                if (i + BATCH_SIZE < relevantRepos.length) await new Promise(res => setTimeout(res, 500));
            }

            const allManifests = this.manifestCache;
            this.manifestCacheByPlugin = this.indexManifests(allManifests);

            let successCount = 0;
            let skipCount = 0;
            let upToDateCount = 0;
            let errorCount = 0;

            let processedIndex = 0;
            for (const installed of allInstalled) {
                if (!this.isRunning) break;
                processedIndex++;
                store.setProgress(processedIndex, allInstalled.length);

                try {
                    if (this.i18n.settings.autoExcludeList.includes(installed.id)) {
                        skipCount++;
                        store.updateTaskStatus(installed.id, 'skipped', t('Manager.Auto.Status.SkipReasons.Exclusion'));
                        continue;
                    }

                    store.updateTaskStatus(installed.id, 'processing');

                    const matches = this.getCachedManifestMatches(installed.id);
                    if (matches.length === 0) {
                        skipCount++;
                        store.updateTaskStatus(installed.id, 'skipped', t('Manager.Auto.Status.SkipReasons.NoMatch'));
                        continue;
                    }

                    const { match: bestMatch, scoreInfo } = await this.selectBestTranslation(
                        matches,
                        stats,
                        installed.version,
                        this.i18n.settings.language,
                        installed.type === 'theme'
                    );

                    if (bestMatch) {
                        const existing = this.i18n.sourceManager.getSource(bestMatch.entry.id);
                        const state = installed.type === 'theme' ? this.i18n.stateManager.getThemeState(installed.id) : this.i18n.stateManager.getPluginState(installed.id);

                        const isHashMatch = existing && existing.cloud?.hash === bestMatch.entry.hash;
                        const isVersionMatch = state && String(state.translationVersion) === String(bestMatch.entry.version);
                        const isPluginVersionMatch = state && state.pluginVersion === installed.version;
                        const isApplied = state?.isApplied === true;

                        if (isApplied && isHashMatch && isVersionMatch && isPluginVersionMatch) {
                            store.updateTaskStatus(installed.id, 'up_to_date', undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
                            upToDateCount++;
                            continue;
                        }

                        if (options.isDiscovery || !this.i18n.settings.autoApply) {
                            successCount++;
                            const discoveryStatus = existing ? 'discovered_update' : 'discovered_new';
                            store.updateTaskStatus(installed.id, discoveryStatus, undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
                            continue;
                        }

                        if (isHashMatch) {
                            this.i18n.sourceManager.setActive(bestMatch.entry.id, true);
                            const result = installed.type === 'theme'
                                ? await this.i18n.injectorManager.applyToTheme(installed.id)
                                : await this.i18n.injectorManager.applyToPlugin(installed.id);
                            if (result) {
                                successCount++;
                                store.updateTaskStatus(installed.id, 'success', undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
                            } else {
                                errorCount++;
                                store.updateTaskStatus(installed.id, 'error', 'Cache apply failed');
                            }
                            continue;
                        }

                        const result = await this.applyTranslation(bestMatch, installed.type);
                        if (result) {
                            successCount++;
                            store.updateTaskStatus(installed.id, 'success', undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
                        } else {
                            errorCount++;
                            store.updateTaskStatus(installed.id, 'error', t('Manager.Errors.ApplyFailed'));
                        }
                    } else {
                        skipCount++;
                        store.updateTaskStatus(installed.id, 'skipped', t('Manager.Auto.Status.SkipReasons.NoVersion'));
                    }
                } catch (pluginError: any) {
                    if (pluginError.message === 'ROLLBACK_TRIGGERED') {
                        store.updateTaskStatus(installed.id, 'error', t('Manager.Status.AutoRollbacked'));
                    } else {
                        store.updateTaskStatus(installed.id, 'error', pluginError.message || 'Unknown Error');
                    }
                    errorCount++;
                }
            }

            if (options.isDiscovery && successCount > 0 && !isSilent) {
                this.i18n.notice.info(t('Manager.Auto.Status.DiscoveryComplete', { count: successCount }), 5000);
            }

            store.setStatus(errorCount > 0 ? 'error' : 'success');
            this.i18n.settings.lastAutoCheckTime = Date.now();
            await this.i18n.saveSettings();

            const triggerMode = options.isDiscovery ? 'discovery' : (options.isIncremental ? 'startup' : 'manual');
            const currentHistory = store.history;
            const auditRecord = await this.historyManager.addRecord(triggerMode, store.tasks, currentHistory);
            const nextHistory = [auditRecord, ...currentHistory].slice(0, 50);
            store.addHistory(auditRecord);
            this.syncStore(nextHistory);
        } catch (error: any) {
            console.error('[AutoManager] Smart Auto failed:', error);
            store.setStatus('error');
            if (!isSilent) this.i18n.notice.error(`${t('Manager.Errors.AutoFailed')}: ${error.message || error}`);
        } finally {
            this.isRunning = false;
        }
    }

    /**
     * 单个任务重试
     */
    public async retryTask(id: string, type: 'plugin' | 'theme') {
        const store = useAutoStore.getState();
        store.updateTaskStatus(id, 'processing');

        try {
            let installedVersion = '0.0.0';
            if (type === 'plugin') {
                const manifest = (this.i18n.app as any).plugins.manifests[id];
                if (manifest) installedVersion = manifest.version;
            } else {
                const themes = await this.getInstalledThemes();
                const theme = themes.find(t => t.id === id);
                if (theme) installedVersion = theme.version;
            }

            const trustedSet = new Set(this.i18n.settings.autoTrustedRepos || []);
            if (trustedSet.size === 0) {
                store.updateTaskStatus(id, 'error', t('Manager.Errors.TrustedRepoNotInRegistry'));
                return;
            }

            const stats = await this.registryCache.getStats();
            let matches = this.getCachedManifestMatches(id).filter(m => trustedSet.has(m.repoAddress));

            if (matches.length === 0) {
                const registry = await this.registryCache.getRegistry();
                const relevantRepos = registry.filter((item: RegistryItem) => trustedSet.has(item.repoAddress));

                if (relevantRepos.length === 0) {
                    store.updateTaskStatus(id, 'error', t('Manager.Errors.TrustedRepoNotInRegistry'));
                    return;
                }

                const allManifests: { repoAddress: string; entry: ManifestEntry }[] = [];
                for (const item of relevantRepos) {
                    const [rOwner, rRepo] = item.repoAddress.split('/');
                    try {
                        const manifestRes = await this.i18n.api.github.getFileContentWithFallback(rOwner, rRepo, 'metadata.json');
                        if (manifestRes.state && Array.isArray(manifestRes.data)) {
                            manifestRes.data.forEach((entry: ManifestEntry) => {
                                allManifests.push({ repoAddress: item.repoAddress, entry });
                            });
                        }
                    } catch (e) { }
                }

                this.manifestCache = allManifests;
                this.manifestCacheByPlugin = this.indexManifests(allManifests);
                matches = this.getCachedManifestMatches(id);
            }

            if (matches.length === 0) {
                store.updateTaskStatus(id, 'skipped', t('Manager.Auto.Status.SkipReasons.NoMatch'));
                return;
            }

            const { match: bestMatch } = await this.selectBestTranslation(matches, stats, installedVersion, this.i18n.settings.language, type === 'theme');

            if (!bestMatch) {
                store.updateTaskStatus(id, 'skipped', t('Manager.Auto.Status.SkipReasons.NoVersion'));
                return;
            }

            const result = await this.applyTranslation(bestMatch, type);
            if (result) {
                store.updateTaskStatus(id, 'success', undefined, bestMatch.repoAddress, String(bestMatch.entry.version));
            } else {
                store.updateTaskStatus(id, 'error', 'Download or injection failed');
            }
        } catch (err: any) {
            store.updateTaskStatus(id, 'error', err.message || 'Unknown error');
        }
    }

    public invalidateCache() {
        this.registryCache.invalidate();
    }

    public async verifyRepo(repoStr: string): Promise<boolean> {
        try {
            const registry = await this.registryCache.getRegistry();
            const existsInRegistry = registry.some(item => item.repoAddress === repoStr);
            if (existsInRegistry) return true;

            const [owner, repo] = repoStr.split('/');
            const res = await this.i18n.api.github.getFileContentWithFallback(owner, repo, 'metadata.json');
            return res.state === true;
        } catch (e) {
            return false;
        }
    }

    private getInstalledPlugins() {
        const manifests = (this.i18n.app as any).plugins.manifests;
        return Object.values(manifests)
            .filter((m: any) => m.id !== this.i18n.manifest.id)
            .map((m: any) => ({ id: m.id, name: m.name, version: m.version, type: 'plugin' as const }));
    }

    private async getInstalledThemes() {
        const themes: { id: string; name: string; version: string; type: 'theme' }[] = [];
        try {
            const adapter = this.i18n.app.vault.adapter;
            const themesPath = `${this.i18n.app.vault.configDir}/themes`;
            if (await adapter.exists(themesPath)) {
                const folders = await adapter.list(themesPath);
                for (const folder of folders.folders) {
                    const themeId = folder.split('/').pop();
                    if (themeId) {
                        let version = '0.0.0';
                        try {
                            const manifestPath = `${folder}/manifest.json`;
                            if (await adapter.exists(manifestPath)) {
                                const manifest = JSON.parse(await adapter.read(manifestPath));
                                if (manifest?.version) version = manifest.version;
                            }
                        } catch (e) { }
                        themes.push({ id: themeId, name: themeId, version, type: 'theme' });
                    }
                }
            }
        } catch (e) { }
        return themes;
    }

    private isVersionCompatible(cloudVersion: string, localVersion: string): number {
        if (cloudVersion === localVersion) return 100;
        const cParts = cloudVersion.split('.').map(Number);
        const lParts = localVersion.split('.').map(Number);
        if (cParts[0] === lParts[0]) return 50;
        return 0;
    }

    public async applyBatchDiscovered(ids: string[]) {
        const store = useAutoStore.getState();
        store.setStatus('running');
        let success = 0;
        let fail = 0;

        // Ensure we have a cache. If not, we might need a quick re-fetch (rare if user just scanned)
        if (this.manifestCache.length === 0) {
            // Attempt to re-fetch minimal manifests or use a previous scan result
            // For now, if empty, we can't reliably batch apply without repo context
            // But usually the user just finished a scan.
        }

        const stats = await this.registryCache.getStats();
        const allInstalled = [
            ...Object.values(this.i18n.app.plugins.manifests).map(m => ({ ...m, type: 'plugin' })),
            ...(await this.getInstalledThemes()).map(t => ({ ...t, type: 'theme' }))
        ];
        const installedById = new Map(allInstalled.map(item => [item.id, item]));
        const tasksById = new Map(store.tasks.map(task => [task.id, task]));

        for (const id of ids) {
            const task = tasksById.get(id);
            if (!task) continue;

            const matches = this.getCachedManifestMatches(id);
            if (matches.length === 0) {
                fail++;
                store.updateTaskStatus(id, 'error', t('Manager.Auto.Errors.NoCachedManifest' as any));
                continue;
            }

            const installed = installedById.get(id);
            if (!installed) continue;

            const { match: bestMatch, scoreInfo } = await this.selectBestTranslation(
                matches,
                stats,
                installed.version,
                this.i18n.settings.language,
                installed.type === 'theme'
            );

            if (!bestMatch) {
                fail++;
                store.updateTaskStatus(id, 'error', t('Manager.Auto.Errors.NoBestMatch' as any));
                continue;
            }

            store.updateTaskStatus(id, 'processing');

            // Check if it exists locally and just needs applying
            const existing = this.i18n.sourceManager.getSource(bestMatch.entry.id);
            if (existing && existing.cloud?.hash === bestMatch.entry.hash) {
                this.i18n.sourceManager.setActive(bestMatch.entry.id, true);
                const result = task.type === 'theme'
                    ? await this.i18n.injectorManager.applyToTheme(id)
                    : await this.i18n.injectorManager.applyToPlugin(id);
                if (result) {
                    success++;
                    store.updateTaskStatus(id, 'success', undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
                } else {
                    fail++;
                    store.updateTaskStatus(id, 'error', t('Manager.Auto.Errors.LocalApplyFailed' as any));
                }
                continue;
            }

            // Otherwise download and apply
            const result = await this.applyTranslation(bestMatch, task.type as any);

            if (result) {
                success++;
                store.updateTaskStatus(id, 'success', undefined, bestMatch.repoAddress, String(bestMatch.entry.version), scoreInfo);
            } else {
                fail++;
                store.updateTaskStatus(id, 'error', 'Download/Apply failed');
            }
        }

        store.setStatus('success');
        this.i18n.notice.success(t('Manager.Auto.Log.BatchComplete', { success, fail }));
        this.syncStore();
    }

    private async selectBestTranslation(
        matches: { repoAddress: string; entry: ManifestEntry }[],
        stats: CommunityStatsData,
        targetVersion: string,
        targetLanguage: string,
        isTheme: boolean
    ): Promise<{ match: { repoAddress: string; entry: ManifestEntry } | null, scoreInfo: any }> {
        const strategy = this.i18n.settings.autoMatchStrategy || 'comprehensive';
        if (this.i18n.settings.llmCompanionWorkerEnabled) {
            try {
                return await this.i18n.companionWorkerManager.autoMatch({
                    matches,
                    stats,
                    targetVersion,
                    targetLanguage,
                    isTheme,
                    strategy,
                }) as { match: { repoAddress: string; entry: ManifestEntry } | null, scoreInfo: any };
            } catch (error) {
                console.warn('[I18N Companion] Automation match fallback:', error);
            }
        }

        let hasLanguageMatch = false;
        for (const match of matches) {
            if (match.entry.language === targetLanguage) {
                hasLanguageMatch = true;
                break;
            }
        }

        let bestMatch: { repoAddress: string; entry: ManifestEntry } | null = null;
        let bestScore = -1;
        let bestBreakdown = { version: 0, popularity: 0, freshness: 0, total: 0 };
        const now = Date.now();

        for (const match of matches) {
            if (hasLanguageMatch && match.entry.language !== targetLanguage) continue;

            const repoStats = stats.repos[match.repoAddress] || {};
            const stars = repoStats.stars || 0;
            const activity = repoStats.activityScore || 0;

            const vMatchRaw = isTheme ? 50 : this.isVersionCompatible(match.entry.supported_versions || '', targetVersion);
            const versionScore = (vMatchRaw / 100) * 50;

            const starScore = Math.min((stars / 500) * 20, 20);
            const activityScore = Math.min(activity * 10, 10);
            const popularityScore = starScore + activityScore;

            const updatedAt = new Date(match.entry.updated_at || 0).getTime();
            const daysSinceUpdate = (now - updatedAt) / (1000 * 60 * 60 * 24);
            let freshnessScore = 0;
            if (daysSinceUpdate <= 30) freshnessScore = 20;
            else if (daysSinceUpdate <= 90) freshnessScore = 15;
            else if (daysSinceUpdate <= 180) freshnessScore = 10;
            else if (daysSinceUpdate <= 365) freshnessScore = 5;

            let total = 0;
            switch (strategy) {
                case 'version_first':
                    total = (versionScore * 1.5) + (popularityScore * 0.5) + (freshnessScore * 0.5);
                    break;
                case 'popularity':
                    total = (versionScore * 0.5) + (popularityScore * 1.5) + (freshnessScore * 0.5);
                    break;
                case 'latest_update':
                    total = (versionScore * 0.5) + (popularityScore * 0.5) + (freshnessScore * 1.5);
                    break;
                default:
                    total = versionScore + popularityScore + freshnessScore;
            }

            total = Math.min(Math.round(total), 100);
            if (total > bestScore) {
                bestScore = total;
                bestMatch = match;
                bestBreakdown = {
                    version: Math.round(versionScore),
                    popularity: Math.round(popularityScore),
                    freshness: Math.round(freshnessScore),
                    total
                };
            }
        }

        return { match: bestMatch, scoreInfo: bestBreakdown };
    }

    private async applyTranslation(match: { repoAddress: string; entry: ManifestEntry }, type: 'plugin' | 'theme'): Promise<boolean> {
        const [owner, repo] = match.repoAddress.split('/');
        const filePath = getCloudFilePath(match.entry.id, type);

        try {
            const res = await this.i18n.api.github.getFileContentWithFallback(owner, repo, filePath);
            if (!res.state || !res.data) return false;

            const content = res.data;
            const manager = this.i18n.sourceManager;
            const existing = manager.getSource(match.entry.id);

            if (existing) this.i18n.backupManager.backupTranslationSync(existing.id, manager.sourcesDir);

            manager.saveSourceFile(match.entry.id, content);
            const sourceInfo: TranslationSource = {
                id: match.entry.id,
                plugin: match.entry.plugin,
                title: match.entry.title,
                type: match.entry.type,
                origin: 'cloud',
                isActive: true,
                checksum: calculateChecksum(content),
                cloud: { owner, repo, hash: match.entry.hash },
                updatedAt: Date.now(),
                createdAt: existing?.createdAt || Date.now(),
            };

            manager.saveSource(sourceInfo, { activate: true });

            return type === 'theme'
                ? await this.i18n.injectorManager.applyToTheme(match.entry.plugin)
                : await this.i18n.injectorManager.applyToPlugin(match.entry.plugin);
        } catch (error) {
            return false;
        }
    }
}
