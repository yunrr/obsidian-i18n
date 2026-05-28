import * as path from 'path';
import { requestUrl } from 'obsidian';
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import type I18N from '../main';
import type {
    CompanionAsyncTaskType,
    CompanionBatchTaskType,
    CompanionProxyRequest,
    CompanionProxyResponse,
    CompanionTaskCancelResponse,
    CompanionTaskProgress,
    CompanionTaskStartResponse,
    CompanionTaskStatusResponse,
} from './companion-worker-types';

export type {
    CompanionAsyncTaskType,
    CompanionBatchFailure,
    CompanionBatchResource,
    CompanionBatchTaskType,
    CompanionExtractionSettings,
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
    private readonly scriptPath: string;

    constructor(private readonly plugin: I18N, private readonly pluginDir: string) {
        this.scriptPath = path.join(pluginDir, 'i18n-companion-worker.cjs');
    }

    public async start(): Promise<boolean> {
        if (!this.plugin.settings.llmCompanionWorkerEnabled) return false;
        if (this.endpoint && this.workerProcess && !this.workerProcess.killed) return true;
        if (this.startPromise) return this.startPromise;

        this.startPromise = this.startInner().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    public stop(): void {
        this.endpoint = '';
        if (!this.workerProcess) return;

        const worker = this.workerProcess;
        this.workerProcess = null;
        if (!worker.killed) worker.kill();
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
            const nodePath = this.plugin.settings.llmCompanionNodePath?.trim() || 'node';
            const worker = spawn(nodePath, [this.scriptPath, String(port)], {
                cwd: this.pluginDir,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
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
                console.warn('[I18N Companion] 启动失败', error);
                if (this.workerProcess === worker) {
                    this.workerProcess = null;
                    this.endpoint = '';
                }
            });

            const ready = await this.waitForHealth(this.endpoint, 5000);
            if (!ready) {
                this.stop();
                return false;
            }

            return true;
        } catch (error) {
            console.warn('[I18N Companion] 启动失败', error);
            this.stop();
            return false;
        }
    }

    private getPort(): number {
        const port = Number(this.plugin.settings.llmCompanionWorkerPort || 18743);
        return Number.isFinite(port) && port > 0 && port <= 65535 ? Math.floor(port) : 18743;
    }

    private async waitForHealth(endpoint: string, timeoutMs: number): Promise<boolean> {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            try {
                const response = await Promise.race([
                    requestUrl({ url: `${endpoint}/health`, method: 'GET', throw: false }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('health timeout')), 500)),
                ]) as any;
                if (response.status === 200) return true;
            } catch {
                await new Promise(resolve => setTimeout(resolve, 150));
            }
        }
        return false;
    }
}

