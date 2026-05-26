import { create } from 'zustand';
import { I18nSettings } from '../../settings/data';

export type AutoLevel = 'info' | 'success' | 'warning' | 'error';

export type AutoTaskStatus = 'pending' | 'processing' | 'success' | 'error' | 'skipped' | 'up_to_date' | 'discovered_new' | 'discovered_update';
export type FilterStatus = 'all' | 'success' | 'error' | 'skipped' | 'up_to_date';

export interface AutoHistoryItem {
    id: string; // 批次 ID (通常为时间戳)
    time: number;
    trigger: 'manual' | 'startup' | 'discovery' | 'batch';
    summary: {
        total: number;
        success: number;
        error: number;
        skipped: number;
        discovered: number;
        upToDate: number;
    };
    details: string; // JSON 字符串化的任务列表快照
}

export interface AutoScoreBreakdown {
    version: number;     // 版本匹配得分 (0-50)
    popularity: number;  // 社区热度得分 (0-30)
    freshness: number;   // 新鲜度得分 (0-20)
    total: number;       // 总分
}

export interface AutoTaskItem {
    id: string;
    type: 'plugin' | 'theme';
    name?: string;
    status: AutoTaskStatus;
    message?: string;
    sourceRepo?: string;
    targetVersion?: string;
    scoreBreakdown?: AutoScoreBreakdown;
}

export interface AutoState {
    status: 'idle' | 'running' | 'success' | 'error';
    progress: {
        current: number;
        total: number;
    };
    tasks: AutoTaskItem[];
    summary: {
        upToDate: number;
        success: number;
        error: number;
        applied: number;
    };

    // 配置缓存 (从 Settings 同步)
    excludeList: string[];          // 排除名单 (插件 ID)
    trustedRepos: string[];         // 受信任仓库列表缓存
    autoDiscovery: boolean;
    autoApply: boolean;
    autoMatchStrategy: 'comprehensive' | 'version_first' | 'popularity' | 'latest_update';
    autoCheckInterval: number;
    autoScanMode: 'incremental' | 'full';

    filterStatus: FilterStatus;


    // 操作逻辑
    setStatus: (status: AutoState['status']) => void;
    setFilterStatus: (status: FilterStatus) => void;
    setProgress: (current: number, total: number) => void;
    initTasks: (tasks: AutoTaskItem[]) => void;
    updateTaskStatus: (id: string, status: AutoTaskStatus, message?: string, source?: string, version?: string, score?: AutoScoreBreakdown) => void;
    addTasks: (tasks: AutoTaskItem[]) => void;

    setSummary: (summary: Partial<AutoState['summary']>) => void;

    // 发现与历史管理
    history: AutoHistoryItem[];
    addHistory: (item: AutoHistoryItem) => void;
    setHistory: (history: AutoHistoryItem[]) => void;

    // 配置更新
    toggleExclude: (id: string) => void;
    setTrustedRepos: (repos: string[]) => void;
    addTrustedRepo: (repo: string) => void;
    removeTrustedRepo: (repo: string) => void;
    setConfigs: (configs: Partial<Pick<AutoState, 'autoDiscovery' | 'autoApply' | 'autoMatchStrategy' | 'autoCheckInterval' | 'autoScanMode'>>) => void;

    hydrate: (settings: any, extra?: { appliedCount?: number; history?: AutoHistoryItem[] }) => void;
    clearAll: () => void;
}

function addStatusToSummary(summary: AutoState['summary'], status: AutoTaskStatus, delta: number) {
    if (status === 'up_to_date') summary.upToDate += delta;
    else if (status === 'success' || status === 'discovered_new' || status === 'discovered_update') summary.success += delta;
    else if (status === 'error') summary.error += delta;
}

function summarizeTasks(tasks: AutoTaskItem[], applied: number): AutoState['summary'] {
    const summary = { upToDate: 0, success: 0, error: 0, applied };
    for (const task of tasks) addStatusToSummary(summary, task.status, 1);
    return summary;
}

export const useAutoStore = create<AutoState>((set, get) => ({
    status: 'idle',
    progress: { current: 0, total: 0 },
    tasks: [],
    summary: { upToDate: 0, success: 0, error: 0, applied: 0 },
    history: [],
    excludeList: [],
    trustedRepos: [],
    autoDiscovery: true,
    autoApply: false,
    autoMatchStrategy: 'comprehensive',
    autoCheckInterval: 24,
    autoScanMode: 'incremental',

    filterStatus: 'all',

    setStatus: (status: AutoState['status']) => set({ status }),
    setFilterStatus: (status: FilterStatus) => set({ filterStatus: status }),

    setProgress: (current, total) => set({ progress: { current, total } }),

    initTasks: (tasks) => set((state) => ({
        tasks,
        summary: summarizeTasks(tasks, state.summary.applied),
        progress: { current: 0, total: tasks.length }
    })),

    updateTaskStatus: (id, status, message, source, version, score) => set((state) => {
        const index = state.tasks.findIndex(t => t.id === id);
        if (index === -1) return {};

        const previous = state.tasks[index];
        const updated = {
            ...previous,
            status,
            message: message || previous.message,
            sourceRepo: source || previous.sourceRepo,
            targetVersion: version || previous.targetVersion,
            scoreBreakdown: score || previous.scoreBreakdown
        };

        const newTasks = state.tasks.slice();
        newTasks[index] = updated;

        const summary = { ...state.summary };
        addStatusToSummary(summary, previous.status, -1);
        addStatusToSummary(summary, status, 1);

        return { tasks: newTasks, summary };
    }),

    addTasks: (newTasks) => set((state) => {
        const summary = { ...state.summary };
        for (const task of newTasks) addStatusToSummary(summary, task.status, 1);
        return { tasks: [...state.tasks, ...newTasks], summary };
    }),

    setSummary: (summary) => set((state) => ({
        summary: { ...state.summary, ...summary }
    })),

    addHistory: (item) => set((state) => ({
        history: [item, ...state.history].slice(0, 50)
    })),

    setHistory: (history) => set({ history }),

    toggleExclude: (id) => set((state) => {
        const newList = state.excludeList.includes(id)
            ? state.excludeList.filter(x => x !== id)
            : [...state.excludeList, id];
        return { excludeList: newList };
    }),

    setTrustedRepos: (repos) => set({ trustedRepos: repos }),

    addTrustedRepo: (repo) => set((state) => ({
        trustedRepos: state.trustedRepos.includes(repo) ? state.trustedRepos : [...state.trustedRepos, repo]
    })),

    removeTrustedRepo: (repo) => set((state) => ({
        trustedRepos: state.trustedRepos.filter(r => r !== repo)
    })),
    setConfigs: (configs: Partial<Pick<AutoState, 'autoDiscovery' | 'autoApply' | 'autoMatchStrategy' | 'autoCheckInterval' | 'autoScanMode'>>) => set(configs),

    hydrate: (settings: any, extra?: { appliedCount?: number; history?: AutoHistoryItem[] }) => set({
        trustedRepos: settings.autoTrustedRepos || [],
        excludeList: settings.autoExcludeList || [],
        autoApply: settings.autoApply !== undefined ? settings.autoApply : false,
        autoDiscovery: settings.autoDiscovery !== undefined ? settings.autoDiscovery : true,
        autoMatchStrategy: settings.autoMatchStrategy || 'comprehensive',
        autoCheckInterval: settings.autoCheckInterval || 24,
        autoScanMode: settings.autoScanMode || 'incremental',
        history: extra?.history || [],
        summary: { ...get().summary, applied: extra?.appliedCount || 0 }
    }),

    clearAll: () => set({ tasks: [], summary: { upToDate: 0, success: 0, error: 0, applied: get().summary.applied } }),
}));
