import * as path from 'path';
import { existsSync } from 'fs';
import { requestUrl } from 'obsidian';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type I18N from '../main';
import type {
    CompanionAsyncTaskType,
    CompanionAutoMatchRequest,
    CompanionAutoMatchResponse,
    CompanionBatchTaskType,
    CompanionCloudResponse,
    CompanionCloudTaskType,
    CompanionDiscoveredPlugin,
    CompanionDiscoveredTheme,
    CompanionGithubReadRequest,
    CompanionGithubReadResponse,
    CompanionGithubWriteRequest,
    CompanionGithubWriteResponse,
    CompanionProxyRequest,
    CompanionProxyResponse,
    CompanionTaskCancelResponse,
    CompanionTaskProgress,
    CompanionTaskStartResponse,
    CompanionTaskStatusResponse,
} from './companion-worker-types';

export type {
    CompanionAsyncTaskType,
    CompanionAutoMatchRequest,
    CompanionAutoMatchResponse,
    CompanionBatchFailure,
    CompanionCloudResponse,
    CompanionCloudTaskType,
    CompanionBatchResource,
    CompanionBatchTaskType,
    CompanionDiscoveredPlugin,
    CompanionDiscoveredTheme,
    CompanionExtractionSettings,
    CompanionGithubReadRequest,
    CompanionGithubReadResponse,
    CompanionGithubWriteRequest,
    CompanionGithubWriteResponse,
    CompanionExtractResult,
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
    CompanionTaskCancelResponse,
    CompanionTaskProgress,
    CompanionTaskStartResponse,
    CompanionTaskStatus,
    CompanionTaskStatusResponse,
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

export class CompanionWorkerManager {
    private workerProcess: ChildProcess | null = null;
    private endpoint = '';
    private startPromise: Promise<boolean> | null = null;
    private readonly rustWorkerPath: string;
    private readonly normalizedPluginDir: string;

    constructor(private readonly plugin: I18N, private readonly pluginDir: string) {
        this.rustWorkerPath = path.join(pluginDir, process.platform === 'win32' ? 'i18n-companion-worker.exe' : 'i18n-companion-worker');
        this.normalizedPluginDir = path.resolve(pluginDir);
    }

    public async start(): Promise<boolean> {
        if (!this.plugin.settings.llmCompanionWorkerEnabled) return false;
        if (this.endpoint) return true;
        if (this.startPromise) return this.startPromise;

        this.startPromise = this.startInner().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    public stop(): void {
        void this.stopAsync();
    }

    public async stopAsync(): Promise<void> {
        const endpoint = this.endpoint || `http://127.0.0.1:${this.getPort()}`;
        const worker = this.workerProcess;

        this.endpoint = '';
        this.workerProcess = null;

        try {
            await Promise.race([
                requestUrl({ url: `${endpoint}/shutdown`, method: 'POST', throw: false }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('shutdown timeout')), 500)),
            ]);
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

    public async proxyRequest(request: CompanionProxyRequest): Promise<CompanionProxyResponse> {
        const started = await this.start();
        if (!started || !this.endpoint) throw new Error('本地伴生服务未启动');

        const response = await requestUrl({
            url: `${this.endpoint}/proxy`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request),
            throw: false,
        });

        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok || !payload.response) {
            throw new Error(payload?.error || `本地伴生服务返回异常 (${response.status})`);
        }

        return payload.response;
    }

    public async githubRead(request: CompanionGithubReadRequest): Promise<CompanionGithubReadResponse> {
        const response = await this.postWorker<{ result: CompanionGithubReadResponse }>('/github/read', request);
        return response.result;
    }

    public async githubWrite(request: CompanionGithubWriteRequest): Promise<CompanionGithubWriteResponse> {
        const response = await this.postWorker<{ result: CompanionGithubWriteResponse }>('/github/write', request);
        return response.result;
    }

    public async autoMatch(request: CompanionAutoMatchRequest): Promise<CompanionAutoMatchResponse> {
        const response = await this.postWorker<{ result: CompanionAutoMatchResponse }>('/automation/match', request);
        return response.result;
    }

    public async runCloudTask(type: CompanionCloudTaskType, payload: unknown): Promise<CompanionCloudResponse> {
        return this.runTask<CompanionCloudResponse>(type, payload);
    }

    public async runTask<TResult>(type: CompanionBatchTaskType, payload: unknown, signal?: AbortSignal): Promise<TResult> {
        const started = await this.start();
        if (!started || !this.endpoint) throw new Error('本地伴生服务未启动');

        return new Promise<TResult>((resolve, reject) => {
            const abortHandler = () => {
                this.stop();
                const abortError = new Error('AbortError');
                abortError.name = 'AbortError';
                reject(abortError);
            };
            if (signal?.aborted) return abortHandler();
            signal?.addEventListener('abort', abortHandler, { once: true });

            requestUrl({
                url: `${this.endpoint}/task`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, payload }),
                throw: false,
            }).then(response => {
                signal?.removeEventListener('abort', abortHandler);
                const responsePayload = response.json || (response.text ? JSON.parse(response.text) : null);
                if (!responsePayload?.ok) {
                    reject(new Error(responsePayload?.error || `本地伴生服务返回异常 (${response.status})`));
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
        const response = await this.postWorker<{ taskId: string; progress: CompanionTaskProgress }>('/task/start', { type, payload });
        return response;
    }

    public async getTaskStatus(taskId: string): Promise<CompanionTaskStatusResponse> {
        const query = encodeURIComponent(taskId);
        const started = await this.start();
        if (!started || !this.endpoint) throw new Error('本地伴生服务未启动');

        const response = await requestUrl({
            url: `${this.endpoint}/task/status?id=${query}`,
            method: 'GET',
            throw: false,
        });

        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok || !payload.progress) {
            throw new Error(payload?.error || `本地伴生服务返回异常 (${response.status})`);
        }

        return { progress: payload.progress as CompanionTaskProgress };
    }

    public async cancelTask(taskId: string): Promise<CompanionTaskCancelResponse> {
        return this.postWorker<CompanionTaskCancelResponse>('/task/cancel', { taskId });
    }

    public async discoverPlugins(): Promise<CompanionDiscoveredPlugin[]> {
        const response = await this.getWorker<{ plugins: CompanionDiscoveredPlugin[] }>('/resources/plugins');
        return response.plugins || [];
    }

    public async discoverThemes(): Promise<CompanionDiscoveredTheme[]> {
        const response = await this.getWorker<{ themes: CompanionDiscoveredTheme[] }>('/resources/themes');
        return response.themes || [];
    }

    private async getWorker<TResult>(route: string): Promise<TResult> {
        const started = await this.start();
        if (!started || !this.endpoint) throw new Error('本地伴生服务未启动');

        const response = await requestUrl({
            url: `${this.endpoint}${route}`,
            method: 'GET',
            throw: false,
        });

        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok) {
            throw new Error(payload?.error || `本地伴生服务返回异常 (${response.status})`);
        }

        return payload as TResult;
    }

    private async postWorker<TResult>(route: string, body: unknown): Promise<TResult> {
        const started = await this.start();
        if (!started || !this.endpoint) throw new Error('本地伴生服务未启动');

        const response = await requestUrl({
            url: `${this.endpoint}${route}`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            throw: false,
        });

        const payload = response.json || (response.text ? JSON.parse(response.text) : null);
        if (!payload?.ok) {
            throw new Error(payload?.error || `本地伴生服务返回异常 (${response.status})`);
        }

        return payload as TResult;
    }

    private async startInner(): Promise<boolean> {
        try {
            const port = this.getPort();
            const endpoint = `http://127.0.0.1:${port}`;
            if (await this.isWorkerReady(endpoint, 500)) {
                this.endpoint = endpoint;
                return true;
            }
            if (!existsSync(this.rustWorkerPath)) {
                throw new Error(`Rust 伴生 worker 不存在: ${this.rustWorkerPath}`);
            }
            return this.spawnWorker(this.rustWorkerPath, [String(port)], port);
        } catch (error) {
            console.warn('[I18N Companion] 启动失败', error);
            this.stop();
            return false;
        }
    }

    private async spawnWorker(command: string, args: string[], port: number, extraEnv?: Record<string, string>, quiet = false): Promise<boolean> {
        try {
            const worker = spawn(command, args, {
                cwd: this.pluginDir,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
            });

            this.workerProcess = worker;
            this.endpoint = `http://127.0.0.1:${port}`;

            worker.stdout?.on('data', data => console.debug(`[I18N Companion] ${String(data).trim()}`));
            worker.stderr?.on('data', data => console.warn(`[I18N Companion] ${String(data).trim()}`));
            worker.once('exit', () => {
                if (this.workerProcess === worker) {
                    this.workerProcess = null;
                    this.endpoint = '';
                }
            });
            worker.once('error', error => {
                if (!quiet) console.warn('[I18N Companion] 启动失败', error);
                if (this.workerProcess === worker) {
                    this.workerProcess = null;
                    this.endpoint = '';
                }
            });

            const ready = await this.isWorkerReady(this.endpoint, 5000);
            if (!ready) {
                this.stop();
                return false;
            }

            return true;
        } catch (error) {
            if (!quiet) console.warn('[I18N Companion] 启动失败', error);
            this.stop();
            return false;
        }
    }

    private getPort(): number {
        const port = Number(this.plugin.settings.llmCompanionWorkerPort || 18743);
        return Number.isFinite(port) && port > 0 && port <= 65535 ? Math.floor(port) : 18743;
    }

    private async isWorkerReady(endpoint: string, timeoutMs: number): Promise<boolean> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            try {
                const response = await Promise.race([
                    requestUrl({ url: `${endpoint}/identity`, method: 'GET', throw: false }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('identity timeout')), 500)),
                ]) as any;
                const payload = response.json || (response.text ? JSON.parse(response.text) : null);
                if (response.status === 200 && payload?.ok && this.isSamePluginDir(payload.pluginDir)) return true;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }
        return false;
    }

    private isSamePluginDir(pluginDir: unknown): boolean {
        return typeof pluginDir === 'string' && path.resolve(pluginDir) === this.normalizedPluginDir;
    }
}

