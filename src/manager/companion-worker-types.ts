import type { BatchTaskFailureRecord, BatchTaskMode, BatchTaskScope, PluginTranslationV1, ThemeTranslationV1 } from '../types';

export interface CompanionProxyRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
    timeoutMs?: number;
}

export interface CompanionProxyResponse {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
}

export interface CompanionExtractionSettings {
    author: string;
    reFlags: string;
    reLength: number;
    reDatas: string[];
    reRejectRe: string[];
    reValidRe: string[];
    astAssignments: string[];
    astFunctions: string[];
    astKeys: string[];
    astRejectRe: string[];
    astValidRe: string[];
}

export interface CompanionPluginExtractRequest {
    resourceId: string;
    label: string;
    pluginName: string;
    pluginVersion: string;
    mainDoc: string;
    manifestDoc: string;
    language: string;
}

export interface CompanionThemeExtractRequest {
    resourceId: string;
    label: string;
    themeName: string;
    themeDir: string;
    themeCssPath: string;
}

export interface CompanionPluginExtractPayload extends CompanionPluginExtractRequest {
    settings: CompanionExtractionSettings;
}

export interface CompanionThemeExtractPayload extends CompanionThemeExtractRequest {
    settings: CompanionExtractionSettings;
}

export type CompanionExtractResult<TContent> =
    | {
        status: 'success';
        resourceId: string;
        label: string;
        pluginId: string;
        content: TContent;
        options: { title: string; type?: 'theme' };
    }
    | {
        status: 'skipped';
        resourceId: string;
        label: string;
        reason: 'chinese' | 'empty';
    }
    | {
        status: 'failed';
        resourceId: string;
        label: string;
        error: string;
    };

export type CompanionPluginExtractResult = CompanionExtractResult<PluginTranslationV1>;
export type CompanionThemeExtractResult = CompanionExtractResult<ThemeTranslationV1>;

export interface CompanionTranslationConfig {
    chatCompletionsUrl: string;
    apiKey: string;
    model: string;
    timeoutMs: number;
    responseFormat: string;
    batchSize: number;
    concurrency: number;
    prompts: {
        ast: string;
        regex: string;
        theme: string;
    };
}

export type CompanionBatchFailure = Omit<BatchTaskFailureRecord, 'id' | 'failedAt' | 'scope'>;

export interface CompanionPluginTranslateRequest {
    resourceId: string;
    resourceLabel: string;
    sourceId: string;
    translationJson: PluginTranslationV1;
}

export interface CompanionThemeTranslateRequest {
    resourceId: string;
    resourceLabel: string;
    sourceId: string;
    translationJson: ThemeTranslationV1;
}

export interface CompanionPluginTranslatePayload extends CompanionPluginTranslateRequest {
    config: CompanionTranslationConfig;
}

export interface CompanionThemeTranslatePayload extends CompanionThemeTranslateRequest {
    config: CompanionTranslationConfig;
}

export interface CompanionTranslateResult<TContent> {
    translationJson: TContent;
    processedItems: number;
    failures: CompanionBatchFailure[];
}

export type CompanionPluginTranslateResult = CompanionTranslateResult<PluginTranslationV1>;
export type CompanionThemeTranslateResult = CompanionTranslateResult<ThemeTranslationV1>;

export interface CompanionPluginRetryPayload {
    resourceId: string;
    resourceLabel: string;
    sourceId: string;
    failures: BatchTaskFailureRecord[];
    config: CompanionTranslationConfig;
}

export interface CompanionThemeRetryPayload {
    resourceId: string;
    resourceLabel: string;
    sourceId: string;
    failures: BatchTaskFailureRecord[];
    config: CompanionTranslationConfig;
}

export interface CompanionPluginRetryUpdate {
    batchType: 'ast' | 'regex';
    failureId: string;
    file: string;
    dictIndex: number;
    target: string;
}

export interface CompanionThemeRetryUpdate {
    failureId: string;
    dictIndex: number;
    target: string;
}

export interface CompanionRetryResult<TUpdate> {
    updates: TUpdate[];
    processedItems: number;
    completedFailureIds: string[];
    failedFailureIds: string[];
    skippedFailureIds: string[];
}

export type CompanionPluginRetryResult = CompanionRetryResult<CompanionPluginRetryUpdate>;
export type CompanionThemeRetryResult = CompanionRetryResult<CompanionThemeRetryUpdate>;

export interface CompanionBatchResource {
    resourceId: string;
    label: string;
    sourceId?: string | null;
}

export interface CompanionWorkerPersistenceConfig {
    basePath: string;
}

export type CompanionTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface CompanionTaskProgress {
    taskId: string;
    scope: BatchTaskScope;
    mode: BatchTaskMode;
    status: CompanionTaskStatus;
    currentLabel: string;
    processedResources: number;
    totalResources: number;
    processedItems: number;
    totalItems: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    sourceRevision: number;
    recordRevision: number;
    updatedAt: number;
    error?: string;
}

export interface CompanionTaskStartResponse {
    taskId: string;
    progress: CompanionTaskProgress;
}

export interface CompanionTaskStatusResponse {
    progress: CompanionTaskProgress;
}

export interface CompanionTaskCancelResponse {
    progress: CompanionTaskProgress;
}

export interface CompanionPluginBatchExtractPayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionPluginExtractPayload[];
    concurrency: number;
    checkpointKey: string;
    completedResources?: number;
}

export interface CompanionThemeBatchExtractPayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionThemeExtractPayload[];
    concurrency: number;
    checkpointKey: string;
    completedResources?: number;
}

export interface CompanionPluginBatchTranslatePayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionBatchResource[];
    config: CompanionTranslationConfig;
    checkpointKey: string;
    concurrency: number;
    completedResources?: number;
    processedItems?: number;
    totalItems?: number;
}

export interface CompanionThemeBatchTranslatePayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionBatchResource[];
    config: CompanionTranslationConfig;
    checkpointKey: string;
    concurrency: number;
    completedResources?: number;
    processedItems?: number;
    totalItems?: number;
}

export interface CompanionPluginFailureRetryPayload {
    persistence: CompanionWorkerPersistenceConfig;
    failures: BatchTaskFailureRecord[];
    config: CompanionTranslationConfig;
    concurrency: number;
}

export interface CompanionThemeFailureRetryPayload {
    persistence: CompanionWorkerPersistenceConfig;
    failures: BatchTaskFailureRecord[];
    config: CompanionTranslationConfig;
    concurrency: number;
}

export type CompanionAsyncTaskType = 'plugin-batch-extract' | 'theme-batch-extract' | 'plugin-batch-translate' | 'theme-batch-translate' | 'plugin-failure-retry' | 'theme-failure-retry';

export type CompanionBatchTaskType = 'plugin-extract' | 'theme-extract' | 'plugin-translate' | 'theme-translate' | 'plugin-retry' | 'theme-retry';
