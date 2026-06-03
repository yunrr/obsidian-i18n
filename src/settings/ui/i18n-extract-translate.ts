import { Setting } from "obsidian";
import BaseSetting from "../base-setting";
import { t } from "src/locales";
import { SUPPORTED_LANGUAGES } from "src/constants/languages";
import { STYLES } from "src/constants/llm-options";

export default class I18nExtractTranslate extends BaseSetting {
    main(): void {
        this.translationContentUI();
        this.requestBatchUI();
        this.managerBatchUI();
        this.extractStrategyUI();
    }

    private async saveSettings() {
        await this.i18n.saveSettings();
    }

    private parsePositiveInt(value: string, fallback: number) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(1, Math.floor(parsed)) : fallback;
    }

    private parseNonNegativeInt(value: string, fallback: number) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
    }

    private translationContentUI(): void {
        new Setting(this.containerEl).setName(t('Settings.ExtractTranslate.ContentHeader')).setHeading();

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.LanguageTitle'))
            .setDesc(t('Settings.Ai.LanguageDesc'))
            .addDropdown(dropdown => {
                dropdown.addOption('', t('Settings.Ai.LanguageCustomOption'));
                SUPPORTED_LANGUAGES.forEach(language => dropdown.addOption(language.label, language.label));
                dropdown.setValue(SUPPORTED_LANGUAGES.some(language => language.label === this.settings.llmLanguage) ? this.settings.llmLanguage : '');
                dropdown.onChange(async (value) => {
                    if (!value) return;
                    this.settings.llmLanguage = value;
                    await this.saveSettings();
                    this.settingTab.extractTranslateDisplay();
                });
            })
            .addText(text => {
                text.setValue(this.settings.llmLanguage || '')
                    .setPlaceholder(t('Settings.Ai.LanguagePlaceholder'))
                    .onChange(async (value) => {
                        this.settings.llmLanguage = value.trim();
                        await this.saveSettings();
                    });
            });

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.StyleTitle'))
            .setDesc(t('Settings.Ai.StyleDesc'))
            .addDropdown(dropdown => {
                dropdown.addOption('', t('Settings.Ai.StyleCustomOption'));
                STYLES.forEach(style => dropdown.addOption(style.value, style.label));
                dropdown.setValue(STYLES.some(style => style.value === this.settings.llmStyle) ? this.settings.llmStyle : '');
                dropdown.onChange(async (value) => {
                    if (!value) return;
                    this.settings.llmStyle = value;
                    await this.saveSettings();
                    this.settingTab.extractTranslateDisplay();
                });
            })
            .addText(text => {
                text.setValue(this.settings.llmStyle || '')
                    .setPlaceholder(t('Settings.Ai.StylePlaceholder'))
                    .onChange(async (value) => {
                        this.settings.llmStyle = value.trim();
                        await this.saveSettings();
                    });
            });
    }

    private requestBatchUI(): void {
        new Setting(this.containerEl).setName(t('Settings.ExtractTranslate.RequestHeader')).setHeading();

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.BatchSizeTitle'))
            .setDesc(t('Settings.Ai.BatchSizeDesc'))
            .addText(text => {
                text.setValue(String(this.settings.llmBatchSize || 10))
                    .onChange(async (value) => {
                        this.settings.llmBatchSize = this.parsePositiveInt(value, 10);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });

        new Setting(this.containerEl)
            .setName(t('Settings.ExtractTranslate.BatchCharLimitTitle'))
            .setDesc(t('Settings.ExtractTranslate.BatchCharLimitDesc'))
            .addText(text => {
                text.setValue(String(this.settings.llmBatchCharLimit || 0))
                    .onChange(async (value) => {
                        this.settings.llmBatchCharLimit = this.parseNonNegativeInt(value, 0);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '0';
            });

        new Setting(this.containerEl)
            .setName(t('Settings.ExtractTranslate.BatchWindowMultiplierTitle'))
            .setDesc(t('Settings.ExtractTranslate.BatchWindowMultiplierDesc'))
            .addText(text => {
                text.setValue(String(this.settings.llmBatchWindowMultiplier || 4))
                    .onChange(async (value) => {
                        this.settings.llmBatchWindowMultiplier = this.parsePositiveInt(value, 4);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.LlmConcurrencyTitle'))
            .setDesc(t('Settings.Ai.LlmConcurrencyDesc'))
            .addText(text => {
                text.setValue(String(this.settings.llmConcurrencyLimit || 3))
                    .onChange(async (value) => {
                        this.settings.llmConcurrencyLimit = this.parsePositiveInt(value, 3);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.TimeoutTitle'))
            .setDesc(t('Settings.Ai.TimeoutDesc'))
            .addText(text => {
                text.setValue(String(this.settings.llmTimeout || 60000))
                    .onChange(async (value) => {
                        this.settings.llmTimeout = this.parsePositiveInt(value, 60000);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '100';
                text.inputEl.step = '1000';
            });

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.OverwriteExistingTranslationsTitle'))
            .setDesc(t('Settings.Ai.OverwriteExistingTranslationsDesc'))
            .addToggle(toggle => {
                toggle.setValue(this.settings.llmOverwriteExistingTranslations === true)
                    .onChange(async (value) => {
                        this.settings.llmOverwriteExistingTranslations = value;
                        await this.saveSettings();
                    });
            });
    }

    private managerBatchUI(): void {
        new Setting(this.containerEl).setName(t('Settings.ExtractTranslate.ManagerHeader')).setHeading();

        new Setting(this.containerEl)
            .setName(t('Settings.Ai.BatchExtractConcurrencyTitle'))
            .setDesc(t('Settings.Ai.BatchExtractConcurrencyDesc'))
            .addText(text => {
                text.setValue(String(this.settings.batchExtractConcurrency || 3))
                    .onChange(async (value) => {
                        this.settings.batchExtractConcurrency = this.parsePositiveInt(value, 3);
                        await this.saveSettings();
                    });
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
            });

    }

    private extractStrategyUI(): void {
        new Setting(this.containerEl).setName(t('Settings.ExtractTranslate.ExtractHeader')).setHeading();

        new Setting(this.containerEl)
            .setName(t('Settings.ExtractTranslate.ChineseSkipTitle'))
            .setDesc(t('Settings.ExtractTranslate.ChineseSkipDesc'))
            .addDropdown(dropdown => dropdown
                .addOption('none', t('Settings.ExtractTranslate.ChineseSkipNone'))
                .addOption('source', t('Settings.ExtractTranslate.ChineseSkipSource'))
                .addOption('extracted', t('Settings.ExtractTranslate.ChineseSkipExtracted'))
                .setValue(this.settings.chineseSkipMode || 'source')
                .onChange(async (value: 'none' | 'source' | 'extracted') => {
                    this.settings.chineseSkipMode = value;
                    await this.saveSettings();
                })
            );
    }
}
