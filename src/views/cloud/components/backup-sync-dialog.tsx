/**
 * 全量云端备份与恢复弹窗
 * 支持一键备份所有本地翻译到 GitHub 仓库、一键从云端恢复全部翻译
 */
import React, { useCallback, useState } from 'react';
import { Button } from '@/src/shadcn';
import { Progress } from '@/src/shadcn/ui/progress';
import { ScrollArea } from '@/src/shadcn/ui/scroll-area';
import { Upload, Download, CheckCircle2, Cloud, HardDrive, ArrowRight, Package, ArrowLeft, RotateCcw } from 'lucide-react';
import { useCloudStore } from '../cloud-store';
import { useGlobalStoreInstance } from '~/utils';
import { t } from '@/src/locales/index';
import { ManifestEntry } from '../types';
import { cn } from '@/src/shadcn/lib/utils';
import { LoginRequired } from './login-required';

export const BackupSyncTab: React.FC = () => {
    const i18n = useGlobalStoreInstance.getState().i18n;

    const setCurrentTab = useCloudStore.use.setCurrentTab();
    const backupDialogMode = useCloudStore.use.backupDialogMode();
    const backupProgress = useCloudStore.use.backupProgress();
    const setBackupDialogMode = useCloudStore.use.setBackupDialogMode();
    const setBackupProgress = useCloudStore.use.setBackupProgress();
    const githubUser = useCloudStore.use.githubUser();
    const setRepoManifest = useCloudStore.use.setRepoManifest();

    const userRepo = i18n.settings.shareRepo;

    const [logs, setLogs] = useState<string[]>([]);
    const [isRunning, setIsRunning] = useState(false);
    const [checkpoint, setCheckpoint] = useState<any | null>(null);

    const addLog = (msg: string) => setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

    // 检查是否有未完成的检查点
    React.useEffect(() => {
        const cp = i18n.sourceManager.loadCheckpoint();
        if (cp) {
            setCheckpoint(cp);
            addLog(t('Cloud.Notices.FoundCheckpoint', { date: new Date(cp.timestamp).toLocaleString() }));
        }
    }, [i18n.sourceManager]);

    // ========== 一键备份 (重构版：支持并发与断点) ==========
    const handleBackup = useCallback(async (isResume = false) => {
        if (!githubUser || !userRepo) return;
        setIsRunning(true);
        if (!isResume) setLogs([]);
        const username = githubUser.login;

        try {
            if (isResume) {
                addLog(t('Cloud.Status.ResumingBackup'));
            } else {
                const allSources = i18n.sourceManager.getAllSources();
                if (allSources.length === 0) {
                    addLog(t('Cloud.Hints.NoLocalSourcesBackup'));
                    setBackupProgress({ total: 0, current: 0, currentPlugin: '', phase: 'done' });
                    return;
                }
                addLog(t('Cloud.Notices.FoundLocalSources', { count: allSources.length }));
            }

            addLog(t('Cloud.Status.PreparingData'));
            const started = await i18n.companionWorkerManager.startTask('cloud-backup-all', {
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                token: i18n.settings.shareToken,
                owner: username,
                repo: userRepo,
                branch: 'main',
                language: i18n.settings.language,
                resume: isResume,
            });

            let progress = started.progress;
            let loggedUpload = false;
            const syncProgress = () => {
                setBackupProgress({
                    total: progress.totalResources,
                    current: progress.processedResources,
                    currentPlugin: progress.currentLabel,
                    phase: progress.status === 'failed' ? 'error' : 'uploading',
                    errorMessage: progress.error,
                });
                if (!loggedUpload && progress.totalResources > 0) {
                    addLog(t('Cloud.Notices.ItemsToUpload', { count: progress.totalResources }));
                    loggedUpload = true;
                }
            };

            syncProgress();
            while (progress.status === 'queued' || progress.status === 'running') {
                await new Promise(resolve => window.setTimeout(resolve, 150));
                const status = await i18n.companionWorkerManager.getTaskStatus(started.taskId);
                progress = status.progress;
                syncProgress();
            }

            if (progress.status === 'failed') throw new Error(progress.error || t('Cloud.Errors.BackupErrorMsg', { error: '' }));
            if (progress.status === 'cancelled') throw new Error(t('Common.Errors.TaskCancelled'));

            addLog(t('Cloud.Status.FinalizingLocal'));
            i18n.sourceManager.reloadFromDisk();
            const manifestRes = await i18n.api.github.getFileContentWithFallback(username, userRepo, 'metadata.json');
            if (manifestRes.state && Array.isArray(manifestRes.data)) {
                setRepoManifest(manifestRes.data as ManifestEntry[]);
            }
            useGlobalStoreInstance.getState().triggerSourceUpdate();
            setCheckpoint(null);

            setBackupProgress({ total: progress.totalResources, current: progress.totalResources, currentPlugin: '', phase: 'done' });
            addLog(progress.totalResources === 0 ? t('Cloud.Notices.BackupNoChanges') : t('Cloud.Status.BackupDone'));
            i18n.notice.successPrefix(t('Common.Notices.Success'), t('Cloud.Notices.BackupSuccessCount', { count: progress.totalResources }));
        } catch (error) {
            console.error('Backup failed:', error);
            addLog(t('Cloud.Errors.BackupErrorMsg', { error: `${error}` }));
            setBackupProgress({ total: 0, current: 0, currentPlugin: '', phase: 'error', errorMessage: `${error}` });
            i18n.notice.errorPrefix(t('Common.Notices.Failure'), `${error}`);
        } finally {
            setIsRunning(false);
        }
    }, [githubUser, userRepo, i18n, setRepoManifest, setBackupProgress]);

    const handleRestore = useCallback(async () => {
        if (!githubUser || !userRepo) return;
        if (!confirm(t('Cloud.Dialogs.ConfirmRestoreAll'))) return;

        setIsRunning(true);
        setLogs([]);
        const username = githubUser.login;

        try {
            addLog(t('Cloud.Hints.FetchingManifest'));
            const result = await i18n.companionWorkerManager.runCloudTask('cloud-restore-all', {
                persistence: { basePath: i18n.sourceManager.getBasePath() },
                token: i18n.settings.shareToken,
                owner: username,
                repo: userRepo,
                branch: 'main',
            });

            if (!result.state) {
                addLog(result.error || t('Cloud.Errors.GetManifestFail'));
                setBackupProgress({ total: 0, current: 0, currentPlugin: '', phase: 'error', errorMessage: result.error || t('Cloud.Errors.GetManifestFail') });
                return;
            }

            const manifest = result.manifest || [];
            if (!Array.isArray(manifest) || manifest.length === 0) {
                addLog(t('Cloud.Hints.NoCloudData'));
                setBackupProgress({ total: 0, current: 0, currentPlugin: '', phase: 'done' });
                return;
            }

            setRepoManifest(manifest as ManifestEntry[]);
            i18n.sourceManager.reloadFromDisk();
            useGlobalStoreInstance.getState().triggerSourceUpdate();
            setBackupProgress({ total: result.total || manifest.length, current: result.total || manifest.length, currentPlugin: '', phase: 'done' });
            addLog(t('Cloud.Notices.RestoreCompleteStat', { restored: result.restored || 0, skipped: result.skipped || 0 }));
            i18n.notice.successPrefix(t('Common.Notices.Success'), t('Cloud.Notices.RestoreSuccessCount', { count: result.restored || 0 }));
        } catch (error) {
            console.error(t('Cloud.Errors.RestoreFail'), error);
            addLog(t('Cloud.Errors.RestoreErrorMsg', { error: `${error}` }));
            setBackupProgress({ total: 0, current: 0, currentPlugin: '', phase: 'error', errorMessage: `${error}` });
            i18n.notice.errorPrefix(t('Common.Notices.Failure'), `${error}`);
        } finally {
            setIsRunning(false);
        }
    }, [githubUser, userRepo, i18n, setRepoManifest, setBackupProgress]);

    const handleClose = useCallback(() => {
        if (isRunning) return;
        setBackupDialogMode(null);
        setBackupProgress(null);
        setLogs([]);
        setCurrentTab('my');
    }, [isRunning, setBackupDialogMode, setBackupProgress, setCurrentTab]);

    if (!i18n.settings.shareToken) {
        return <LoginRequired />;
    }

    const progressPercent = backupProgress?.total ? Math.round((backupProgress.current / backupProgress.total) * 100) : 0;

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* 顶部导航栏 */}
            <div className="flex items-center justify-between px-1 pb-4 shrink-0">
                <div className="flex items-center gap-3">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 gap-1.5 text-muted-foreground hover:text-primary"
                        onClick={handleClose}
                    >
                        <ArrowLeft className="w-4 h-4" />
                        {t('Cloud.Actions.BackToManage')}
                    </Button>
                    <div className="w-[1px] h-5 bg-border/50" />
                    <div className="flex items-center gap-2">
                        <HardDrive className="w-4 h-4 text-primary" />
                        <h2 className="text-sm font-semibold">{t('Cloud.Actions.BackupSync')}</h2>
                    </div>
                </div>
            </div>

            <ScrollArea className="flex-1 min-h-0 border rounded-xl overflow-hidden bg-card">
                <div className="flex flex-col gap-6 p-6 max-w-2xl mx-auto w-full animate-in fade-in slide-in-from-bottom-4 duration-500">

                    {/* 说明区域 */}
                    <div className="text-sm text-muted-foreground bg-muted/30 p-4 rounded-lg border border-border/50">
                        {t('Cloud.Tips.BackupDesc')}
                    </div>

                    {/* 模式选择 (未开始时) */}
                    {!backupDialogMode && !isRunning && (
                        <div className="grid grid-cols-2 gap-4">
                            <button
                                onClick={() => setBackupDialogMode('backup')}
                                className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-dashed border-border/60 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                            >
                                <div className="p-3 rounded-full bg-blue-500/10 text-blue-600 group-hover:bg-blue-500/20 transition-colors">
                                    <Upload className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                    <p className="text-sm font-semibold">{t('Cloud.Tips.BackupToCloud')}</p>
                                    <p className="text-[10px] text-muted-foreground mt-1">{t('Cloud.Tips.LocalToGithub')}</p>
                                </div>
                            </button>
                            {checkpoint && (
                                <button
                                    onClick={() => handleBackup(true)}
                                    className="col-span-2 flex items-center justify-between p-4 rounded-xl border-2 border-primary/20 bg-primary/5 hover:bg-primary/10 transition-all group"
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-full bg-primary/20 text-primary">
                                            <RotateCcw className="w-5 h-5" />
                                        </div>
                                        <div className="text-left">
                                            <p className="text-sm font-semibold text-primary">{t('Cloud.Actions.ResumeLastBackup')}</p>
                                            <p className="text-[10px] text-muted-foreground">{new Date(checkpoint.timestamp).toLocaleString()}</p>
                                        </div>
                                    </div>
                                    <ArrowRight className="w-5 h-5 text-primary opacity-50 group-hover:opacity-100 transition-opacity" />
                                </button>
                            )}
                            <button
                                onClick={() => setBackupDialogMode('restore')}
                                className="flex flex-col items-center gap-3 p-6 rounded-xl border-2 border-dashed border-border/60 hover:border-primary/40 hover:bg-primary/5 transition-all group"
                            >
                                <div className="p-3 rounded-full bg-green-500/10 text-green-600 group-hover:bg-green-500/20 transition-colors">
                                    <Download className="w-6 h-6" />
                                </div>
                                <div className="text-center">
                                    <p className="text-sm font-semibold">{t('Cloud.Tips.RestoreFromCloud')}</p>
                                    <p className="text-[10px] text-muted-foreground mt-1">{t('Cloud.Tips.GithubToLocal')}</p>
                                </div>
                            </button>
                        </div>
                    )}

                    {/* 确认开始 */}
                    {backupDialogMode && !isRunning && !backupProgress && (
                        <div className="space-y-4">
                            <div className={cn(
                                "flex items-center gap-4 p-4 rounded-xl border",
                                backupDialogMode === 'backup'
                                    ? "bg-blue-500/5 border-blue-500/20"
                                    : "bg-green-500/5 border-green-500/20"
                            )}>
                                <div className="flex items-center gap-2 text-sm">
                                    {backupDialogMode === 'backup' ? (
                                        <>
                                            <HardDrive className="w-5 h-5 text-blue-600" />
                                            <span className="font-semibold">{t('Cloud.Labels.LocalTranslation')}</span>
                                            <ArrowRight className="w-4 h-4 text-muted-foreground" />
                                            <Cloud className="w-5 h-5 text-blue-600" />
                                            <span className="font-semibold">{t('Cloud.Tips.GithubRepo')}</span>
                                        </>
                                    ) : (
                                        <>
                                            <Cloud className="w-5 h-5 text-green-600" />
                                            <span className="font-semibold">{t('Cloud.Tips.GithubRepo')}</span>
                                            <ArrowRight className="w-4 h-4 text-muted-foreground" />
                                            <HardDrive className="w-5 h-5 text-green-600" />
                                            <span className="font-semibold">{t('Cloud.Labels.LocalTranslation')}</span>
                                        </>
                                    )}
                                </div>
                            </div>
                            <div className="text-xs text-muted-foreground space-y-1 px-1">
                                {backupDialogMode === 'backup' ? (
                                    <>
                                        <p>{t('Cloud.Tips.BackupStep1')}</p>
                                        <p>{t('Cloud.Tips.BackupStep2')}</p>
                                        <p>{t('Cloud.Tips.BackupStep3')}</p>
                                    </>
                                ) : (
                                    <>
                                        <p>{t('Cloud.Tips.RestoreStep1')}</p>
                                        <p>{t('Cloud.Tips.RestoreStep2')}</p>
                                        <p>{t('Cloud.Tips.RestoreStep3')}</p>
                                    </>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <Button variant="outline" className="flex-1" onClick={() => setBackupDialogMode(null)}>
                                    {t('Common.Actions.Back')}
                                </Button>
                                <Button
                                    className="flex-1"
                                    onClick={() => backupDialogMode === 'backup' ? handleBackup(false) : handleRestore()}
                                >
                                    {backupDialogMode === 'backup' ? (
                                        <><Upload className="w-4 h-4 mr-2" />{t('Cloud.Actions.StartBackup')}</>
                                    ) : (
                                        <><Download className="w-4 h-4 mr-2" />{t('Cloud.Actions.StartRestore')}</>
                                    )}
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* 进度区域 */}
                    {(isRunning || backupProgress) && (
                        <div className="space-y-3">
                            {/* 进度条 */}
                            <div className="space-y-2">
                                <div className="flex items-center justify-between text-xs">
                                    <span className="text-muted-foreground font-medium">
                                        {backupProgress?.phase === 'done'
                                            ? t('Cloud.Status.BackupDone')
                                            : backupProgress?.phase === 'error'
                                                ? t('Cloud.Status.BackupError')
                                                : backupProgress?.phase === 'uploading'
                                                    ? t('Cloud.Status.UploadingCloud')
                                                    : t('Cloud.Status.DownloadingCloud')}
                                    </span>
                                    <span className="font-mono font-semibold text-primary">
                                        {backupProgress?.current}/{backupProgress?.total}
                                    </span>
                                </div>
                                <Progress value={progressPercent} className="h-2" />
                                {backupProgress?.currentPlugin && isRunning && (
                                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                        <Package className="w-3 h-3" />
                                        <span className="truncate">{backupProgress.currentPlugin}</span>
                                    </div>
                                )}
                            </div>

                            {/* 日志 */}
                            <ScrollArea className="h-40 border rounded-lg bg-muted/10">
                                <div className="p-3 space-y-1">
                                    {logs.map((log, i) => (
                                        <p key={i} className="text-[11px] text-muted-foreground font-mono leading-relaxed">
                                            {log}
                                        </p>
                                    ))}
                                </div>
                            </ScrollArea>

                            {/* 完成按钮 */}
                            {!isRunning && backupProgress && (
                                <Button className="w-full" onClick={handleClose}>
                                    <CheckCircle2 className="w-4 h-4 mr-2" />
                                    {t('Cloud.Status.Done')}
                                </Button>
                            )}
                        </div>
                    )}
                </div>
            </ScrollArea>
        </div>
    );
};
