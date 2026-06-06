import * as path from 'path';
import { existsSync } from 'fs';
import { requestUrl } from 'obsidian';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type I18N from '../main';
import {
    getCompanionWorkerPort,
    type WorkerBackend,
} from './companion-worker-ports';
import {
    classifyCompanionWorkerIdentity,
    type CompanionWorkerIdentityState,
} from './companion-worker-identity';
import {
    waitForWorkerReadyOrExit,
} from './companion-worker-lifecycle';
import { getCompanionWorkerTaskBackend } from './companion-worker-routing';
import { resolveCompanionTaskBackend } from './companion-task-backend';
import type {
    CompanionAsyncTaskType,
    CompanionApplyTranslationResponse,
    CompanionAstReplaceRequest,
    CompanionAstReplaceResponse,
    CompanionAutoMatchRequest,
    CompanionAutoMatchResponse,
    CompanionBatchTaskType,
    CompanionCloudResponse,
    CompanionCloudTaskType,
    CompanionCodeExtractRequest,
    CompanionCodeExtractResponse,
    CompanionDiscoveredPlugin,
    CompanionDiscoveredTheme,
    CompanionGithubReadRequest,
    CompanionGithubReadResponse,
    CompanionGithubWriteRequest,
    CompanionGithubWriteResponse,
    CompanionPluginApplyTranslationRequest,
    CompanionPluginDiagnoseCleanupResponse,
    CompanionPluginDiagnoseCleanupApplyRequest,
    CompanionPluginDiagnoseCleanupApplyResponse,
    CompanionPluginDiagnoseCleanupCancelRequest,
    CompanionPluginDiagnoseCleanupCancelResponse,
    CompanionPluginDiagnoseCleanupStartRequest,
    CompanionPluginDiagnoseCleanupStepRequest,
    CompanionProxyRequest,
    CompanionProxyResponse,
    CompanionSourceManagerRequest,
    CompanionSourceManagerResponse,
    CompanionTaskCancelResponse,
    CompanionTaskProgress,
    CompanionTaskStartResponse,
    CompanionTaskStatusResponse,
    CompanionThemeApplyTranslationRequest,
} from './companion-worker-types';

export type {
    CompanionAsyncTaskType,
    CompanionApplyTranslationResponse,
    CompanionAstReplaceRequest,
    CompanionAstReplaceResponse,
    CompanionAutoMatchRequest,
    CompanionAutoMatchResponse,
    CompanionBatchFailure,
    CompanionCloudResponse,
    CompanionCloudTaskType,
    CompanionCodeExtractRequest,
    CompanionCodeExtractResponse,
    CompanionBatchResource,
    CompanionBatchTaskType,
    CompanionDiscoveredPlugin,
    CompanionDiscoveredTheme,
    CompanionExtractionSettings,
    CompanionGithubReadRequest,
    CompanionGithubReadResponse,
    CompanionGithubWriteRequest,
    CompanionExtractResult,
    CompanionPluginApplyTranslationRequest,
    CompanionPluginDiagnoseCleanupResponse,
    CompanionPluginDiagnoseCleanupApplyRequest,
    CompanionPluginDiagnoseCleanupApplyResponse,
    CompanionPluginDiagnoseCleanupCancelRequest,
    CompanionPluginDiagnoseCleanupCancelResponse,
    CompanionPluginDiagnoseCleanupStartRequest,
    CompanionPluginDiagnoseCleanupStepRequest,
    CompanionPluginBatchExtractPayload,
    CompanionPluginBatchTranslatePayload,
    CompanionPluginExtractPayload,
    CompanionPluginExtractRequest,
    CompanionPluginExtractResult,
    CompanionPluginRetryPayload,
    CompanionPluginRetryResult,
    CompanionPluginRetryUpdate,
    CompanionPluginTranslatePayload,
    CompanionPluginTranslateRequest,
    CompanionPluginTranslateResult,
    CompanionPluginFailureRetryPayload,
    CompanionProxyRequest,
    CompanionProxyResponse,
    CompanionSourceManagerRequest,
    CompanionSourceManagerResponse,
    CompanionTaskCancelResponse,
    CompanionTaskProgress,
    CompanionTaskStartResponse,
    CompanionTaskStatus,
    CompanionTaskStatusResponse,
    CompanionThemeApplyTranslationRequest,
    CompanionThemeBatchExtractPayload,
    CompanionThemeBatchTranslatePayload,
    CompanionThemeExtractPayload,
    CompanionThemeExtractRequest,
    CompanionThemeExtractResult,
    CompanionThemeRetryPayload,
    CompanionThemeRetryResult,
    CompanionThemeRetryUpdate,
    CompanionThemeTranslatePayload,
    CompanionThemeTranslateRequest,
    CompanionThemeTranslateResult,
    CompanionThemeFailureRetryPayload,
    CompanionTranslationConfig,
    CompanionTranslateResult,
} from './companion-worker-types';

interface WorkerRuntime {
    process: ChildProcess | null;
    endpoint: string;
    startPromise: Promise<boolean> | null;
}

export class CompanionWorkerManager {
    private readonly runtimes: Record<WorkerBackend, WorkerRuntime> = {
        rust: { process: null, endpoint: '', startPromise: null },
        cjs: { process: null, endpoint: '', startPromise: null },
    };
    private readonly rustWorkerPath: string;
    private readonly cjsWorkerPath: string;
    private readonly normalizedPluginDir: string;
    private readonly taskBackends = new Map<string, WorkerBackend>();

    constructor(private readonly plugin: I18N, private readonly pluginDir: string) {
        this.rustWorkerPath = path.join(pluginDir, process.platform === 'win32' ? 'i18n-companion-worker.exe' : 'i18n-companion-worker');
        this.cjsWorkerPath = path.join(pluginDir, 'i18n-companion-worker.cjs');
        this.normalizedPluginDir = path.resolve(pluginDir);
    }

    public async start(): Promise<boolean> {
        return this.startBackend('rust');
    }

    public stop(): void {
        void this.stopAsync();
    }

    public async stopAsync(): Promise<void> {
        await Promise.all([
            this.stopBackend('rust'),
            this.stopBackend('cjs'),
        ]);
        this.taskBackends.clear();
    }

    public async proxyRequest(request: CompanionProxyRequest): Promise<CompanionProxyResponse> {
        const response = await this.postRaw('rust', '/proxy', request);
        if (!response?.ok || !response.response) {
            throw new Error(response?.error || 'Local companion worker returned an invalid proxy response');
        }
        return response.response;
    }

    public async githubRead(request: CompanionGithubReadRequest): Promise<CompanionGithubReadResponse> {
        const response = await this.postWorker<{ result: CompanionGithubReadResponse }>('rust', '/github/read', request);
        return response.result;
    }

    public async githubWrite(request: CompanionGithubWriteRequest): Promise<CompanionGithubWriteResponse> {
        const response = await this.postWorker<{ result: CompanionGithubWriteResponse }>('rust', '/github/write', request);
        return response.result;
    }

    public async autoMatch(request: CompanionAutoMatchRequest): Promise<CompanionAutoMatchResponse> {
        const response = await this.postWorker<{ result: CompanionAutoMatchResponse }>('rust', '/automation/match', request);
        return response.result;
    }

    public async astReplace(request: CompanionAstReplaceRequest): Promise<CompanionAstReplaceResponse> {
        return this.runTask<CompanionAstReplaceResponse>('ast-replace', request);
    }

    public async codeExtract(request: CompanionCodeExtractRequest): Promise<CompanionCodeExtractResponse> {
        return this.runTask<CompanionCodeExtractResponse>('code-extract', request);
    }

    public async getCjsEndpoint(): Promise<string> {
        return this.getEndpoint('cjs');
    }

    public async applyPluginTranslation(request: CompanionPluginApplyTranslationRequest): Promise<CompanionApplyTranslationResponse> {
        return this.runTask<CompanionApplyTranslationResponse>('plugin-apply-translation', request);
    }

    public async startPluginDiagnoseCleanup(request: CompanionPluginDiagnoseCleanupStartRequest): Promise<CompanionPluginDiagnoseCleanupResponse> {
        return this.runTask<CompanionPluginDiagnoseCleanupResponse>('plugin-diagnose-cleanup-start', request);
    }

    public async stepPluginDiagnoseCleanup(request: CompanionPluginDiagnoseCleanupStepRequest): Promise<CompanionPluginDiagnoseCleanupResponse> {
        return this.runTask<CompanionPluginDiagnoseCleanupResponse>('plugin-diagnose-cleanup-step', request);
    }

    public async cancelPluginDiagnoseCleanup(request: CompanionPluginDiagnoseCleanupCancelRequest): Promise<CompanionPluginDiagnoseCleanupCancelResponse> {
        return this.runTask<CompanionPluginDiagnoseCleanupCancelResponse>('plugin-diagnose-cleanup-cancel', request);
    }

    public async applyPluginDiagnoseCleanup(request: CompanionPluginDiagnoseCleanupApplyRequest): Promise<CompanionPluginDiagnoseCleanupApplyResponse> {
        return this.runTask<CompanionPluginDiagnoseCleanupApplyResponse>('plugin-diagnose-cleanup-apply', request);
    }

    public async applyThemeTranslation(request: CompanionThemeApplyTranslationRequest): Promise<CompanionApplyTranslationResponse> {
        return this.runTask<CompanionApplyTranslationResponse>('theme-apply-translation', request);
    }

    public async readSource(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-read', request);
    }

    public async exportSources(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-export', request);
    }

    public async importSources(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-import', request);
    }

    public async removeSources(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-remove', request);
    }

    public async setActiveSource(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-set-active', request);
    }

    public async indexSources(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-index', request);
    }

    public async clearBatchRecords(request: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
        return this.runTask<CompanionSourceManagerResponse>('source-clear-batch-records', request);
    }

    public async runCloudTask(type: CompanionCloudTaskType, payload: unknown): Promise<CompanionCloudResponse> {
        return this.runTask<CompanionCloudResponse>(type, payload);
    }

    public async runTask<TResult>(type: CompanionBatchTaskType, payload: unknown, signal?: AbortSignal): Promise<TResult> {
        const backend = this.getTaskBackend(type);
        const endpoint = await this.getEndpoint(backend);

        return new Promise<TResult>((resolve, reject) => {
            const abortHandler = () => {
                const abortError = new Error('AbortError');
                abortError.name = 'AbortError';
                reject(abortError);
            };
            if (signal?.aborted) return abortHandler();
            signal?.addEventListener('abort', abortHandler, { once: true });

            requestUrl({
                url: `${endpoint}/task`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, payload }),
                throw: false,
            }).then(response => {
                signal?.removeEventListener('abort', abortHandler);
                const responsePayload = response.json || (response.text ? JSON.parse(response.text) : null);
                if (!responsePayload?.ok) {
                    reject(new Error(responsePayload?.error || `Local companion worker returned ${response.status}`));
                    return;
                }
                resolve(responsePayload.result as TResult);
            }).catch(error => {
                signal?.removeEventListener('abort', abortHandler);
                reject(error);
            });
        });
    }

    public async startTask(type: CompanionAsyncTaskType, payload: unknown): Promise<CompanionTaskStartResponse> {
        const backend = this.getTaskBackend(type);
        const response = await this.postWorker<{ taskId: string; progress: CompanionTaskProgress }>(backend, '/task/start', { type, payload });
        if (response.taskId) this.taskBackends.set(response.taskId, backend);
        return response;
    }

    public async getTaskStatus(taskId: string, taskType?: CompanionAsyncTaskType): Promise<CompanionTaskStatusResponse> {
        const fallbackBackend = taskType ? this.getTaskBackend(taskType) : 'rust';
        const backend = resolveCompanionTaskBackend(this.taskBackends, taskId, fallbackBackend);
        const endpoint = await this.getEndpoint(backend);
        const query = encodeURIComponent(taskId);

        const response = await requestUrl({
            url: `${endpoint}/task/status?id=${query}`,
            method: 'GET',
            throw: false,
        });

        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok || !payload.progress) {
            throw new Error(payload?.error || `Local companion worker returned ${response.status}`);
        }

        if (payload.progress.status === 'completed' || payload.progress.status === 'cancelled' || payload.progress.status === 'failed') {
            this.taskBackends.delete(taskId);
        }
        return { progress: payload.progress as CompanionTaskProgress };
    }

    public async cancelTask(taskId: string, taskType?: CompanionAsyncTaskType): Promise<CompanionTaskCancelResponse> {
        const fallbackBackend = taskType ? this.getTaskBackend(taskType) : 'rust';
        const backend = resolveCompanionTaskBackend(this.taskBackends, taskId, fallbackBackend);
        return this.postWorker<CompanionTaskCancelResponse>(backend, '/task/cancel', { taskId });
    }

    public async discoverPlugins(): Promise<CompanionDiscoveredPlugin[]> {
        const response = await this.getWorker<{ plugins: CompanionDiscoveredPlugin[] }>('rust', '/resources/plugins');
        return response.plugins || [];
    }

    public async discoverThemes(): Promise<CompanionDiscoveredTheme[]> {
        const response = await this.getWorker<{ themes: CompanionDiscoveredTheme[] }>('rust', '/resources/themes');
        return response.themes || [];
    }

    private getTaskBackend(type: CompanionBatchTaskType | CompanionAsyncTaskType): WorkerBackend {
        return getCompanionWorkerTaskBackend(type);
    }

    private async getEndpoint(backend: WorkerBackend): Promise<string> {
        const started = await this.startBackend(backend);
        const endpoint = this.runtimes[backend].endpoint;
        if (!started || !endpoint) throw new Error(`Local ${backend} companion worker is not running`);
        return endpoint;
    }

    private async getWorker<TResult>(backend: WorkerBackend, route: string): Promise<TResult> {
        const endpoint = await this.getEndpoint(backend);
        const response = await requestUrl({ url: `${endpoint}${route}`, method: 'GET', throw: false });
        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok) throw new Error(payload?.error || `Local companion worker returned ${response.status}`);
        return payload as TResult;
    }

    private async postWorker<TResult>(backend: WorkerBackend, route: string, body: unknown): Promise<TResult> {
        const payload = await this.postRaw(backend, route, body);
        if (!payload?.ok) throw new Error(payload?.error || 'Local companion worker returned an invalid response');
        return payload as TResult;
    }

    private async postRaw(backend: WorkerBackend, route: string, body: unknown): Promise<any> {
        const endpoint = await this.getEndpoint(backend);
        const response = await requestUrl({
            url: `${endpoint}${route}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            throw: false,
        });
        return response.json || (response.text ? JSON.parse(response.text) : null);
    }

    private async startBackend(backend: WorkerBackend): Promise<boolean> {
        if (!this.plugin.settings.llmCompanionWorkerEnabled) return false;
        const runtime = this.runtimes[backend];
        if (runtime.endpoint) return true;
        if (runtime.startPromise) return runtime.startPromise;

        runtime.startPromise = this.startBackendInner(backend).finally(() => {
            runtime.startPromise = null;
        });
        return runtime.startPromise;
    }

    private async startBackendInner(backend: WorkerBackend): Promise<boolean> {
        try {
            const port = this.getPort(backend);
            const endpoint = `http://127.0.0.1:${port}`;
            const identity = await this.getWorkerIdentity(backend, endpoint, 150);
            if (identity === 'same') {
                this.runtimes[backend].endpoint = endpoint;
                return true;
            }
            if (identity === 'other') {
                throw new Error(`Local ${backend} companion worker port ${port} is used by another i18n plugin instance`);
            }
            if (identity === 'stale') {
                await this.stopWorkerEndpoint(endpoint).catch(() => undefined);
                if (await this.getWorkerIdentity(backend, endpoint, 150) !== 'missing') {
                    return false;
                }
            }

            if (backend === 'rust') {
                if (!existsSync(this.rustWorkerPath)) {
                    throw new Error(`Rust companion worker not found: ${this.rustWorkerPath}`);
                }
                return this.spawnWorker(backend, this.rustWorkerPath, [String(port)], port);
            }

            if (!existsSync(this.cjsWorkerPath)) {
                throw new Error(`CJS companion worker not found: ${this.cjsWorkerPath}`);
            }
            const nodePath = this.plugin.settings.llmCompanionNodePath?.trim() || 'node';
            return this.spawnWorker(backend, nodePath, [this.cjsWorkerPath, String(port)], port);
        } catch (error) {
            console.warn(`[I18N Companion] Failed to start ${backend} worker`, error);
            await this.stopBackend(backend);
            return false;
        }
    }

    private async spawnWorker(backend: WorkerBackend, command: string, args: string[], port: number): Promise<boolean> {
        const runtime = this.runtimes[backend];
        const worker = spawn(command, args, {
            cwd: this.pluginDir,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: process.env,
        });

        runtime.process = worker;
        runtime.endpoint = `http://127.0.0.1:${port}`;

        worker.stdout?.on('data', data => console.debug(`[I18N Companion:${backend}] ${String(data).trim()}`));
        worker.stderr?.on('data', data => console.warn(`[I18N Companion:${backend}] ${String(data).trim()}`));
        worker.once('exit', () => {
            if (runtime.process === worker) {
                runtime.process = null;
                runtime.endpoint = '';
            }
        });
        worker.once('error', error => {
            console.warn(`[I18N Companion] Failed to start ${backend} worker`, error);
            if (runtime.process === worker) {
                runtime.process = null;
                runtime.endpoint = '';
            }
        });

        const ready = await waitForWorkerReadyOrExit({
            timeoutMs: 5000,
            pollIntervalMs: 150,
            isReady: () => this.isWorkerReady(backend, runtime.endpoint, 500),
            waitForExit: () => new Promise(resolve => {
                if (worker.exitCode !== null || worker.signalCode !== null) {
                    resolve(undefined);
                    return;
                }
                worker.once('exit', resolve);
                worker.once('error', resolve);
            }),
        });
        if (ready !== 'ready') {
            runtime.endpoint = '';
            runtime.process = null;
            if (!worker.killed) worker.kill();
            return false;
        }

        return true;
    }

    private async stopBackend(backend: WorkerBackend): Promise<void> {
        const runtime = this.runtimes[backend];
        const endpoint = runtime.endpoint;
        const worker = runtime.process;

        runtime.endpoint = '';
        runtime.process = null;

        if (!endpoint && !worker) return;

        try {
            if (endpoint && await this.getWorkerIdentity(backend, endpoint, 500) === 'same') {
                await this.stopWorkerEndpoint(endpoint);
            }
        } catch {
            if (worker && !worker.killed) worker.kill();
            return;
        }

        if (worker && !worker.killed) {
            setTimeout(() => {
                if (!worker.killed) worker.kill();
            }, 1000);
        }
    }

    private getPort(backend: WorkerBackend): number {
        return getCompanionWorkerPort(this.plugin.settings.llmCompanionWorkerPort, backend);
    }

    private async isWorkerReady(backend: WorkerBackend, endpoint: string, timeoutMs: number): Promise<boolean> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const identity = await this.getWorkerIdentity(backend, endpoint, 500);
            if (identity === 'same') return true;
            if (identity === 'other' || identity === 'stale') return false;
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        return false;
    }

    private async getWorkerIdentity(backend: WorkerBackend, endpoint: string, timeoutMs: number): Promise<CompanionWorkerIdentityState> {
        try {
            const response = await Promise.race([
                requestUrl({ url: `${endpoint}/identity`, method: 'GET', throw: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('identity timeout')), timeoutMs)),
            ]) as any;
            const payload = response.json || (response.text ? JSON.parse(response.text) : null);
            if (response.status === 200 && payload?.ok) {
                return classifyCompanionWorkerIdentity(payload, this.normalizedPluginDir, backend);
            }
        } catch {
            // Endpoint is either not a companion worker yet, or not reachable.
        }
        return 'missing';
    }

    private async stopWorkerEndpoint(endpoint: string): Promise<void> {
        await Promise.race([
            requestUrl({ url: `${endpoint}/shutdown`, method: 'POST', throw: false }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 500)),
        ]);
    }

}
