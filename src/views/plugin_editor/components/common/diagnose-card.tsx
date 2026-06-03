import React from 'react';
import { Button, Badge, Input, Label, Separator } from "~/shadcn";
import { TemplateCard } from './template-card';
import {
    Activity, AlertTriangle, CheckCircle2, ChevronRight, Clock3,
    Play, CircleDot, Trash2, Loader2, Square
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from "~/shadcn/lib/utils";
import { DiagnoseError } from '../../types';

interface DiagnoseCardProps {
    onDiagnose: () => void;
    onStopDiagnose?: () => void;
    isDiagnosing: boolean;
    errorItems: DiagnoseError[];
    hasChecked?: boolean;
    setActiveTab?: (tab: string) => void;
    onJumpError?: (error: DiagnoseError) => void;
    onCleanIssues?: () => void;
    isCleaningIssues?: boolean;
    switchCooldownMs: number;
    onSwitchCooldownChange: (value: number) => number;
}

export const DiagnoseCard: React.FC<DiagnoseCardProps> = ({
    onDiagnose,
    onStopDiagnose,
    isDiagnosing,
    errorItems,
    hasChecked,
    setActiveTab,
    onJumpError,
    onCleanIssues,
    isCleaningIssues,
    switchCooldownMs,
    onSwitchCooldownChange
}) => {
    const { t } = useTranslation();
    const [cooldownInput, setCooldownInput] = React.useState(String(switchCooldownMs));

    React.useEffect(() => {
        setCooldownInput(String(switchCooldownMs));
    }, [switchCooldownMs]);

    const handleCooldownBlur = () => {
        const nextValue = Number.parseInt(cooldownInput, 10);
        if (Number.isFinite(nextValue)) {
            setCooldownInput(String(onSwitchCooldownChange(nextValue)));
        } else {
            setCooldownInput(String(switchCooldownMs));
        }
    };

    const handleJump = (error: DiagnoseError) => {
        if (setActiveTab) {
            setActiveTab(error.type);
        }
        if (onJumpError) {
            onJumpError(error);
        }
        window.dispatchEvent(new CustomEvent('i18n-jump-error', {
            detail: { type: error.type, id: error.id }
        }));
    };

    const totalCount = errorItems.length;

    const errorStyles = {
        bg: 'bg-destructive/5 hover:bg-destructive/10',
        border: 'border-destructive/15 hover:border-destructive/30',
        text: 'text-destructive',
        badgeBg: 'bg-destructive/10 text-destructive border-destructive/20',
    };

    const getErrorLabel = (error: DiagnoseError) => {
        return error.type.toUpperCase();
    };

    return (
        <TemplateCard
            title={t('Editor.Actions.PreflightCheck')}
            icon={Activity}
        >
            <div className="space-y-3">
                <Button
                    size="sm"
                    className="w-full gap-2 h-9 text-xs font-medium transition-all duration-200 border border-blue-500/20 bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 dark:text-blue-400 hover:scale-[1.01] active:scale-95"
                    variant="outline"
                    onClick={isDiagnosing ? onStopDiagnose : onDiagnose}
                >
                    {isDiagnosing ? (
                        <>
                            <Square className="w-3.5 h-3.5" />
                            {t('Editor.Actions.StopPreflightCheck')}
                        </>
                    ) : (
                        <>
                            <Play className="w-3.5 h-3.5" />
                            {t('Editor.Actions.PreflightCheck')}
                        </>
                    )}
                </Button>

                <div className="space-y-1.5">
                    <Label
                        htmlFor="i18n-preflight-switch-cooldown"
                        className="flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground"
                    >
                        <Clock3 className="w-3 h-3" />
                        {t('Editor.Labels.PreflightSwitchCooldown')}
                    </Label>
                    <Input
                        id="i18n-preflight-switch-cooldown"
                        type="number"
                        min={500}
                        max={60000}
                        step={500}
                        value={cooldownInput}
                        onChange={(event) => setCooldownInput(event.target.value)}
                        onBlur={handleCooldownBlur}
                        disabled={isDiagnosing}
                        className="h-8 text-xs"
                        aria-label={t('Editor.Labels.PreflightSwitchCooldown')}
                    />
                </div>

                {/* ═══════ 统计概览 ═══════ */}
                {errorItems.length > 0 && (
                    <>
                        <Separator />
                        <div className="flex items-center gap-2">
                            <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 text-[10px] px-1.5 py-0 h-5 gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                {totalCount}
                            </Badge>
                            <span className="ml-auto text-[10px] text-muted-foreground font-medium">
                                {t('Editor.Errors.TotalCount', { count: totalCount })}
                            </span>
                        </div>
                        {onCleanIssues && (
                            <Button
                                size="sm"
                                variant="outline"
                                className="w-full h-8 gap-2 text-xs text-destructive border-destructive/20 bg-destructive/5 hover:bg-destructive/10"
                                onClick={onCleanIssues}
                                disabled={isDiagnosing || isCleaningIssues}
                            >
                                {isCleaningIssues ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <Trash2 className="w-3.5 h-3.5" />
                                )}
                                {t('Editor.Actions.CleanDiagnoseIssues')}
                            </Button>
                        )}
                    </>
                )}

                {/* ═══════ 错误列表 ═══════ */}
                {errorItems.length > 0 && (
                    <div className="max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
                        <div className="space-y-1.5">
                            {errorItems.map((error, index) => {
                                const label = getErrorLabel(error);

                                return (
                                    <div
                                        key={index}
                                        className={cn(
                                            "group flex items-start gap-2.5 p-2 rounded-lg border cursor-pointer transition-all duration-200",
                                            errorStyles.bg, errorStyles.border
                                        )}
                                        onClick={() => handleJump(error)}
                                        title={t('Editor.Labels.ClickToJump')}
                                    >
                                        {/* 左侧状态指示器 */}
                                        <div className="flex flex-col items-center gap-1 pt-0.5">
                                            <CircleDot className={cn("w-3.5 h-3.5 shrink-0", errorStyles.text)} />
                                        </div>

                                        {/* 内容区 */}
                                        <div className="flex-1 min-w-0 space-y-0.5">
                                            <div className="flex items-center gap-1.5">
                                                <Badge
                                                    variant="outline"
                                                    className={cn(
                                                        "h-4 px-1 text-[8px] uppercase font-bold shrink-0",
                                                        errorStyles.badgeBg
                                                    )}
                                                >
                                                    {label}
                                                </Badge>
                                                <span className="text-[9px] font-mono text-muted-foreground truncate">
                                                    {error.file}
                                                </span>
                                                <span className={cn(
                                                    "text-[9px] font-mono opacity-50",
                                                    errorStyles.text
                                                )}>
                                                    #{index + 1}
                                                </span>
                                            </div>
                                            <p className={cn(
                                                "text-[11px] font-medium break-all line-clamp-2 leading-relaxed",
                                                errorStyles.text
                                            )}>
                                                {error.message && <span className="opacity-80">{error.message}: </span>}
                                                <span className="font-mono">"{error.source}"</span>
                                            </p>
                                        </div>

                                        {/* 右侧操作按钮 */}
                                        <div className="flex items-center gap-0.5 shrink-0 mt-0.5">
                                            <ChevronRight className={cn(
                                                "w-3.5 h-3.5 shrink-0 transition-all duration-200",
                                                "opacity-0 -translate-x-1 group-hover:opacity-70 group-hover:translate-x-0",
                                                errorStyles.text
                                            )} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* ═══════ 通过状态 ═══════ */}
                {hasChecked && errorItems.length === 0 && !isDiagnosing && (
                    <div className="flex items-center gap-2.5 p-2.5 rounded-lg bg-green-500/10 border border-green-500/20 transition-all duration-300 animate-in fade-in-50 slide-in-from-top-2">
                        <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
                        <span className="text-[11px] font-medium text-green-700 dark:text-green-300">
                            {t('Editor.Notices.DiagnosisSuccess')}
                        </span>
                    </div>
                )}
            </div>
        </TemplateCard>
    );
};
