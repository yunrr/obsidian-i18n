import { App, PluginManifest } from 'obsidian';
import * as path from 'path';
import * as fs from 'fs-extra';
import I18N from '../main';
import { t } from '../locales';

export class InjectorManager {
    private i18n: I18N;

    constructor(i18n: I18N) {
        this.i18n = i18n;
    }

    /**
     * 自动更新翻译 (注入器)
     */
    public async run(app: App) {
        if (this.i18n.settings.automaticUpdate) {
            let plugins: PluginManifest[] = [];

            // @ts-ignore
            plugins = Object.values(app.plugins.manifests).filter(item => item.id !== 'i18n');
            let updateitem = 0;

            for (const plugin of plugins) {
                const state = this.i18n.stateManager.getPluginState(plugin.id);
                if (state && state.isApplied && plugin.version != state.pluginVersion) {
                    const success = await this.applyToPlugin(plugin.id);
                    if (success) updateitem++;
                }
            }

            // Check themes
            try {
                // @ts-ignore
                const basePath = this.i18n.app.vault.adapter.getBasePath ? path.normalize(this.i18n.app.vault.adapter.getBasePath()) : '';
                if (basePath) {
                    const themesDir = path.join(basePath, this.i18n.app.vault.configDir, 'themes');
                    if (fs.existsSync(themesDir)) {
                        const entries = fs.readdirSync(themesDir, { withFileTypes: true });
                        for (const entry of entries) {
                            if (!entry.isDirectory() && !(entry.isFile() && path.extname(entry.name).toLowerCase() === '.css')) continue;
                            const themeId = entry.isDirectory() ? entry.name : path.basename(entry.name, '.css');
                            const manifestPath = path.join(themesDir, themeId, 'manifest.json');
                            let currentVersion = '0.0.0';
                            if (fs.existsSync(manifestPath)) {
                                try {
                                    const themeManifest = fs.readJsonSync(manifestPath);
                                    if (themeManifest && themeManifest.version) {
                                        currentVersion = themeManifest.version;
                                    }
                                } catch (e) { }
                            }
                            const state = this.i18n.stateManager.getThemeState(themeId);
                            if (state && state.isApplied && currentVersion !== state.pluginVersion) {
                                const success = await this.applyToTheme(themeId);
                                if (success) updateitem++;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[i18n] Failed to check theme updates', error);
            }

            if (updateitem > 0) {
                this.i18n.notice.successPrefix(t('Settings.Basis.SmartTitle'), `${t('Settings.Basis.SmartUpdate')}${updateitem}${t('Settings.Basis.SmartPlugins')}`);
            }
        }

        await this.i18n.stateManager.validateVersions(app);
    }

    /**
     * 对单个插件应用当前激活的翻译 (注入)
     * @param pluginId 插件ID
     * @returns 
     */
    public async applyToPlugin(pluginId: string): Promise<boolean> {
        // @ts-ignore
        const plugin = this.i18n.app.plugins.manifests[pluginId];
        if (!plugin) return false;

        // @ts-ignore
        const pluginDir = path.join(path.normalize(this.i18n.app.vault.adapter.getBasePath()), plugin.dir ?? '');

        try {
            const sourceId = this.i18n.sourceManager.getActiveSourceId(plugin.id);
            if (!sourceId) return false;
            const applyAst = this.i18n.settings.applyAstTranslations !== false;
            const applyRegex = this.i18n.settings.applyRegexTranslations !== false;
            if (!applyAst && !applyRegex) {
                this.i18n.notice.warning(t('Common.Notices.NoApplyTranslationKinds'));
                return false;
            }

            // 交给 Rust worker 读取译文、备份、AST/Regex 替换和写回
            // @ts-ignore
            const backupBasePath = path.join(path.normalize(this.i18n.app.vault.adapter.getBasePath()), this.i18n.manifest.dir || '');
            const result = await this.i18n.companionWorkerManager.applyPluginTranslation({
                pluginId: plugin.id,
                pluginDir,
                backupBasePath,
                persistence: { basePath: this.i18n.sourceManager.getBasePath() },
                translationSourceId: sourceId,
                applyAst,
                applyRegex,
            });
            if (!result.state) return false;

            // 6. 更新状态文件
            this.i18n.stateManager.setPluginState(plugin.id, {
                id: plugin.id,
                isApplied: true,
                pluginVersion: plugin.version,
                translationVersion: result.translationVersion || '0.0.0'
            });

            // 7. 如果插件当前启用，尝试重启以加载已写入的译文；重启失败不回滚已应用文件。
            // @ts-ignore
            const wasEnabled = this.i18n.app.plugins.enabledPlugins.has(plugin.id);
            if (wasEnabled) {
                try {
                    // @ts-ignore
                    await this.i18n.app.plugins.disablePlugin(plugin.id);
                    // @ts-ignore
                    await this.i18n.app.plugins.enablePlugin(plugin.id);
                    console.log(`[i18n] Successfully injected and reloaded: ${pluginId}`);
                } catch (loadError) {
                    console.warn(`[i18n] Reload failed after applying translation to ${pluginId}; keeping written files.`, loadError);
                    this.i18n.notice.warning(`${t('Manager.Plugins.Errors.LoadFailedAfterApply') || '插件重载失败，译文已写入，请手动检查插件状态。'} ${String(loadError)}`);
                }
            } else {
                console.log(`[i18n] Injected but plugin is disabled: ${pluginId}`);
            }

            return true;
        } catch (error) {
            console.error(`[i18n] Failed to inject translation to ${pluginId}:`, error);
            return false;
        }
    }

    /**
     * 对单个主题应用当前激活的翻译 (注入)
     * @param themeId 主题ID
     * @returns 
     */
    public async applyToTheme(themeId: string): Promise<boolean> {
        // @ts-ignore
        const basePath = path.normalize(this.i18n.app.vault.adapter.getBasePath());
        const themesDir = path.join(basePath, this.i18n.app.vault.configDir, 'themes');
        let themeDir = path.join(themesDir, themeId);
        let themeCssPath = path.join(themeDir, 'theme.css');
        let themeCssRelativePath = 'theme.css';

        if (!fs.existsSync(themeCssPath)) {
            const legacyThemeCssPath = path.join(themesDir, `${themeId}.css`);
            if (fs.existsSync(legacyThemeCssPath)) {
                themeDir = themesDir;
                themeCssPath = legacyThemeCssPath;
                themeCssRelativePath = `${themeId}.css`;
            }
        }

        if (!fs.existsSync(themeCssPath)) return false;

        try {
            // Read manifest 
            let themeVersion = '0.0.0';
            const manifestPath = path.join(themeDir, 'manifest.json');
            if (fs.existsSync(manifestPath)) {
                try {
                    const manifest = fs.readJsonSync(manifestPath);
                    if (manifest && manifest.version) themeVersion = manifest.version;
                } catch (e) { }
            }

            const sourceId = this.i18n.sourceManager.getActiveSourceId(themeId);
            if (!sourceId) return false;

            // Apply theme translation in Rust worker. The worker reads the translation JSON by source id.
            // @ts-ignore
            const backupBasePath = path.join(path.normalize(this.i18n.app.vault.adapter.getBasePath()), this.i18n.manifest.dir || '');
            const result = await this.i18n.companionWorkerManager.applyThemeTranslation({
                themeId,
                themeDir,
                themeCssPath,
                themeCssRelativePath,
                backupBasePath,
                persistence: { basePath: this.i18n.sourceManager.getBasePath() },
                translationSourceId: sourceId,
            });
            if (!result.state) return false;

            this.i18n.stateManager.setThemeState(themeId, {
                id: themeId,
                isApplied: true,
                pluginVersion: themeVersion,
                translationVersion: result.translationVersion || '1.0.0'
            });

            console.log(`[i18n] Successfully injected theme: ${themeId}`);

            return true;
        } catch (error) {
            console.error(`[i18n] Failed to inject translation to ${themeId}:`, error);
            return false;
        }
    }
}
