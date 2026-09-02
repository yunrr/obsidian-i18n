import { Notice, Setting } from "obsidian";
import BaseSetting from "../base-setting";
import { t } from "src/locales";
import { getSettingWithDefault, putSetting } from "src/imt/kiss/vendor/libs/storage";
import { OPT_LANGS_TO, OPT_TRANS_BUILTINAI } from "src/imt/kiss/vendor/config/api";
import { OPT_STYLE_ALL } from "src/imt/kiss/vendor/config/styles";

// 自动更新
export default class I18nModIMT extends BaseSetting {
    main(): void {

        const modeToggle = new Setting(this.containerEl);
        modeToggle.setName(`${t('Settings.Immersive.Title')}`);
        modeToggle.setDesc(t('Settings.Immersive.Desc'));
        modeToggle.addToggle(cb => {
            cb.setValue(this.settings.modeImt)
                .onChange(async (value) => {
                    this.settings.modeImt = value;
                    await this.i18n.saveSettings();
                    this.settingTab.imtDisplay();
                    value ? this.i18n.coreManager.activateIMT() : this.i18n.coreManager.deactivateIMT();
                });
        });

        // [设置组] 沉浸式翻译配置
        new Setting(this.containerEl).setName(t('Settings.Immersive.CoreControl')).setDesc(t('Settings.Immersive.CoreControlDesc')).setHeading();

        // [设置项] 精确指定需要翻译和排除的页面元素
        const selectorsTextArea = new Setting(this.containerEl);
        selectorsTextArea.setName(t('Settings.Immersive.MatchTitle'));
        selectorsTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.MatchDesc'),
            example: '',
            notice: t('Settings.Immersive.MatchNotice')
        }));
        selectorsTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.selectors ? (Array.isArray(this.settings.imtPagerule.selectors) ? this.settings.imtPagerule.selectors.join('\n') : this.settings.imtPagerule.selectors) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.selectors = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 精确指定需要排除的页面元素
        const excludeSelectorsTextArea = new Setting(this.containerEl);
        excludeSelectorsTextArea.setName(t('Settings.Immersive.ExcludeTitle'));
        excludeSelectorsTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.ExcludeDesc'),
            example: '',
            notice: ''
        }));
        excludeSelectorsTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.excludeSelectors ? (Array.isArray(this.settings.imtPagerule.excludeSelectors) ? this.settings.imtPagerule.excludeSelectors.join('\n') : this.settings.imtPagerule.excludeSelectors) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.excludeSelectors = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');;
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 根节点范围
        const mainFrameTextArea = new Setting(this.containerEl);
        mainFrameTextArea.setName(t('Settings.Immersive.MainFrameTitle'));
        mainFrameTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.MainFrameDesc'),
            example: '',
        }));
        mainFrameTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.mainFrameSelector ? (Array.isArray(this.settings.imtPagerule.mainFrameSelector) ? this.settings.imtPagerule.mainFrameSelector.join('\n') : this.settings.imtPagerule.mainFrameSelector) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.mainFrameSelector = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 保持原样选择器
        const stayOriginalTextArea = new Setting(this.containerEl);
        stayOriginalTextArea.setName(t('Settings.Immersive.StayOriginalTitle'));
        stayOriginalTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.StayOriginalDesc'),
            example: '',
        }));
        stayOriginalTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.stayOriginalSelectors ? (Array.isArray(this.settings.imtPagerule.stayOriginalSelectors) ? this.settings.imtPagerule.stayOriginalSelectors.join('\n') : this.settings.imtPagerule.stayOriginalSelectors) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.stayOriginalSelectors = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 额外块元素
        const extraBlockTextArea = new Setting(this.containerEl);
        extraBlockTextArea.setName(t('Settings.Immersive.ExtraBlockTitle'));
        extraBlockTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.ExtraBlockDesc'),
            example: '',
        }));
        extraBlockTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.extraBlockSelectors ? (Array.isArray(this.settings.imtPagerule.extraBlockSelectors) ? this.settings.imtPagerule.extraBlockSelectors.join('\n') : this.settings.imtPagerule.extraBlockSelectors) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.extraBlockSelectors = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 额外行内元素
        const extraInlineTextArea = new Setting(this.containerEl);
        extraInlineTextArea.setName(t('Settings.Immersive.ExtraInlineTitle'));
        extraInlineTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.ExtraInlineDesc'),
            example: '',
        }));
        extraInlineTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.extraInlineSelectors ? (Array.isArray(this.settings.imtPagerule.extraInlineSelectors) ? this.settings.imtPagerule.extraInlineSelectors.join('\n') : this.settings.imtPagerule.extraInlineSelectors) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.extraInlineSelectors = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 译文类名
        const translationClassesTextArea = new Setting(this.containerEl);
        translationClassesTextArea.setName(t('Settings.Immersive.TranslationClassesTitle'));
        translationClassesTextArea.setDesc(createStructuredDesc({
            type: 'string[]',
            desc: t('Settings.Immersive.TranslationClassesDesc'),
            example: '',
        }));
        translationClassesTextArea.addTextArea(cb => cb
            .setValue(this.settings.imtPagerule.translationClasses ? (Array.isArray(this.settings.imtPagerule.translationClasses) ? this.settings.imtPagerule.translationClasses.join('\n') : this.settings.imtPagerule.translationClasses) : '')
            .onChange(async (v) => {
                this.settings.imtPagerule.translationClasses = v.split('\n').filter(item => typeof item === 'string' && item.trim() !== '');
                await this.i18n.saveSettings();
            })
            .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); }
        );

        // [设置项] 注入 CSS
        const injectedCssTextArea = new Setting(this.containerEl);
        injectedCssTextArea.setName(t('Settings.Immersive.InjectedCssTitle'));
        injectedCssTextArea.setDesc(createStructuredDesc({
            type: 'string',
            desc: t('Settings.Immersive.InjectedCssDesc'),
            example: '',
        }));
        injectedCssTextArea.addTextArea(cb => {
            cb.setValue(this.settings.imtPagerule.injectedCss ? (Array.isArray(this.settings.imtPagerule.injectedCss) ? this.settings.imtPagerule.injectedCss.join('\n') : this.settings.imtPagerule.injectedCss) : '')
                .onChange(async (v) => {
                    this.settings.imtPagerule.injectedCss = v;
                    await this.i18n.saveSettings();
                })
                .inputEl.onblur = () => { new Notice(t('Settings.Immersive.RestartNotice'), 5000); };
            cb.inputEl.setAttr("rows", 4);
        });

        // [设置组] Kiss 翻译核心（多供应商 / 接口 / 提示词 / 译文样式）
        new Setting(this.containerEl).setName(t('Settings.Immersive.KissHeader')).setDesc(t('Settings.Immersive.KissHeaderDesc')).setHeading();
        void this.renderKissSettings();
    }

    /** 读取 kiss 核心设置（含默认值合并） */
    private async loadKissSetting(): Promise<any> {
        return await getSettingWithDefault() as any;
    }

    /** 获取当前选中的 kiss 翻译 API 配置 */
    private pickKissApi(setting: any): any {
        const apis: any[] = Array.isArray(setting?.transApis) ? setting.transApis : [];
        return apis.find(api => api.apiSlug === setting.selectedApiSlug) || apis[0] || {};
    }

    /** 修改 kiss 核心设置并持久化到插件数据 */
    private async saveKissSetting(mutate: (setting: any) => void): Promise<void> {
        const setting = await this.loadKissSetting();
        mutate(setting);
        await putSetting(setting);
    }

    /** 渲染 Kiss 翻译核心配置区（供应商/接口参数/目标语言/译文样式/提示词） */
    private async renderKissSettings(): Promise<void> {
        const kiss = await this.loadKissSetting();
        const apis: any[] = Array.isArray(kiss.transApis) ? kiss.transApis : [];
        const activeApi = this.pickKissApi(kiss);

        // [设置项] 翻译供应商
        const providerSetting = new Setting(this.containerEl);
        providerSetting.setName(t('Settings.Immersive.KissProvider'));
        providerSetting.setDesc(t('Settings.Immersive.KissProviderDesc'));
        providerSetting.addDropdown(cb => {
            apis.filter(api => !api.isDisabled && api.apiType !== OPT_TRANS_BUILTINAI).forEach(api => {
                cb.addOption(api.apiSlug, api.apiName || api.apiSlug);
            });
            cb.setValue(activeApi.apiSlug || '');
            cb.onChange(async (value) => {
                await this.saveKissSetting(s => { s.selectedApiSlug = value; });
                this.settingTab.imtDisplay(); // 切换供应商后重渲染，载入对应参数
            });
        });

        // [设置项] API Key
        const apiKeySetting = new Setting(this.containerEl);
        apiKeySetting.setName(t('Settings.Immersive.KissApiKey'));
        apiKeySetting.setDesc(t('Settings.Immersive.KissApiKeyDesc'));
        apiKeySetting.addText(cb => cb
            .setValue(activeApi.apiKey || '')
            .onChange(async (v) => {
                await this.saveKissSetting(s => { this.pickKissApi(s).apiKey = v.trim(); });
            })
        );

        // [设置项] 接口地址
        const baseUrlSetting = new Setting(this.containerEl);
        baseUrlSetting.setName(t('Settings.Immersive.KissBaseUrl'));
        baseUrlSetting.setDesc(t('Settings.Immersive.KissBaseUrlDesc'));
        baseUrlSetting.addText(cb => cb
            .setValue(activeApi.baseURL || '')
            .onChange(async (v) => {
                await this.saveKissSetting(s => { this.pickKissApi(s).baseURL = v.trim(); });
            })
        );

        // [设置项] 模型
        const modelSetting = new Setting(this.containerEl);
        modelSetting.setName(t('Settings.Immersive.KissModel'));
        modelSetting.setDesc(t('Settings.Immersive.KissModelDesc'));
        modelSetting.addText(cb => cb
            .setValue(activeApi.model || '')
            .onChange(async (v) => {
                await this.saveKissSetting(s => { this.pickKissApi(s).model = v.trim(); });
            })
        );

        // [设置项] 目标语言
        const targetLangSetting = new Setting(this.containerEl);
        targetLangSetting.setName(t('Settings.Immersive.KissTargetLang'));
        targetLangSetting.setDesc(t('Settings.Immersive.KissTargetLangDesc'));
        targetLangSetting.addDropdown(cb => {
            OPT_LANGS_TO.forEach(([code, name]) => cb.addOption(code, name));
            cb.setValue(kiss.selectedToLang || 'zh-CN');
            cb.onChange(async (v) => {
                await this.saveKissSetting(s => { s.selectedToLang = v; });
            });
        });

        // [设置项] 译文样式
        const textStyleSetting = new Setting(this.containerEl);
        textStyleSetting.setName(t('Settings.Immersive.KissTextStyle'));
        textStyleSetting.setDesc(t('Settings.Immersive.KissTextStyleDesc'));
        textStyleSetting.addDropdown(cb => {
            OPT_STYLE_ALL.forEach(slug => cb.addOption(slug, slug));
            cb.setValue(kiss.selectedTextStyle || 'style_none');
            cb.onChange(async (v) => {
                await this.saveKissSetting(s => { s.selectedTextStyle = v; });
            });
        });

        // [设置项] 批量提示词
        const systemPromptSetting = new Setting(this.containerEl);
        systemPromptSetting.setName(t('Settings.Immersive.KissSystemPrompt'));
        systemPromptSetting.setDesc(t('Settings.Immersive.KissSystemPromptDesc'));
        systemPromptSetting.addTextArea(cb => {
            cb.setValue(activeApi.systemPrompt || '')
                .onChange(async (v) => {
                    await this.saveKissSetting(s => { this.pickKissApi(s).systemPrompt = v; });
                });
            cb.inputEl.setAttr("rows", 4);
        });

        // [设置项] 非批量提示词
        const nobatchPromptSetting = new Setting(this.containerEl);
        nobatchPromptSetting.setName(t('Settings.Immersive.KissNobatchPrompt'));
        nobatchPromptSetting.setDesc(t('Settings.Immersive.KissNobatchPromptDesc'));
        nobatchPromptSetting.addTextArea(cb => {
            cb.setValue(activeApi.nobatchPrompt || '')
                .onChange(async (v) => {
                    await this.saveKissSetting(s => { this.pickKissApi(s).nobatchPrompt = v; });
                });
            cb.inputEl.setAttr("rows", 4);
        });
    }
}

type FieldConfig = {
    type: string;
    desc: string;
    example: string;
    notice?: string;
};

// 创建通用的描述生成函数
const createStructuredDesc = (config: FieldConfig) => {
    const fragment = new DocumentFragment();
    fragment.createDiv({ text: `${t('Settings.Immersive.DescLabel')} ${config.desc}` });
    if (config.notice) {
        fragment.createDiv({ text: config.notice });
    }
    return fragment;
};
