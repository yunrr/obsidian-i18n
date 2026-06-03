import { Notice, Setting } from "obsidian"
import BaseSetting from "../base-setting"
import { t } from "src/locales";
import { RegexExtractionProfile } from "../data";
import { InputModal } from "./input-modal";

export default class I18nRE extends BaseSetting {
    private get activeProfile(): RegexExtractionProfile {
        return this.settings.reProfiles.find(profile => profile.id === this.settings.activeReProfileId) || this.settings.reProfiles[0];
    }

    private makeProfile(name: string, source?: RegexExtractionProfile): RegexExtractionProfile {
        const base = source || this.activeProfile;
        return {
            id: `re-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name,
            reFlags: base.reFlags,
            reLength: base.reLength,
            reDatas: [...base.reDatas],
            reRejectRe: [...base.reRejectRe],
            reValidRe: [...base.reValidRe],
        };
    }

    private openNameModal(title: string, initialValue: string, onSubmit: (value: string) => Promise<void>) {
        new InputModal(this.app, title, t('Settings.Re.ProfileNamePlaceholder'), initialValue, async (value) => {
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
            .setName(t('Settings.Re.ProfileHeader'))
            .setHeading();

        new Setting(containerEl)
            .setName(t('Settings.Re.EnableTitle'))
            .setDesc(t('Settings.Re.EnableDesc'))
            .addToggle(toggle => toggle
                .setValue(this.settings.reExtractionEnabled !== false)
                .onChange(async (value) => {
                    this.settings.reExtractionEnabled = value;
                    await this.i18n.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName(t('Settings.Re.ApplyTitle'))
            .setDesc(t('Settings.Re.ApplyDesc'))
            .addToggle(toggle => toggle
                .setValue(this.settings.applyRegexTranslations !== false)
                .onChange(async (value) => {
                    this.settings.applyRegexTranslations = value;
                    await this.i18n.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName(t('Settings.Re.ProfileSelectTitle'))
            .setDesc(t('Settings.Re.ProfileSelectDesc'))
            .addDropdown(dropdown => {
                this.settings.reProfiles.forEach(item => dropdown.addOption(item.id, item.name));
                dropdown.setValue(this.settings.activeReProfileId)
                    .onChange(async (value) => {
                        this.settings.activeReProfileId = value;
                        await this.i18n.saveSettings();
                        this.main();
                    });
            })
            .addButton(button => button
                .setButtonText(t('Settings.Re.ProfileAddBtn'))
                .onClick(() => this.openNameModal(t('Settings.Re.ProfileAddTitle'), '', async (name) => {
                    const next = this.makeProfile(name);
                    this.settings.reProfiles.push(next);
                    this.settings.activeReProfileId = next.id;
                    await this.i18n.saveSettings();
                    new Notice(t('Settings.Re.ProfileAddNotice'));
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Re.ProfileCopyBtn'))
                .onClick(() => this.openNameModal(t('Settings.Re.ProfileCopyTitle'), `${profile.name} Copy`, async (name) => {
                    const next = this.makeProfile(name, profile);
                    this.settings.reProfiles.push(next);
                    this.settings.activeReProfileId = next.id;
                    await this.i18n.saveSettings();
                    new Notice(t('Settings.Re.ProfileAddNotice'));
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Re.ProfileRenameBtn'))
                .onClick(() => this.openNameModal(t('Settings.Re.ProfileRenameTitle'), profile.name, async (name) => {
                    profile.name = name;
                    await this.i18n.saveSettings();
                }))
            )
            .addButton(button => button
                .setButtonText(t('Settings.Re.ProfileDelBtn'))
                .setWarning()
                .setDisabled(profile.id === 'default' || this.settings.reProfiles.length <= 1)
                .onClick(async () => {
                    if (profile.id === 'default' || this.settings.reProfiles.length <= 1) return;
                    if (!window.confirm(t('Settings.Re.ProfileDelConfirm'))) return;
                    this.settings.reProfiles = this.settings.reProfiles.filter(item => item.id !== profile.id);
                    this.settings.activeReProfileId = this.settings.reProfiles[0].id;
                    await this.i18n.saveSettings();
                    this.main();
                })
            );

        // ==============================
        // 1. 正则参数配置
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Re.ParamsHeader'))
            .setHeading();

        // RE 标志
        new Setting(containerEl)
            .setName(t('Settings.Re.FlagTitle'))
            .setDesc(t('Settings.Re.FlagDesc'))
            .addText(cb => cb
                .setValue(profile.reFlags)
                .setPlaceholder(t('Settings.Re.FlagPlaceholder'))
                .onChange(async (value) => {
                    profile.reFlags = value;
                    await this.i18n.saveSettings();
                })
            );

        // RE 长度
        new Setting(containerEl)
            .setName(t('Settings.Re.LenTitle'))
            .setDesc(t('Settings.Re.LenDesc'))
            .addSlider(cb => cb
                .setDynamicTooltip()
                .setLimits(0, 3000, 100)
                .setValue(profile.reLength)
                .onChange(async (value) => {
                    profile.reLength = value
                    await this.i18n.saveSettings();
                })
            );

        // ==============================
        // 3. 正则匹配数据管理
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Re.DataHeader'))
            .setHeading();

        new Setting(containerEl)
            .setName(t('Settings.Re.DataEditTitle'))
            .setDesc(t('Settings.Re.DataEditDesc'))
            .addTextArea(text => {
                text.setValue((profile.reDatas || []).join('\n'))
                    .setPlaceholder(t('Settings.Re.DataPlaceholder'))
                    .onChange(async (value) => {
                        profile.reDatas = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 10;
                text.inputEl.style.width = '100%';
            });

        // ==============================
        // 4. 内容过滤规则 (正则)
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Re.RegexHeader'))
            .setHeading();

        new Setting(containerEl)
            .setName(t('Settings.Re.RejectReTitle'))
            .setDesc(t('Settings.Re.RejectReDesc'))
            .addTextArea(text => {
                text.setValue((profile.reRejectRe || []).join('\n'))
                    .setPlaceholder(t('Settings.Re.RejectPlaceholder'))
                    .onChange(async (value) => {
                        profile.reRejectRe = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 6;
                text.inputEl.style.width = '100%';
            });

        new Setting(containerEl)
            .setName(t('Settings.Re.ValidReTitle'))
            .setDesc(t('Settings.Re.ValidReDesc'))
            .addTextArea(text => {
                text.setValue((profile.reValidRe || []).join('\n'))
                    .setPlaceholder(t('Settings.Re.ValidPlaceholder'))
                    .onChange(async (value) => {
                        profile.reValidRe = value.split('\n').map(s => s.trim()).filter(s => s !== '');
                        await this.i18n.saveSettings();
                    });
                text.inputEl.rows = 6;
                text.inputEl.style.width = '100%';
            });

        // ==============================
        // 5. 翻译提示词配置 (正则)
        // ==============================
        new Setting(containerEl)
            .setName(t('Settings.Re.PromptHeader'))
            .setHeading();

        // Regex Prompt 配置
        const regexPromptSetting = new Setting(containerEl)
            .setName(t('Settings.Re.PromptTitle'))
            .setDesc(t('Settings.Re.PromptDesc'));

        regexPromptSetting.addTextArea(text => {
            text.setValue(this.settings.llmRegexPrompt || '')
                .setPlaceholder(t('Settings.Re.PromptPlaceholder'))
                .onChange(async (value) => {
                    this.settings.llmRegexPrompt = value;
                    await this.i18n.saveSettings();
                });

            // 样式调整
            text.inputEl.rows = 8;
            text.inputEl.addClass('i18n-settings-textarea');
            text.inputEl.style.width = '100%';
        });
    }
}
