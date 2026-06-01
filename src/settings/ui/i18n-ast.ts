import { Notice, Setting } from "obsidian"
import BaseSetting from "../base-setting"
import { t } from "src/locales";
import { AstExtractionProfile } from "../data";
import { InputModal } from "./input-modal";
import { AST_BUILT_IN_PROFILE_IDS } from "src/utils/translator/config";

export default class I18nAST extends BaseSetting {
    private get activeProfile(): AstExtractionProfile {
        return this.settings.astProfiles.find(profile => profile.id === this.settings.activeAstProfileId) || this.settings.astProfiles[0];
    }

    private makeProfile(name: string, source?: AstExtractionProfile): AstExtractionProfile {
        const base = source || this.activeProfile;
        return {
            id: `ast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            astAssignments: [...base.astAssignments],
            astFunctions: [...base.astFunctions],
            astKeys: [...base.astKeys],
            astMaxLength: base.astMaxLength,
            astRejectRe: [...base.astRejectRe],
            astValidRe: [...base.astValidRe],
        };
    }

    private openNameModal(title: string, initialValue: string, onSubmit: (value: string) => Promise<void>) {
        new InputModal(this.app, title, t('Settings.Ast.ProfileNamePlaceholder'), initialValue, async (value) => {
            const name = value.trim();
            if (!name) return;
            await onSubmit(name);
            this.main();
        }).open();
    }

    main(): void {
        const { containerEl } = this;
        containerEl.empty();
        const profile = this.activeProfile;

        new Setting(containerEl)
            .setName(t('Settings.Ast.ProfileHeader'))
            .setHeading();

        new Setting(containerEl)
            .setName(t('Settings.Ast.EnableTitle'))
            .setDesc(t('Settings.Ast.EnableDesc'))
            .addToggle(toggle => toggle
                .setValue(this.settings.astExtractionEnabled !== false)
                .onChange(async (value) => {
                    this.settings.astExtractionEnabled = value;
                    await this.i18n.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName(t('Settings.Ast.ProfileSelectTitle'))
            .setDesc(t('Settings.Ast.ProfileSelectDesc'))
            .addDropdown(dropdown => {
                this.settings.astProfiles.forEach(item => dropdown.addOption(item.id, item.name));
                dropdown.setValue(this.settings.activeAstProfileId)
                    .onChange(async (value) => {
                        this.settings.activeAstProfileId = value;
                        await this.i18n.saveSettings();
                        this.main();
                    });
            })
            .addButton(button => button
                .setButtonText(t('Settings.Ast.ProfileAddBtn'))
                .onClick(() => this.openNameModal(t('Settings.Ast.ProfileAddTitle'), '', async (name) => {
                    const next = this.makeProfile(name);
                    this.settings.astProfiles.push(next);
                    this.settings.activeAstProfileId = next.id;
                    await this.i18n.saveSettings();
                    new Notice(t('Settings.Ast.ProfileAddNotice'));
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Ast.ProfileCopyBtn'))
                .onClick(() => this.openNameModal(t('Settings.Ast.ProfileCopyTitle'), `${profile.name} Copy`, async (name) => {
                    const next = this.makeProfile(name, profile);
                    this.settings.astProfiles.push(next);
                    this.settings.activeAstProfileId = next.id;
                    await this.i18n.saveSettings();
                    new Notice(t('Settings.Ast.ProfileAddNotice'));
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Ast.ProfileRenameBtn'))
                .onClick(() => this.openNameModal(t('Settings.Ast.ProfileRenameTitle'), profile.name, async (name) => {
                    profile.name = name;
                    await this.i18n.saveSettings();
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Ast.ProfileDelBtn'))
                .setWarning()
                .setDisabled(AST_BUILT_IN_PROFILE_IDS.includes(profile.id) || this.settings.astProfiles.length <= 1)
                .onClick(async () => {
                    if (AST_BUILT_IN_PROFILE_IDS.includes(profile.id) || this.settings.astProfiles.length <= 1) return;
                    if (!window.confirm(t('Settings.Ast.ProfileDelConfirm'))) return;
                    this.settings.astProfiles = this.settings.astProfiles.filter(item => item.id !== profile.id);
                    this.settings.activeAstProfileId = this.settings.astProfiles[0].id;
                    await this.i18n.saveSettings();
                    this.main();
                })
            );

        // ==============================
        // 1. 提取上下文配置
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Ast.ConfigHeader'))
            .setHeading();

        // 变量赋值白名单
        new Setting(containerEl)
            .setName(t('Settings.Ast.AssignTitle'))
            .setDesc(t('Settings.Ast.AssignDesc'))
            .addTextArea(text => {
                text.setValue((profile.astAssignments || []).join('\n'))
                    .setPlaceholder(t('Settings.Ast.AssignPlaceholder'))
                    .onChange(async (value) => {
                        profile.astAssignments = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 3;
                text.inputEl.style.width = '100%';
            });

        // 函数调用白名单
        new Setting(containerEl)
            .setName(t('Settings.Ast.FuncTitle'))
            .setDesc(t('Settings.Ast.FuncDesc'))
            .addTextArea(text => {
                text.setValue((profile.astFunctions || []).join('\n'))
                    .setPlaceholder(t('Settings.Ast.FuncPlaceholder'))
                    .onChange(async (value) => {
                        profile.astFunctions = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        // 对象键名白名单
        new Setting(containerEl)
            .setName(t('Settings.Ast.KeyTitle'))
            .setDesc(t('Settings.Ast.KeyDesc'))
            .addTextArea(text => {
                text.setValue((profile.astKeys || []).join('\n'))
                    .setPlaceholder(t('Settings.Ast.KeyPlaceholder'))
                    .onChange(async (value) => {
                        profile.astKeys = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        // ==============================
        // 内容过滤规则 (正则)
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Ast.RegexHeader'))
            .setHeading();

        // 内容长度上限
        new Setting(containerEl)
            .setName(t('Settings.Ast.MaxLengthTitle'))
            .setDesc(t('Settings.Ast.MaxLengthDesc'))
            .addSlider(slider => slider
                .setDynamicTooltip()
                .setLimits(0, 3000, 100)
                .setValue(profile.astMaxLength ?? 300)
                .onChange(async (value) => {
                    profile.astMaxLength = value;
                    await this.i18n.saveSettings();
                })
            );

        // 排除正则列表
        new Setting(containerEl)
            .setName(t('Settings.Ast.RejectReTitle'))
            .setDesc(t('Settings.Ast.RejectReDesc'))
            .addTextArea(text => {
                text.setValue((profile.astRejectRe || []).join('\n'))
                    .setPlaceholder(t('Settings.Ast.RejectPlaceholder'))
                    .onChange(async (value) => {
                        profile.astRejectRe = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 6;
                text.inputEl.style.width = '100%';
            });

        // 有效特征正则
        new Setting(containerEl)
            .setName(t('Settings.Ast.ValidReTitle'))
            .setDesc(t('Settings.Ast.ValidReDesc'))
            .addTextArea(text => {
                text.setValue((profile.astValidRe || []).join('\n'))
                    .setPlaceholder(t('Settings.Ast.ValidPlaceholder'))
                    .onChange(async (value) => {
                        profile.astValidRe = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 3;
                text.inputEl.style.width = '100%';
            });

        // ==============================
        // 翻译提示词配置
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Ast.PromptHeader'))
            .setHeading();

        // AST Prompt 配置
        const astPromptSetting = new Setting(containerEl)
            .setName(t('Settings.Ast.PromptTitle'))
            .setDesc(t('Settings.Ast.PromptDesc'));

        astPromptSetting.addTextArea(text => {
            text.setValue(this.settings.llmAstPrompt || '')
                .setPlaceholder(t('Settings.Ast.PromptPlaceholder'))
                .onChange(async (value) => {
                    this.settings.llmAstPrompt = value;
                    await this.i18n.saveSettings();
                });

            // 样式调整
            text.inputEl.rows = 8;
            text.inputEl.addClass('i18n-settings-textarea');
            text.inputEl.style.width = '100%';
        });
    }
}
