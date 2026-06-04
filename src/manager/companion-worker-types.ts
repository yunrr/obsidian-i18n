import type { PluginManifest } from 'obsidian';
import type { BatchTaskFailureRecord, BatchTaskMode, BatchTaskScope, OBThemeManifest, PluginTranslationV1, ThemeTranslationV1 } from '../types';

export interface CompanionDiscoveredPlugin {
    manifest: PluginManifest;
    dir: string;
    mainDoc: string;
    manifestDoc: string;
}

export interface CompanionDiscoveredTheme {
    name: string;
    manifest: OBThemeManifest | null;
    dir: string;
    themeCssPath: string;
    themeCssRelativePath?: string;
    isLegacy?: boolean;
}

export interface CompanionResourceDiscoveryResponse {
    plugins?: CompanionDiscoveredPlugin[];
    themes?: CompanionDiscoveredTheme[];
}

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

export interface CompanionGithubReadRequest {
    operation: string;
    token?: string;
    githubProxyUrl?: string;
    owner?: string;
    repo?: string;
    path?: string;
    branch?: string;
    ref?: string;
    username?: string;
    repoName?: string;
    url?: string;
    targetOwner?: string;
    targetRepo?: string;
    repoAddress?: string;
    creator?: string;
    page?: number;
    perPage?: number;
    recursive?: boolean;
    timeoutMs?: number;
}

export interface CompanionGithubReadResponse {
    state: boolean;
    data: any;
    status?: number;
    scopes?: string[];
    isRateLimit?: boolean;
    hasOpenIssue?: boolean;
}

export interface CompanionGithubWriteRequest {
    operation: string;
    token?: string;
    owner?: string;
    repo?: string;
    name?: string;
    path?: string;
    content?: string;
    message?: string;
    branch?: string;
    sha?: string;
    title?: string;
    body?: string;
    label?: string;
    targetOwner?: string;
    targetRepo?: string;
    baseTree?: string;
    treeData?: any[];
    tree?: string;
    parents?: string[];
    ref?: string;
    files?: { path: string; content: string }[];
    timeoutMs?: number;
}

export interface CompanionGithubWriteResponse {
    state: boolean;
    data: any;
    status?: number;
}

export interface CompanionAutoMatchRequest {
    matches: { repoAddress: string; entry: any }[];
    stats: any;
    targetVersion: string;
    targetLanguage: string;
    isTheme: boolean;
    strategy: 'comprehensive' | 'version_first' | 'popularity' | 'latest_update';
}

export interface CompanionAutoMatchResponse {
    match: { repoAddress: string; entry: any } | null;
    scoreInfo: {
        version: number;
        popularity: number;
        freshness: number;
        total: number;
    };
}

export interface CompanionAstReplaceRequest {
    code: string;
    translations: { type?: string; name?: string; source: string; target: string }[];
}

export interface CompanionAstReplaceResponse {
    state: boolean;
    code: string;
    error?: string;
}

export interface CompanionCodeExtractRequest {
    code: string;
    settings: CompanionExtractionSettings;
}

export interface CompanionCodeExtractResponse {
    state: boolean;
    ast: { type?: string; name?: string; source: string; target: string }[];
    regex: { source: string; target: string }[];
    error?: string;
}

export interface CompanionPluginDiagnoseRenderProbeRequest {
    files: CompanionRuntimeProbeFile[];
    candidates: Array<{
        file: string;
        kind: 'ast' | 'regex';
        index: number;
        item: any;
    }>;
}

export interface CompanionPluginDiagnoseRenderProbeResponse {
    state: boolean;
    files: CompanionRuntimeProbeFile[];
    error?: string;
}

export interface CompanionPluginApplyTranslationRequest {
    pluginId: string;
    pluginDir: string;
    backupBasePath: string;
    translationJson?: PluginTranslationV1;
    persistence?: CompanionWorkerPersistenceConfig;
    translationSourceId?: string;
    applyAst?: boolean;
    applyRegex?: boolean;
    cjsEndpoint?: string;
}

export interface CompanionThemeApplyTranslationRequest {
    themeId: string;
    themeDir: string;
    themeCssPath: string;
    themeCssRelativePath?: string;
    backupBasePath: string;
    translationJson?: ThemeTranslationV1;
    persistence?: CompanionWorkerPersistenceConfig;
    translationSourceId?: string;
}

export interface CompanionApplyTranslationResponse {
    state: boolean;
    processedFiles: number;
    translationVersion: string;
    error?: string;
}

export interface CompanionTranslationIssueItem {
    file: string;
    kind: 'ast' | 'regex';
    index: number;
    source: string;
    target: string;
    reason: string;
}

export interface CompanionRuntimeProbeFile {
    file: string;
    code?: string;
}

export interface CompanionRuntimeProbeRequest {
    probeId: string;
    files: CompanionRuntimeProbeFile[];
    label: string;
}

export interface CompanionDiagnoseProgress {
    phase: 'baseline' | 'ast' | 'regex' | 'completed' | string;
    queueGroups: number;
    currentGroupItems: number;
}

export interface CompanionPluginDiagnoseCleanupStartRequest {
    pluginId: string;
    pluginDir: string;
    backupBasePath: string;
    persistence: CompanionWorkerPersistenceConfig;
    translationSourceId: string;
    draft?: {
        dict?: any;
        metadata?: any;
    };
    cjsEndpoint?: string;
    applyAst?: boolean;
    applyRegex?: boolean;
    runtimeProbe?: boolean;
    isApplied?: boolean;
}

export interface CompanionPluginDiagnoseCleanupStepRequest {
    sessionId: string;
    probeId: string;
    success: boolean;
    error?: string;
}

export interface CompanionPluginDiagnoseCleanupCancelRequest {
    sessionId: string;
}

export interface CompanionPluginDiagnoseCleanupCancelResponse {
    state: boolean;
}

export interface CompanionPluginDiagnoseCleanupApplyRequest {
    persistence: CompanionWorkerPersistenceConfig;
    translationSourceId: string;
    pluginId: string;
    issues: CompanionTranslationIssueItem[];
}

export interface CompanionPluginDiagnoseCleanupApplyResponse {
    state: boolean;
    removedCount: number;
    issueRecordPath: string;
    translationVersion: string;
}

export interface CompanionPluginDiagnoseCleanupResponse {
    state: boolean;
    status: 'probe' | 'completed' | 'baselineFailed';
    sessionId?: string;
    probe?: CompanionRuntimeProbeRequest;
    issueItems: CompanionTranslationIssueItem[];
    clearedItems: CompanionTranslationIssueItem[];
    processedFiles: number;
    translationVersion: string;
    progress: CompanionDiagnoseProgress;
}

export interface CompanionSourceManagerRequest {
    persistence: CompanionWorkerPersistenceConfig;
    sourceId?: string;
    sourceIds?: string[];
    checkpointKeys?: string[];
    scope?: 'plugin' | 'theme';
    active?: boolean;
    contentBase64?: string;
    fileName?: string;
}

export interface CompanionSourceManagerResponse {
    state: boolean;
    contentBase64?: string;
    source?: any;
    addedCount: number;
    updatedCount: number;
    skippedCount: number;
    deletedCount: number;
    error?: string;
}

export type CompanionCloudTaskType = 'cloud-publish-source' | 'cloud-download-source' | 'cloud-update-sources' | 'cloud-prepare-backup' | 'cloud-restore-all' | 'cloud-backup-all';

export interface CompanionCloudResponse {
    state: boolean;
    data?: any;
    manifest?: any[];
    source?: any;
    sources?: any[];
    restored?: number;
    skipped?: number;
    total?: number;
    error?: string;
}

export interface CompanionExtractionSettings {
    author: string;
    translationVersion: string;
    reFlags: string;
    reLength: number;
    reDatas: string[];
    reRejectRe: string[];
    reValidRe: string[];
    reExtractionEnabled: boolean;
    chineseSkipMode: 'none' | 'source' | 'extracted';
    astAssignments: string[];
    astFunctions: string[];
    astKeys: string[];
    astMaxLength: number;
    astRejectRe: string[];
    astValidRe: string[];
    astExtractionEnabled: boolean;
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

export type CompanionPluginBatchExtractResource = Omit<CompanionPluginExtractRequest, 'language'>;

export interface CompanionThemeExtractRequest {
    resourceId: string;
    label: string;
    themeName: string;
    themeDir: string;
    themeCssPath: string;
    themeCssRelativePath?: string;
    isLegacy?: boolean;
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
    batchCharLimit: number;
    batchWindowMultiplier: number;
    overwriteExistingTranslations: boolean;
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
    totalItems: number;
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
    resources: CompanionPluginBatchExtractResource[];
    language: string;
    settings: CompanionExtractionSettings;
    translationVersion: string;
    concurrency: number;
    checkpointKey: string;
    completedResources?: number;
    totalResources?: number;
}

export interface CompanionThemeBatchExtractPayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionThemeExtractRequest[];
    settings: CompanionExtractionSettings;
    translationVersion: string;
    concurrency: number;
    checkpointKey: string;
    completedResources?: number;
    totalResources?: number;
}

export interface CompanionPluginBatchTranslatePayload {
    persistence: CompanionWorkerPersistenceConfig;
    resources: CompanionBatchResource[];
    config: CompanionTranslationConfig;
    checkpointKey: string;
    concurrency: number;
    completedResources?: number;
    totalResources?: number;
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
    totalResources?: number;
    processedItems?: number;
    totalItems?: number;
}

export interface CompanionPluginFailureRetryPayload {
    persistence: CompanionWorkerPersistenceConfig;
    config: CompanionTranslationConfig;
    concurrency: number;
    totalResources?: number;
    totalItems?: number;
}

export interface CompanionThemeFailureRetryPayload {
    persistence: CompanionWorkerPersistenceConfig;
    config: CompanionTranslationConfig;
    concurrency: number;
    totalResources?: number;
    totalItems?: number;
}

export type CompanionAsyncTaskType = 'plugin-batch-extract' | 'theme-batch-extract' | 'plugin-batch-translate' | 'theme-batch-translate' | 'plugin-failure-retry' | 'theme-failure-retry' | 'cloud-backup-all';

export type CompanionBatchTaskType = 'plugin-extract' | 'theme-extract' | 'plugin-translate' | 'theme-translate' | 'plugin-retry' | 'theme-retry' | 'ast-replace' | 'code-extract' | 'plugin-render-translation' | 'plugin-diagnose-render-probe' | 'plugin-apply-translation' | 'plugin-diagnose-cleanup-start' | 'plugin-diagnose-cleanup-step' | 'plugin-diagnose-cleanup-cancel' | 'plugin-diagnose-cleanup-apply' | 'theme-apply-translation' | 'source-read' | 'source-export' | 'source-import' | 'source-remove' | 'source-set-active' | 'source-index' | 'source-clear-batch-records' | CompanionCloudTaskType;
