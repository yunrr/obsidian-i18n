import React, { useState, useCallback, useEffect } from 'react';
import { Notice } from 'obsidian';
import { useTranslation } from 'react-i18next';
import I18N from 'src/main';
import { Tabs, TabsContent, TabsList, TabsTrigger, Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/shadcn';
import { useCloudStore } from '../cloud/cloud-store';
import { PluginManager } from './plugin-manager';
import { ThemeManager } from './theme-manager';
import { AutoManagerPanel } from './components/auto-manager-panel';
import { TranslationManagerPanel } from './components/translation-manager-panel';
import { CreditsPanel } from './components/credits-panel';
import { LayoutGrid, Palette, Settings, Cloud, CircleHelp, Loader2, Coffee, ShieldAlert, MonitorPlay, Heart, FileJson } from 'lucide-react';
import Url from 'src/constants/url';
import { WIZARD_VIEW_TYPE } from '../../views';
import { CLOUD_VIEW_TYPE } from '../cloud';
import { AdminPanel } from './components/admin-panel';
import { useGlobalStoreInstance } from '~/utils/store/global';

interface ManagerLayoutProps {
    i18n: I18N;
    close: () => void;
}

export const ManagerLayout: React.FC<ManagerLayoutProps> = ({ i18n, close }) => {
    const { t } = useTranslation();
    const app = i18n.app;
    const triggerSourceUpdate = useGlobalStoreInstance((state) => state.triggerSourceUpdate);

    // 管理员状态
    const isAdmin = useCloudStore.use.isAdmin();
    const githubUser = useCloudStore.use.githubUser();
    const fetchGithubUser = useCloudStore.use.fetchGithubUser();

    // 自动检测管理员身份
    useEffect(() => {
        if (i18n.settings.shareToken && !githubUser) {
            fetchGithubUser(i18n);
        }
    }, [i18n.settings.shareToken, githubUser, fetchGithubUser, i18n]);

    const handleManagerTabChange = useCallback((val: string) => {
        i18n.settings.managerTab = val;
        i18n.saveSettings();
        i18n.sourceManager.reloadFromDisk();
        triggerSourceUpdate();
    }, [i18n, triggerSourceUpdate]);

    return (
        <div className="flex flex-col h-full bg-background overflow-hidden">
            <Tabs defaultValue={i18n.settings.managerTab || 'plugins'} onValueChange={handleManagerTabChange} className="flex flex-col h-full gap-0"   >
                {/* 顶部工具栏：左侧 Tab 切换 + 右侧功能按钮 */}
                <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
                    {/* 左侧：Tab 切换器 */}
                    <TabsList className="h-9 p-1 bg-muted/50 border rounded-none shadow-inner">
                        <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="plugins">
                            <LayoutGrid className="w-3.5 h-3.5" />
                            {t('Manager.Plugins.TabName')}
                        </TabsTrigger>
                        <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="themes">
                            <Palette className="w-3.5 h-3.5" />
                            {t('Manager.Themes.TabName')}
                        </TabsTrigger>
                        <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="sources">
                            <FileJson className="w-3.5 h-3.5" />
                            {t('Manager.Sources.TabName')}
                        </TabsTrigger>
                        <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="auto">
                            <MonitorPlay className="w-3.5 h-3.5" />
                            {t('Manager.Auto.TabName', '自动化')}
                        </TabsTrigger>
                        <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="credits">
                            <Heart className="w-3.5 h-3.5" />
                            {t('Manager.Credits.TabName', '鸣谢')}
                        </TabsTrigger>
                        {isAdmin && (
                            <TabsTrigger className="h-7 text-xs data-[state=active]:shadow-sm gap-1.5 px-3 rounded-none" value="admin">
                                <ShieldAlert className="w-3.5 h-3.5" />
                                {t('Manager.Admin.TabName', '管理')}
                            </TabsTrigger>
                        )}
                    </TabsList>
                    <div className="flex items-center border rounded-none divide-x bg-background shadow-sm overflow-hidden">
                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" className="rounded-none h-9 px-3 hover:bg-muted gap-2 text-xs" onClick={() => window.open(Url.SPONSOR)}>
                                        <Coffee className="w-4 h-4" />
                                        <span>{t('Manager.Common.Actions.Sponsor')}</span>
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('Manager.Common.Actions.Sponsor')}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" className="rounded-none h-9 px-3 hover:bg-muted gap-2 text-xs" onClick={() => { i18n.view.activateView(WIZARD_VIEW_TYPE); }}>
                                        <CircleHelp className="w-4 h-4" />
                                        <span>{t('Manager.Common.Actions.Help')}</span>
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('Manager.Common.Actions.HelpDoc')}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" className="rounded-none h-9 px-3 hover:bg-muted gap-2 text-xs" onClick={() => {
                                        i18n.view.activateView(CLOUD_VIEW_TYPE);
                                    }}>
                                        <Cloud className="w-4 h-4" />
                                        <span>{t('Manager.Common.Actions.Cloud')}</span>
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('Manager.Common.Actions.Cloud')}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>

                        <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button variant="ghost" className="rounded-none h-9 px-3 hover:bg-muted gap-2 text-xs" onClick={() => {
                                        // @ts-ignore
                                        app.setting.open();
                                        // @ts-ignore
                                        app.setting.openTabById(i18n.manifest.id);
                                    }}>
                                        <Settings className="w-4 h-4" />
                                        <span>{t('Manager.Common.Actions.Settings')}</span>
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>{t('Manager.Common.Actions.Settings')}</TooltipContent>
                            </Tooltip>
                        </TooltipProvider>
                    </div>
                </div>

                {/* Tab 内容区域 */}
                <TabsContent value="plugins" className="flex-1 min-h-0 m-0 focus-visible:ring-0">
                    <PluginManager i18n={i18n} close={close} />
                </TabsContent>

                <TabsContent value="themes" className="flex-1 min-h-0 m-0 focus-visible:ring-0">
                    <ThemeManager i18n={i18n} />
                </TabsContent>

                <TabsContent value="sources" className="flex-1 min-h-0 m-0 focus-visible:ring-0 overflow-hidden flex flex-col">
                    <TranslationManagerPanel i18n={i18n} />
                </TabsContent>

                <TabsContent value="auto" className="flex-1 min-h-0 m-0 focus-visible:ring-0 overflow-y-auto w-full">
                    <AutoManagerPanel i18n={i18n} />
                </TabsContent>

                <TabsContent value="credits" className="flex-1 min-h-0 m-0 focus-visible:ring-0 overflow-hidden flex flex-col">
                    <CreditsPanel i18n={i18n} />
                </TabsContent>

                {isAdmin && (
                    <TabsContent value="admin" className="flex-1 min-h-0 m-0 focus-visible:ring-0 overflow-hidden flex flex-col">
                        <AdminPanel i18n={i18n} />
                    </TabsContent>
                )}
            </Tabs>
        </div>
    );
};
