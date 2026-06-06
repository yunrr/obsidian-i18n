import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import { nanoid } from 'nanoid';
import { calculateChecksum } from '../utils/translator/translation';
import { parseTranslationResponse } from '../utils/ai/response-parser';
import type { AstItem, RegexItem } from '../views/plugin_editor/types';
import type { ThemeTranslationItem } from '../views/theme_editor/types';
import type { BatchTaskCheckpoint, BatchTaskFailureRecord, BatchTaskRecordMeta, BatchTaskScope, TranslationSource, TranslationSourceMeta, PluginTranslationV1, ThemeTranslationV1 } from '../types';
import type {
    CompanionProxyRequest,
    CompanionProxyResponse,
    CompanionSourceManagerRequest,
    CompanionSourceManagerResponse,
    CompanionAstReplaceRequest,
    CompanionAstReplaceResponse,
    CompanionCodeExtractRequest,
    CompanionCodeExtractResponse,
    CompanionPluginDiagnoseRenderProbeRequest,
    CompanionPluginDiagnoseRenderProbeResponse,
    CompanionPluginApplyTranslationRequest,
    CompanionPluginExtractPayload,
    CompanionPluginExtractResult,
    CompanionThemeExtractPayload,
    CompanionThemeExtractResult,
    CompanionThemeApplyTranslationRequest,
    CompanionTranslationConfig,
    CompanionBatchFailure,
    CompanionAsyncTaskType,
    CompanionBatchTaskType,
    CompanionBatchResource,
    CompanionPluginBatchExtractPayload,
    CompanionPluginBatchTranslatePayload,
    CompanionPluginFailureRetryPayload,
    CompanionTaskProgress,
    CompanionThemeBatchExtractPayload,
    CompanionThemeBatchTranslatePayload,
    CompanionThemeFailureRetryPayload,
    CompanionPluginTranslatePayload,
    CompanionPluginTranslateResult,
    CompanionPluginRetryPayload,
    CompanionPluginRetryResult,
    CompanionThemeRetryPayload,
    CompanionThemeRetryResult,
    CompanionThemeTranslatePayload,
    CompanionThemeTranslateResult,
} from './companion-worker-types';
import { AstTranslator } from '../utils/translator/core-ast-translator';
import { RegexTranslator } from '../utils/translator/core-regex-translator';
import { handlePluginExtractCore, handleThemeExtractCore } from './companion-extract-core';

const port = Number(process.argv[2]) || 18743;
const host = '127.0.0.1';
const companionWorkerProtocolVersion = 2;
const defaultMaxBodyBytes = 128 * 1024 * 1024;
const configuredMaxBodyBytes = Number(process.env.I18N_COMPANION_MAX_BODY_BYTES || '');
const maxBodyBytes = Number.isFinite(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0
    ? Math.floor(configuredMaxBodyBytes)
    : defaultMaxBodyBytes;
const extractCheckpointEveryResources = 100;
const extractCheckpointEveryMs = 10_000;
const extractThreadScript = path.join(__dirname, 'i18n-companion-extract-thread.cjs');
const defaultExtractThreadTimeoutMs = 5 * 60 * 1000;
const configuredExtractThreadTimeoutMs = Number(process.env.I18N_COMPANION_EXTRACT_THREAD_TIMEOUT_MS || '');
const extractThreadTimeoutMs = Number.isFinite(configuredExtractThreadTimeoutMs) && configuredExtractThreadTimeoutMs > 0
    ? Math.floor(configuredExtractThreadTimeoutMs)
    : defaultExtractThreadTimeoutMs;

const cjsSyncTaskTypes = new Set<string>([
    'plugin-extract',
    'theme-extract',
    'code-extract',
    'ast-replace',
    'plugin-render-translation',
    'plugin-diagnose-render-probe',
    'plugin-apply-translation',
    'theme-apply-translation',
] satisfies CompanionBatchTaskType[]);

const isolatedSyncTaskTypes = new Set<string>([
    'plugin-diagnose-render-probe',
] satisfies CompanionBatchTaskType[]);

const cjsAsyncTaskTypes = new Set<string>([
    'plugin-batch-extract',
    'theme-batch-extract',
] satisfies CompanionAsyncTaskType[]);

const rustOwnedTaskTypes = new Set<string>([
    'plugin-translate',
    'theme-translate',
    'plugin-retry',
    'theme-retry',
    'plugin-batch-translate',
    'theme-batch-translate',
    'plugin-failure-retry',
    'theme-failure-retry',
    'plugin-diagnose-cleanup-start',
    'plugin-diagnose-cleanup-step',
    'plugin-diagnose-cleanup-cancel',
    'plugin-diagnose-cleanup-apply',
    'source-read',
    'source-export',
    'source-import',
    'source-remove',
    'source-set-active',
    'source-index',
    'source-clear-batch-records',
    'cloud-publish-source',
    'cloud-download-source',
    'cloud-update-sources',
    'cloud-prepare-backup',
    'cloud-restore-all',
    'cloud-backup-all',
] satisfies Array<CompanionBatchTaskType | CompanionAsyncTaskType>);

type JsonRecord = Record<string, any>;

class BodyLimitError extends Error {
    constructor(limit: number) {
        super(`请求体过大，请求上限为 ${Math.round(limit / 1024 / 1024)} MB`);
        this.name = 'BodyLimitError';
    }
}

class IsolatedTaskError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'IsolatedTaskError';
    }
}

function send(res: http.ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBodyBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            if (!tooLarge) chunks.push(Buffer.from(chunk));
        });
        req.on('end', () => {
            if (tooLarge) {
                reject(new BodyLimitError(maxBodyBytes));
                return;
            }
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', reject);
    });
}

function writeRawJson(res: http.ServerResponse, status: number, body: string) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    res.end(body);
}

function runIsolatedStdioTaskRaw(body: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const workerScript = process.argv[1] || __filename;
        const child = spawn(process.execPath, [workerScript, 'stdio-task'], {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let settled = false;
        const timeoutMs = Math.max(1_000, Number(process.env.I18N_COMPANION_ISOLATED_TASK_TIMEOUT_MS || 120_000));
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            reject(new IsolatedTaskError(`隔离 CJS 任务超时：${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)));
        child.stderr.on('data', chunk => stderrChunks.push(Buffer.from(chunk)));
        child.on('error', error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on('exit', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            const stdout = Buffer.concat(stdoutChunks).toString('utf8');
            if (code === 0 && stdout.trim()) {
                resolve(stdout);
                return;
            }
            const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
            reject(new IsolatedTaskError(stderr || `隔离 CJS 任务退出码：${code}`));
        });
        child.stdin.end(body);
    });
}

function readTaskTypeFromRawBody(body: string): string {
    const match = body.match(/"type"\s*:\s*"([^"]+)"/);
    return match?.[1] || '';
}

function sanitizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(headers || {})) {
        const lower = key.toLowerCase();
        if (['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding'].includes(lower)) continue;
        const value = headers?.[key];
        if (value === undefined || value === null) continue;
        result[key] = String(value);
    }
    result['accept-encoding'] = 'identity';
    return result;
}

function decodeBody(buffer: Buffer, encoding: string | string[] | undefined): string {
    const value = Array.isArray(encoding) ? encoding[0] : encoding;
    const normalized = String(value || '').toLowerCase();
    try {
        if (normalized.includes('gzip')) return zlib.gunzipSync(buffer).toString('utf8');
        if (normalized.includes('br') && zlib.brotliDecompressSync) return zlib.brotliDecompressSync(buffer).toString('utf8');
        if (normalized.includes('deflate')) return zlib.inflateSync(buffer).toString('utf8');
    } catch { }
    return buffer.toString('utf8');
}

function normalizeResponseHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
    const result: Record<string, string> = {};
    for (const key of Object.keys(headers || {})) {
        const value = headers[key];
        if (value === undefined || value === null) continue;
        result[key] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return result;
}

function proxy(payload: CompanionProxyRequest): Promise<CompanionProxyResponse> {
    return new Promise((resolve, reject) => {
        const target = new URL(payload.url);
        if (target.protocol !== 'http:' && target.protocol !== 'https:') {
            reject(new Error('只允许 HTTP/HTTPS 请求'));
            return;
        }

        const requestBody = payload.body || '';
        const headers = sanitizeHeaders(payload.headers || {});
        if (requestBody) headers['content-length'] = String(Buffer.byteLength(requestBody));

        const transport = target.protocol === 'https:' ? https : http;
        const upstream = transport.request(target, {
            method: payload.method || 'POST',
            headers,
            timeout: Math.max(1000, Number(payload.timeoutMs || 60000)),
        }, upstreamResponse => {
            const chunks: Buffer[] = [];
            upstreamResponse.on('data', chunk => chunks.push(Buffer.from(chunk)));
            upstreamResponse.on('end', () => {
                const body = decodeBody(Buffer.concat(chunks), upstreamResponse.headers['content-encoding']);
                resolve({
                    status: upstreamResponse.statusCode || 0,
                    statusText: upstreamResponse.statusMessage || '',
                    headers: normalizeResponseHeaders(upstreamResponse.headers),
                    body,
                });
            });
        });

        upstream.on('timeout', () => upstream.destroy(new Error('请求超时')));
        upstream.on('error', reject);
        if (requestBody) upstream.write(requestBody);
        upstream.end();
    });
}

function splitIntoBatches<T extends { source?: string }>(items: T[], batchSize: number, batchCharLimit = 0): T[][] {
    const size = Number.isFinite(batchSize) ? Math.max(1, Math.floor(batchSize)) : 1;
    const charLimit = Number.isFinite(batchCharLimit) ? Math.max(0, Math.floor(batchCharLimit)) : 0;
    const batches: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        splitBatchByCharacterLimit(items.slice(index, index + size), charLimit, batches);
    }
    return batches;
}

function splitBatchByCharacterLimit<T extends { source?: string }>(batch: T[], charLimit: number, output: T[][]) {
    if (batch.length === 0) return;
    if (charLimit <= 0 || batch.length === 1 || getBatchSourceCharacterCount(batch) <= charLimit) {
        output.push(batch);
        return;
    }

    const mid = Math.ceil(batch.length / 2);
    splitBatchByCharacterLimit(batch.slice(0, mid), charLimit, output);
    splitBatchByCharacterLimit(batch.slice(mid), charLimit, output);
}

function getBatchSourceCharacterCount<T extends { source?: string }>(batch: T[]) {
    return batch.reduce((sum, item) => sum + Array.from(String(item.source || '')).length, 0);
}

async function runConcurrent<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}

function normalizeStreamingResponseText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('data:')) return text;

    const chunks: string[] = [];
    let lastEvent: any = null;
    let errorEvent: any = null;

    for (const line of text.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;

        const payload = trimmedLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
            const event = JSON.parse(payload);
            lastEvent = event;
            if (event?.error) errorEvent = event;
            const choice = event?.choices?.[0];
            const deltaContent = choice?.delta?.content;
            const messageContent = choice?.message?.content;
            if (typeof deltaContent === 'string') chunks.push(deltaContent);
            if (typeof messageContent === 'string') chunks.push(messageContent);
        } catch { }
    }

    const content = chunks.join('');
    if (!content && errorEvent) return JSON.stringify(errorEvent);
    if (!content) return text;

    return JSON.stringify({
        id: lastEvent?.id || 'companion-worker-stream',
        object: 'chat.completion',
        created: lastEvent?.created || Math.floor(Date.now() / 1000),
        model: lastEvent?.model || '',
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: lastEvent?.choices?.[0]?.finish_reason || 'stop',
        }],
        usage: lastEvent?.usage,
    });
}

async function callChatCompletion(items: JsonRecord[], systemPrompt: string, config: CompanionTranslationConfig): Promise<Array<{ i: number; t: string }>> {
    const startedAt = Date.now();
    const timeoutMs = Math.max(1000, Number(config.timeoutMs || 60000));
    const requestParams: JsonRecord = {
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(items) },
        ],
        model: config.model,
        temperature: 0.3,
        stream: true,
    };

    if (config.responseFormat === 'json_object') {
        requestParams.response_format = { type: 'json_object' };
    } else if (config.responseFormat === 'json_schema') {
        requestParams.response_format = {
            type: 'json_schema',
            json_schema: {
                name: 'translation_result',
                schema: {
                    type: 'object',
                    properties: {
                        items: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: { i: { type: 'number' }, t: { type: 'string' } },
                                required: ['i', 't'],
                                additionalProperties: false,
                            },
                        },
                    },
                    required: ['items'],
                    additionalProperties: false,
                },
                strict: true,
            },
        };
    }

    let response: CompanionProxyResponse;
    try {
        response = await proxy({
            url: config.chatCompletionsUrl,
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify(requestParams),
            timeoutMs,
        });
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        throw normalizeAiError(normalizedError, Date.now() - startedAt, timeoutMs);
    }

    const body = normalizeStreamingResponseText(response.body || '');
    if (response.status < 200 || response.status >= 300) {
        let message = `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
        try {
            const errorPayload = JSON.parse(body);
            const upstreamMessage = errorPayload?.error?.message || errorPayload?.message;
            const upstreamCode = errorPayload?.error?.code || errorPayload?.code;
            const upstreamType = errorPayload?.error?.type || errorPayload?.type;
            message = [message, upstreamMessage, upstreamCode && `code=${upstreamCode}`, upstreamType && `type=${upstreamType}`]
                .filter(Boolean)
                .join('，');
        } catch {
            if (body) message = `${message}，${body.slice(0, 200)}`;
        }
        throw new Error(`AI 端点返回异常（耗时 ${formatDuration(Date.now() - startedAt)}）：${message}`);
    }

    let parsed: any;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new Error(`AI 返回非 JSON 响应（耗时 ${formatDuration(Date.now() - startedAt)}）：${body.slice(0, 200)}`);
    }

    const assistantContent = parsed?.choices?.[0]?.message?.content;
    if (typeof assistantContent !== 'string') {
        throw new Error(`AI 返回缺少 message.content（耗时 ${formatDuration(Date.now() - startedAt)}）`);
    }
    try {
        return parseTranslationResponse(assistantContent || '');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`AI 翻译结果解析失败（耗时 ${formatDuration(Date.now() - startedAt)}）：${message}`);
    }
}

function mapResultsBack<T extends { id: number; source: string; target: string }>(items: T[], simplifiedResults: Array<{ i: number; t: string }>): { translatedItems: T[]; failedItems: T[] } {
    const translatedItems: T[] = [];
    const failedItems: T[] = [];
    for (const item of items) {
        const result = simplifiedResults.find(r => r.i === item.id);
        const target = result ? result.t : undefined;
        if (!target || target.trim() === '' || target.trim() === '空') {
            failedItems.push(item);
            continue;
        }
        translatedItems.push({ ...item, target });
    }
    return { translatedItems, failedItems };
}

async function translateBatches<T extends { id: number; source: string; target: string }>(
    items: T[],
    prompt: string,
    config: CompanionTranslationConfig,
    simplify: (items: T[]) => JsonRecord[],
    onBatchComplete: (batchResult: T[]) => void,
    onBatchFailure: (batchItems: T[], error: Error) => void,
    runAiRequest?: <TResult>(operation: () => Promise<TResult>) => Promise<TResult>,
) {
    if (items.length === 0) return;

    const batches = splitIntoBatches(items, config.batchSize, config.batchCharLimit);
    await runConcurrent(batches, Math.max(1, Math.floor(config.concurrency || 1)), async batch => {
        try {
            const simplified = simplify(batch);
            const translated = runAiRequest
                ? await runAiRequest(() => callChatCompletion(simplified, prompt, config))
                : await callChatCompletion(simplified, prompt, config);
            const batchReport = mapResultsBack(batch, translated);
            if (batchReport.translatedItems.length > 0) onBatchComplete(batchReport.translatedItems);
            if (batchReport.failedItems.length > 0) {
                onBatchFailure(batchReport.failedItems, new Error('翻译返回缺少部分条目或包含空译文'));
            }
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (isManualStopError(normalizedError)) throw normalizedError;
            onBatchFailure(batch, normalizedError);
        }
    });
}

function shouldTranslateText(target?: string, source?: string, overwriteExisting = false) {
    return overwriteExisting || !target || target.trim() === '' || target === source;
}

const handlePluginExtract = handlePluginExtractCore;
const handleThemeExtract = handleThemeExtractCore;

async function handleCodeExtract(payload: CompanionCodeExtractRequest): Promise<CompanionCodeExtractResponse> {
    try {
        const astTranslator = payload.settings?.astExtractionEnabled !== false
            ? new AstTranslator(payload.settings as any)
            : null;
        const ast = astTranslator ? astTranslator.loadCode(payload.code) : null;
        const regexTranslator = payload.settings?.reExtractionEnabled !== false
            ? new RegexTranslator(payload.settings as any)
            : null;

        return {
            state: true,
            ast: astTranslator && ast ? astTranslator.extract(ast) : [],
            regex: regexTranslator ? regexTranslator.loadCode(payload.code) || [] : [],
        };
    } catch (error) {
        return {
            state: false,
            ast: [],
            regex: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function safeJoin(baseDir: string, relativePath: string) {
    const base = path.resolve(baseDir);
    const target = path.resolve(base, relativePath);
    if (target !== base && !target.startsWith(base + path.sep)) {
        throw new Error(`Unsafe path: ${relativePath}`);
    }
    return target;
}

async function createWorkerBackup(backupBasePath: string, resourceId: string, resourceDir: string, files: string[]) {
    const backupDir = path.join(backupBasePath, 'backups', resourceId);
    await fs.ensureDir(backupDir);

    for (const file of files) {
        const originalPath = safeJoin(resourceDir, file);
        if (!await fs.pathExists(originalPath)) continue;

        const backupPath = path.join(backupDir, `${file}.gz`);
        if (await fs.pathExists(backupPath)) continue;

        await fs.ensureDir(path.dirname(backupPath));
        const content = await fs.readFile(originalPath);
        await fs.writeFile(backupPath, zlib.gzipSync(content));
    }

    for (const legacyPath of [
        path.join(backupBasePath, 'backups', `${resourceId}.js.gz`),
        path.join(backupBasePath, 'backups', `${resourceId}.js`),
    ]) {
        await fs.remove(legacyPath).catch(() => undefined);
    }
}

async function readWorkerBackupContent(backupBasePath: string, resourceId: string, file: string) {
    const backupPath = path.join(backupBasePath, 'backups', resourceId, `${file}.gz`);
    if (await fs.pathExists(backupPath)) {
        return zlib.gunzipSync(await fs.readFile(backupPath)).toString('utf8');
    }
    if (file === 'main.js') {
        const legacyPath = path.join(backupBasePath, 'backups', `${resourceId}.js.gz`);
        if (await fs.pathExists(legacyPath)) {
            return zlib.gunzipSync(await fs.readFile(legacyPath)).toString('utf8');
        }
    }
    return null;
}

async function handleAstReplace(payload: CompanionAstReplaceRequest): Promise<CompanionAstReplaceResponse> {
    try {
        const translator = new AstTranslator({} as any);
        const ast = translator.loadCode(payload.code);
        if (!ast) throw new Error('AST parse failed');
        return { state: true, code: translator.translate(ast, payload.translations as any) };
    } catch (error) {
        return { state: false, code: payload.code, error: error instanceof Error ? error.message : String(error) };
    }
}

async function handlePluginRenderTranslation(payload: CompanionPluginDiagnoseRenderProbeRequest): Promise<CompanionPluginDiagnoseRenderProbeResponse> {
    try {
        const startedAt = Date.now();
        const groupStartedAt = Date.now();
        const grouped = new Map<string, { ast: any[]; regex: any[] }>();
        for (const candidate of payload.candidates || []) {
            const entry = grouped.get(candidate.file) || { ast: [], regex: [] };
            if (candidate.kind === 'ast') entry.ast.push(candidate.item);
            if (candidate.kind === 'regex') entry.regex.push(candidate.item);
            grouped.set(candidate.file, entry);
        }
        const groupMs = Date.now() - groupStartedAt;
        const totalCandidates = (payload.candidates || []).length;
        const astCandidates = (payload.candidates || []).filter(candidate => candidate.kind === 'ast').length;
        const regexCandidates = (payload.candidates || []).filter(candidate => candidate.kind === 'regex').length;
        const fileDiagnostics: NonNullable<CompanionPluginDiagnoseRenderProbeResponse['diagnostics']>['files'] = [];

        const files = (payload.files || []).map(file => {
            const fileStartedAt = Date.now();
            let code = String(file.code || '');
            const translations = grouped.get(file.file);
            const fileLog = {
                file: file.file,
                astCandidates: translations?.ast.length || 0,
                regexCandidates: translations?.regex.length || 0,
                astParseMs: undefined as number | undefined,
                astReplaceMs: undefined as number | undefined,
                regexReplaceMs: undefined as number | undefined,
                totalMs: 0,
            };
            if (translations?.ast.length) {
                const astTranslator = new AstTranslator({} as any);
                const astParseStartedAt = Date.now();
                const ast = astTranslator.loadCode(code);
                fileLog.astParseMs = Date.now() - astParseStartedAt;
                if (!ast) throw new Error(`${file.file} AST parse failed`);
                const astReplaceStartedAt = Date.now();
                code = astTranslator.translate(ast, translations.ast as any);
                fileLog.astReplaceMs = Date.now() - astReplaceStartedAt;
            }
            if (translations?.regex.length) {
                const regexTranslator = new RegexTranslator({} as any);
                const regexStartedAt = Date.now();
                code = regexTranslator.translate(code, translations.regex as any);
                fileLog.regexReplaceMs = Date.now() - regexStartedAt;
            }
            fileLog.totalMs = Date.now() - fileStartedAt;
            fileDiagnostics.push(fileLog);
            return { file: file.file, code };
        });

        return {
            state: true,
            files,
            diagnostics: {
                totalMs: Date.now() - startedAt,
                fileCount: files.length,
                totalCandidates,
                astCandidates,
                regexCandidates,
                groupMs,
                files: fileDiagnostics,
            },
        };
    } catch (error) {
        return {
            state: false,
            files: [],
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function handlePluginApplyTranslation(payload: CompanionPluginApplyTranslationRequest) {
    try {
        const startedAt = Date.now();
        const translationJson = payload.translationJson || (
            payload.persistence && payload.translationSourceId
                ? await readTranslationFile<PluginTranslationV1>(getPersistencePaths(payload.persistence.basePath), payload.translationSourceId)
                : null
        );
        if (!translationJson) throw new Error('翻译文件不存在');
        const dict = translationJson.dict || {};
        const files = Object.keys(dict);
        await createWorkerBackup(payload.backupBasePath, payload.pluginId, payload.pluginDir, files);
        const applyAst = payload.applyAst !== false;
        const applyRegex = payload.applyRegex !== false;

        let processedFiles = 0;
        let astCandidates = 0;
        let regexCandidates = 0;
        const fileDiagnostics: NonNullable<CompanionPluginDiagnoseRenderProbeResponse['diagnostics']>['files'] = [];
        for (const file of files) {
            const fileStartedAt = Date.now();
            const targetFilePath = safeJoin(payload.pluginDir, file);
            if (!await fs.pathExists(targetFilePath)) continue;

            let fileString = await readWorkerBackupContent(payload.backupBasePath, payload.pluginId, file)
                || await fs.readFile(targetFilePath, 'utf8');
            const fileDict = dict[file];
            const astItems = applyAst ? (fileDict?.ast || []) : [];
            const regexItems = applyRegex ? (fileDict?.regex || []) : [];
            astCandidates += astItems.length;
            regexCandidates += regexItems.length;
            const fileLog = {
                file,
                astCandidates: astItems.length,
                regexCandidates: regexItems.length,
                astParseMs: undefined as number | undefined,
                astReplaceMs: undefined as number | undefined,
                regexReplaceMs: undefined as number | undefined,
                totalMs: 0,
            };

            if (astItems.length) {
                const astTranslator = new AstTranslator({} as any);
                const astParseStartedAt = Date.now();
                const ast = astTranslator.loadCode(fileString);
                fileLog.astParseMs = Date.now() - astParseStartedAt;
                if (ast) {
                    const astReplaceStartedAt = Date.now();
                    fileString = astTranslator.translate(ast, astItems as any);
                    fileLog.astReplaceMs = Date.now() - astReplaceStartedAt;
                }
            }
            if (regexItems.length) {
                const regexTranslator = new RegexTranslator({} as any);
                const regexStartedAt = Date.now();
                fileString = regexTranslator.translate(fileString, regexItems as any);
                fileLog.regexReplaceMs = Date.now() - regexStartedAt;
            }

            await fs.writeFile(targetFilePath, fileString);
            processedFiles++;
            fileLog.totalMs = Date.now() - fileStartedAt;
            fileDiagnostics.push(fileLog);
        }

        const totalCandidates = astCandidates + regexCandidates;
        return {
            state: true,
            processedFiles,
            translationVersion: translationJson.metadata?.version || '0.0.0',
            diagnostics: {
                totalMs: Date.now() - startedAt,
                fileCount: processedFiles,
                totalCandidates,
                astCandidates,
                regexCandidates,
                stages: [
                    {
                        name: 'cjs.applyTranslation',
                        durationMs: Date.now() - startedAt,
                        detail: `files=${processedFiles} candidates=${totalCandidates}`,
                    },
                ],
                cjs: {
                    totalMs: Date.now() - startedAt,
                    fileCount: processedFiles,
                    totalCandidates,
                    astCandidates,
                    regexCandidates,
                    groupMs: 0,
                    files: fileDiagnostics,
                },
            },
        };
    } catch (error) {
        return {
            state: false,
            processedFiles: 0,
            translationVersion: payload.translationJson?.metadata?.version || '0.0.0',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

function applyThemeSettingsTranslations(css: string, translations: Array<{ source?: string; target?: string }>) {
    return css.replace(/\/\* @settings([\s\S]*?)\*\//g, (block) => {
        let output = block;
        for (const item of translations) {
            if (!item.source || !item.target || item.source === item.target) continue;
            output = output.split(item.source).join(item.target);
        }
        return output;
    });
}

async function handleThemeApplyTranslation(payload: CompanionThemeApplyTranslationRequest) {
    try {
        const translationJson = payload.translationJson || (
            payload.persistence && payload.translationSourceId
                ? await readTranslationFile<ThemeTranslationV1>(getPersistencePaths(payload.persistence.basePath), payload.translationSourceId)
                : null
        );
        if (!translationJson) throw new Error('翻译文件不存在');
        const cssRelativePath = payload.themeCssRelativePath || 'theme.css';
        await createWorkerBackup(payload.backupBasePath, payload.themeId, payload.themeDir, [cssRelativePath]);
        const backupCss = await readWorkerBackupContent(payload.backupBasePath, payload.themeId, cssRelativePath);
        const sourceCss = backupCss || await fs.readFile(payload.themeCssPath, 'utf8');
        const translatedCss = applyThemeSettingsTranslations(sourceCss, translationJson.dict || []);
        await fs.writeFile(payload.themeCssPath, translatedCss);

        return {
            state: true,
            processedFiles: 1,
            translationVersion: translationJson.metadata?.version || '0.0.0',
        };
    } catch (error) {
        return {
            state: false,
            processedFiles: 0,
            translationVersion: payload.translationJson?.metadata?.version || '0.0.0',
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function handlePluginTranslate(payload: CompanionPluginTranslatePayload, task?: CompanionTaskRuntime): Promise<CompanionPluginTranslateResult> {
    const translationJson = payload.translationJson;
    const astItems: AstItem[] = [];
    const regexItems: RegexItem[] = [];
    const astMappings = new Map<number, { file: string; index: number }>();
    const regexMappings = new Map<number, { file: string; index: number }>();
    const failures: CompanionBatchFailure[] = [];
    const runAiRequest = task ? <TResult>(operation: () => Promise<TResult>) => runTaskAiRequest(task, operation) : undefined;
    let processedItems = 0;
    let nextId = 0;
    let totalItems = 0;

    for (const [file, dict] of Object.entries(translationJson.dict || {})) {
        totalItems += dict.ast.length + dict.regex.length;
        dict.ast.forEach((item, index) => {
            if (!shouldTranslateText(item.target, item.source, payload.config.overwriteExistingTranslations)) return;
            const id = nextId++;
            astItems.push({ id, type: item.type, name: item.name, source: item.source, target: item.target });
            astMappings.set(id, { file, index });
        });

        dict.regex.forEach((item, index) => {
            if (!shouldTranslateText(item.target, item.source, payload.config.overwriteExistingTranslations)) return;
            const id = nextId++;
            regexItems.push({ id, source: item.source, target: item.target });
            regexMappings.set(id, { file, index });
        });
    }

    await Promise.all([
        translateBatches<AstItem>(
            astItems,
            payload.config.prompts.ast,
            payload.config,
            batch => batch.map(item => ({ i: item.id, s: item.source, y: item.type, n: item.name })),
            batchResult => {
                for (const result of batchResult) {
                    const mapping = astMappings.get(result.id);
                    if (!mapping) continue;
                    translationJson.dict[mapping.file].ast[mapping.index].target = result.target;
                }
                processedItems += batchResult.length;
            },
            (batchItems, error) => {
                failures.push({
                    resourceId: payload.resourceId,
                    resourceLabel: payload.resourceLabel,
                    sourceId: payload.sourceId,
                    batchType: 'ast',
                    errorMessage: error.message,
                    items: batchItems.map(item => {
                        const mapping = astMappings.get(item.id);
                        return {
                            source: item.source,
                            target: item.target,
                            dictIndex: mapping?.index ?? -1,
                            file: mapping?.file,
                            type: item.type,
                            name: item.name,
                        };
                    }).filter(item => item.dictIndex >= 0 && item.file),
                });
            },
            runAiRequest,
        ),
        translateBatches<RegexItem>(
            regexItems,
            payload.config.prompts.regex,
            payload.config,
            batch => batch.map(item => ({ i: item.id, s: item.source })),
            batchResult => {
                for (const result of batchResult) {
                    const mapping = regexMappings.get(result.id);
                    if (!mapping) continue;
                    translationJson.dict[mapping.file].regex[mapping.index].target = result.target;
                }
                processedItems += batchResult.length;
            },
            (batchItems, error) => {
                failures.push({
                    resourceId: payload.resourceId,
                    resourceLabel: payload.resourceLabel,
                    sourceId: payload.sourceId,
                    batchType: 'regex',
                    errorMessage: error.message,
                    items: batchItems.map(item => {
                        const mapping = regexMappings.get(item.id);
                        return {
                            source: item.source,
                            target: item.target,
                            dictIndex: mapping?.index ?? -1,
                            file: mapping?.file,
                        };
                    }).filter(item => item.dictIndex >= 0 && item.file),
                });
            },
            runAiRequest,
        ),
    ]);

    return { translationJson, processedItems, failures, totalItems };
}

async function handleThemeTranslate(payload: CompanionThemeTranslatePayload, task?: CompanionTaskRuntime): Promise<CompanionThemeTranslateResult> {
    const translationJson = payload.translationJson;
    const failures: CompanionBatchFailure[] = [];
    const runAiRequest = task ? <TResult>(operation: () => Promise<TResult>) => runTaskAiRequest(task, operation) : undefined;
    let processedItems = 0;
    const totalItems = translationJson.dict.length;

    const items: ThemeTranslationItem[] = translationJson.dict
        .map((item, index) => ({ id: index, type: item.type, source: item.source, target: item.target }))
        .filter(item => shouldTranslateText(item.target, item.source, payload.config.overwriteExistingTranslations)) as ThemeTranslationItem[];

    await translateBatches<ThemeTranslationItem & { id: number }>(
        items as Array<ThemeTranslationItem & { id: number }>,
        payload.config.prompts.theme,
        payload.config,
        batch => batch.map(item => ({ i: item.id, s: item.source, y: item.type })),
        batchResult => {
            for (const result of batchResult) {
                if (typeof result.id !== 'number') continue;
                const dictItem = translationJson.dict[result.id];
                if (!dictItem) continue;
                dictItem.target = result.target;
            }
            processedItems += batchResult.length;
        },
        (batchItems, error) => {
            failures.push({
                resourceId: payload.resourceId,
                resourceLabel: payload.resourceLabel,
                sourceId: payload.sourceId,
                batchType: 'theme',
                errorMessage: error.message,
                items: batchItems.map(item => ({
                    source: item.source,
                    target: item.target,
                    dictIndex: item.id,
                    type: item.type,
                })).filter(item => item.dictIndex >= 0),
            });
        },
        runAiRequest,
    );

    return { translationJson, processedItems, failures, totalItems };
}

async function handlePluginRetry(payload: CompanionPluginRetryPayload, task?: CompanionTaskRuntime): Promise<CompanionPluginRetryResult> {
    const astItems: Array<AstItem & { failureId: string; file: string; dictIndex: number }> = [];
    const regexItems: Array<RegexItem & { failureId: string; file: string; dictIndex: number }> = [];
    const failedFailureIds = new Set<string>();
    const skippedFailureIds = new Set<string>();
    const attempted = new Map<string, number>();
    const succeeded = new Map<string, number>();
    const updates: CompanionPluginRetryResult['updates'] = [];
    const runAiRequest = task ? <TResult>(operation: () => Promise<TResult>) => runTaskAiRequest(task, operation) : undefined;
    let processedItems = 0;
    let nextAstId = 0;
    let nextRegexId = 0;

    const addAttempt = (failureId: string) => attempted.set(failureId, (attempted.get(failureId) || 0) + 1);
    const addSuccess = (failureId: string) => succeeded.set(failureId, (succeeded.get(failureId) || 0) + 1);

    for (const failure of payload.failures) {
        if (failure.batchType === 'ast') {
            let count = 0;
            for (const item of failure.items) {
                if (!item.file || item.dictIndex < 0) {
                    failedFailureIds.add(failure.id);
                    continue;
                }
                astItems.push({
                    id: nextAstId++,
                    failureId: failure.id,
                    file: item.file,
                    dictIndex: item.dictIndex,
                    type: item.type || '',
                    name: item.name || '',
                    source: item.source,
                    target: item.target,
                });
                addAttempt(failure.id);
                count++;
            }
            if (count === 0) skippedFailureIds.add(failure.id);
        } else if (failure.batchType === 'regex') {
            let count = 0;
            for (const item of failure.items) {
                if (!item.file || item.dictIndex < 0) {
                    failedFailureIds.add(failure.id);
                    continue;
                }
                regexItems.push({
                    id: nextRegexId++,
                    failureId: failure.id,
                    file: item.file,
                    dictIndex: item.dictIndex,
                    source: item.source,
                    target: item.target,
                });
                addAttempt(failure.id);
                count++;
            }
            if (count === 0) skippedFailureIds.add(failure.id);
        } else {
            skippedFailureIds.add(failure.id);
        }
    }

    await Promise.all([
        translateBatches<typeof astItems[number]>(
            astItems,
            payload.config.prompts.ast,
            payload.config,
            batch => batch.map(item => ({ i: item.id, s: item.source, y: item.type, n: item.name })),
            batchResult => {
                for (const result of batchResult) {
                    updates.push({
                        batchType: 'ast',
                        failureId: result.failureId,
                        file: result.file,
                        dictIndex: result.dictIndex,
                        target: result.target,
                    });
                    addSuccess(result.failureId);
                }
                processedItems += batchResult.length;
            },
            batchItems => batchItems.forEach(item => failedFailureIds.add(item.failureId)),
            runAiRequest,
        ),
        translateBatches<typeof regexItems[number]>(
            regexItems,
            payload.config.prompts.regex,
            payload.config,
            batch => batch.map(item => ({ i: item.id, s: item.source })),
            batchResult => {
                for (const result of batchResult) {
                    updates.push({
                        batchType: 'regex',
                        failureId: result.failureId,
                        file: result.file,
                        dictIndex: result.dictIndex,
                        target: result.target,
                    });
                    addSuccess(result.failureId);
                }
                processedItems += batchResult.length;
            },
            batchItems => batchItems.forEach(item => failedFailureIds.add(item.failureId)),
            runAiRequest,
        ),
    ]);

    const completedFailureIds = Array.from(attempted.keys()).filter(id => !failedFailureIds.has(id) && (succeeded.get(id) || 0) >= (attempted.get(id) || 0));
    return {
        updates,
        processedItems,
        completedFailureIds,
        failedFailureIds: Array.from(failedFailureIds),
        skippedFailureIds: Array.from(skippedFailureIds),
    };
}

async function handleThemeRetry(payload: CompanionThemeRetryPayload, task?: CompanionTaskRuntime): Promise<CompanionThemeRetryResult> {
    const items: Array<ThemeTranslationItem & { id: number; failureId: string; dictIndex: number }> = [];
    const failedFailureIds = new Set<string>();
    const skippedFailureIds = new Set<string>();
    const attempted = new Map<string, number>();
    const succeeded = new Map<string, number>();
    const updates: CompanionThemeRetryResult['updates'] = [];
    const runAiRequest = task ? <TResult>(operation: () => Promise<TResult>) => runTaskAiRequest(task, operation) : undefined;
    let processedItems = 0;
    let nextItemId = 0;

    const addAttempt = (failureId: string) => attempted.set(failureId, (attempted.get(failureId) || 0) + 1);
    const addSuccess = (failureId: string) => succeeded.set(failureId, (succeeded.get(failureId) || 0) + 1);

    for (const failure of payload.failures) {
        if (failure.batchType !== 'theme') {
            skippedFailureIds.add(failure.id);
            continue;
        }

        let count = 0;
        for (const item of failure.items) {
            if (item.dictIndex < 0) {
                failedFailureIds.add(failure.id);
                continue;
            }
            items.push({
                id: nextItemId++,
                failureId: failure.id,
                dictIndex: item.dictIndex,
                type: item.type || '',
                source: item.source,
                target: item.target,
            });
            addAttempt(failure.id);
            count++;
        }
        if (count === 0) skippedFailureIds.add(failure.id);
    }

    await translateBatches<typeof items[number]>(
        items,
        payload.config.prompts.theme,
        payload.config,
        batch => batch.map(item => ({ i: item.id, s: item.source, y: item.type })),
        batchResult => {
            for (const result of batchResult) {
                updates.push({ failureId: result.failureId, dictIndex: result.dictIndex, target: result.target });
                addSuccess(result.failureId);
            }
            processedItems += batchResult.length;
        },
        batchItems => batchItems.forEach(item => failedFailureIds.add(item.failureId)),
        runAiRequest,
    );

    const completedFailureIds = Array.from(attempted.keys()).filter(id => !failedFailureIds.has(id) && (succeeded.get(id) || 0) >= (attempted.get(id) || 0));
    return {
        updates,
        processedItems,
        completedFailureIds,
        failedFailureIds: Array.from(failedFailureIds),
        skippedFailureIds: Array.from(skippedFailureIds),
    };
}

type WorkerPersistencePaths = {
    basePath: string;
    sourcesDir: string;
    metaPath: string;
    batchTaskRecordPath: string;
};

type CompanionTaskRuntime = {
    progress: CompanionTaskProgress;
    cancelRequested: boolean;
    promise: Promise<void> | null;
    aiQueue: Promise<unknown>;
    extractCleanup?: (() => void | Promise<void>) | null;
};

const tasks = new Map<string, CompanionTaskRuntime>();
let persistenceQueue: Promise<unknown> = Promise.resolve();

function withPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
    const next = persistenceQueue.then(operation, operation);
    persistenceQueue = next.then(() => undefined, () => undefined);
    return next;
}

function formatDuration(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
}

function isManualStopError(error: Error): boolean {
    return error.message.includes('批量任务已手动停止');
}

function isTimeoutError(error: Error): boolean {
    return error.message.includes('请求超时') || error.message.toLowerCase().includes('timeout');
}

function normalizeAiError(error: Error, elapsedMs: number, timeoutMs: number): Error {
    const timedOut = isTimeoutError(error);
    const prefix = timedOut ? 'AI 请求超时' : 'AI 请求失败';
    return new Error(`${prefix}（耗时 ${formatDuration(elapsedMs)}，超时 ${formatDuration(timeoutMs)}）：${error.message}`);
}

async function runTaskAiRequest<T>(task: CompanionTaskRuntime | undefined, operation: () => Promise<T>): Promise<T> {
    if (!task) return operation();
    if (task.cancelRequested) throw new Error('批量任务已手动停止');

    const next = task.aiQueue.then(async () => {
        if (task.cancelRequested) throw new Error('批量任务已手动停止');
        try {
            const result = await operation();
            if (task.cancelRequested) throw new Error('批量任务已手动停止');
            return result;
        } catch (error) {
            if (task.cancelRequested) throw new Error('批量任务已手动停止');
            throw error;
        }
    }, async () => {
        if (task.cancelRequested) throw new Error('批量任务已手动停止');
        try {
            const result = await operation();
            if (task.cancelRequested) throw new Error('批量任务已手动停止');
            return result;
        } catch (error) {
            if (task.cancelRequested) throw new Error('批量任务已手动停止');
            throw error;
        }
    });
    task.aiQueue = next.then(() => undefined, () => undefined);
    return next;
}

function getPersistencePaths(basePath: string): WorkerPersistencePaths {
    return {
        basePath,
        sourcesDir: path.join(basePath, 'translations'),
        metaPath: path.join(basePath, 'metadata.json'),
        batchTaskRecordPath: path.join(basePath, 'batch-task-records.json'),
    };
}

function createEmptyMeta(): TranslationSourceMeta {
    return { schemaVersion: 2, sources: {} };
}

function createEmptyBatchTaskRecord(): BatchTaskRecordMeta {
    return { schemaVersion: 1, checkpoints: {}, failures: [], updatedAt: 0 };
}

async function loadMeta(paths: WorkerPersistencePaths): Promise<TranslationSourceMeta> {
    try {
        if (!await fs.pathExists(paths.metaPath)) return createEmptyMeta();
        const raw = await fs.readJson(paths.metaPath);
        return raw?.sources ? raw : createEmptyMeta();
    } catch {
        return createEmptyMeta();
    }
}

async function saveMeta(paths: WorkerPersistencePaths, meta: TranslationSourceMeta) {
    await fs.ensureDir(paths.sourcesDir);
    await fs.writeJson(paths.metaPath, meta, { spaces: 2 });
}

async function loadBatchTaskRecord(paths: WorkerPersistencePaths): Promise<BatchTaskRecordMeta> {
    try {
        if (!await fs.pathExists(paths.batchTaskRecordPath)) return createEmptyBatchTaskRecord();
        const raw = await fs.readJson(paths.batchTaskRecordPath);
        return {
            schemaVersion: raw?.schemaVersion || 1,
            checkpoints: raw?.checkpoints || {},
            failures: Array.isArray(raw?.failures) ? raw.failures : [],
            successBatches: Array.isArray(raw?.successBatches) ? raw.successBatches : [],
            updatedAt: raw?.updatedAt || 0,
        };
    } catch {
        return createEmptyBatchTaskRecord();
    }
}

async function saveBatchTaskRecord(paths: WorkerPersistencePaths, record: BatchTaskRecordMeta) {
    await fs.ensureDir(paths.basePath);
    await fs.writeJson(paths.batchTaskRecordPath, { ...record, updatedAt: Date.now() }, { spaces: 2 });
}

async function saveTranslationFile(paths: WorkerPersistencePaths, sourceId: string, content: unknown) {
    await fs.ensureDir(paths.sourcesDir);
    await fs.writeFile(path.join(paths.sourcesDir, `${sourceId}.json`), JSON.stringify(content, null, 4), 'utf8');
}

async function readTranslationFile<T>(paths: WorkerPersistencePaths, sourceId: string): Promise<T | null> {
    try {
        const filePath = path.join(paths.sourcesDir, `${sourceId}.json`);
        if (!await fs.pathExists(filePath)) return null;
        return await fs.readJson(filePath) as T;
    } catch {
        return null;
    }
}

function getTranslationMetadataIndex(content: any): Pick<TranslationSource, 'translationVersion' | 'supportedVersions' | 'language' | 'description' | 'totalTranslationCount' | 'pendingTranslationCount' | 'translatedEntryCount' | 'processedTranslationCount' | 'unprocessedTranslationCount' | 'translationProcessingComplete' | 'translationFormatValid' | 'metadataIndexedAt'> {
    const metadata = content?.metadata || {};
    const isPendingTranslation = (item: any) => {
        const source = String(item?.source || '').trim();
        const target = String(item?.target || '').trim();
        return target === '' || target === source;
    };
    const isTranslatedEntry = (item: any) => {
        const source = String(item?.source || '').trim();
        const target = String(item?.target || '').trim();
        return target !== '' && target !== source;
    };
    let totalTranslationCount = 0;
    let pendingTranslationCount = 0;
    let translatedEntryCount = 0;
    let translationFormatValid = !!(content && content.schemaVersion !== undefined && content.metadata && content.dict);

    if (content?.dict && typeof content.dict === 'object') {
        if (Array.isArray(content.dict)) {
            totalTranslationCount = content.dict.length;
            pendingTranslationCount = content.dict.filter(isPendingTranslation).length;
            translatedEntryCount = content.dict.filter(isTranslatedEntry).length;
        } else {
            for (const group of Object.values(content.dict) as any[]) {
                if (!Array.isArray(group?.ast) || !Array.isArray(group?.regex)) translationFormatValid = false;
                const items = [...(Array.isArray(group?.ast) ? group.ast : []), ...(Array.isArray(group?.regex) ? group.regex : [])];
                totalTranslationCount += items.length;
                pendingTranslationCount += items.filter(isPendingTranslation).length;
                translatedEntryCount += items.filter(isTranslatedEntry).length;
            }
        }
    } else {
        translationFormatValid = false;
    }

    return {
        translationVersion: metadata.version ? String(metadata.version) : '',
        supportedVersions: metadata.supportedVersions ? String(metadata.supportedVersions) : '',
        language: metadata.language ? String(metadata.language) : '',
        description: metadata.description ? String(metadata.description) : '',
        totalTranslationCount,
        pendingTranslationCount,
        translatedEntryCount,
        processedTranslationCount: 0,
        unprocessedTranslationCount: totalTranslationCount,
        translationProcessingComplete: false,
        translationFormatValid,
        metadataIndexedAt: Date.now(),
    };
}

async function getTranslationSourceFileMtime(paths: WorkerPersistencePaths, sourceId: string) {
    try {
        const stat = await fs.stat(path.join(paths.sourcesDir, `${sourceId}.json`));
        return stat.mtimeMs;
    } catch {
        return Date.now();
    }
}

async function hasExistingExtractedSource(paths: WorkerPersistencePaths, pluginId: string, type: 'plugin' | 'theme', translationVersion: string): Promise<boolean> {
    const meta = await loadMeta(paths);
    for (const source of Object.values(meta.sources)) {
        if (source.plugin !== pluginId || source.type !== type) continue;
        if (translationVersion && source.translationVersion !== translationVersion) continue;
        if (await fs.pathExists(path.join(paths.sourcesDir, `${source.id}.json`))) return true;
    }
    return false;
}

async function saveExtractedSource(paths: WorkerPersistencePaths, pluginId: string, content: PluginTranslationV1 | ThemeTranslationV1, options: { title: string; type?: 'theme' }): Promise<boolean> {
    return withPersistenceLock(async () => {
        const meta = await loadMeta(paths);
        const type = options.type || 'plugin';
        const translationVersion = content.metadata?.version || '';
        for (const source of Object.values(meta.sources)) {
            if (source.plugin !== pluginId || source.type !== type) continue;
            if (translationVersion && source.translationVersion !== translationVersion) continue;
            if (await fs.pathExists(path.join(paths.sourcesDir, `${source.id}.json`))) return false;
        }
        const now = Date.now();
        const sourceId = nanoid(32);
        for (const source of Object.values(meta.sources)) {
            if (source.plugin === pluginId) source.isActive = false;
        }
        await saveTranslationFile(paths, sourceId, content);
        const source: TranslationSource = {
            id: sourceId,
            plugin: pluginId,
            title: options.title || 'Local extraction',
            type,
            origin: 'local',
            isActive: true,
            checksum: calculateChecksum(content),
            ...getTranslationMetadataIndex(content),
            sourceFileExists: true,
            sourceFileMtime: await getTranslationSourceFileMtime(paths, sourceId),
            createdAt: now,
            updatedAt: now,
        };
        meta.sources[sourceId] = source;
        await saveMeta(paths, meta);
        return true;
    });
}

async function saveTranslatedSource(paths: WorkerPersistencePaths, sourceId: string, content: PluginTranslationV1 | ThemeTranslationV1) {
    await withPersistenceLock(async () => {
        const meta = await loadMeta(paths);
        const source = meta.sources[sourceId];
        await saveTranslationFile(paths, sourceId, content);
        if (source) {
            meta.sources[sourceId] = {
                ...source,
                title: content.metadata?.title || source.title,
                origin: 'local',
                cloud: undefined,
                checksum: calculateChecksum(content),
                ...getTranslationMetadataIndex(content),
                sourceFileExists: true,
                sourceFileMtime: await getTranslationSourceFileMtime(paths, sourceId),
                updatedAt: Date.now(),
            };
            await saveMeta(paths, meta);
        }
    });
}

async function updateSourceProcessingState(
    paths: WorkerPersistencePaths,
    sourceId: string,
    processedTranslationCount: number,
    unprocessedTranslationCount: number,
    translationProcessingComplete: boolean,
) {
    await withPersistenceLock(async () => {
        const meta = await loadMeta(paths);
        const source = meta.sources[sourceId];
        if (!source) return;
        meta.sources[sourceId] = {
            ...source,
            processedTranslationCount,
            unprocessedTranslationCount,
            translationProcessingComplete,
            updatedAt: Date.now(),
        };
        await saveMeta(paths, meta);
    });
}

function getProcessingStateFromTranslationResult(result: CompanionPluginTranslateResult | CompanionThemeTranslateResult) {
    const failedItems = result.failures.reduce((sum, failure) => sum + failure.items.length, 0);
    const unprocessedTranslationCount = Math.max(0, failedItems);
    return {
        processedTranslationCount: Math.max(0, result.totalItems - unprocessedTranslationCount),
        unprocessedTranslationCount,
        translationProcessingComplete: result.failures.length === 0 && unprocessedTranslationCount === 0,
    };
}

function buildFailureRecord(scope: BatchTaskScope, failure: CompanionBatchFailure): BatchTaskFailureRecord {
    return {
        ...failure,
        id: `${failure.sourceId}:${failure.batchType}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        scope,
        failedAt: Date.now(),
    };
}

async function updateBatchRecord(paths: WorkerPersistencePaths, updater: (record: BatchTaskRecordMeta) => void) {
    await withPersistenceLock(async () => {
        const record = await loadBatchTaskRecord(paths);
        updater(record);
        await saveBatchTaskRecord(paths, record);
    });
}

async function saveCheckpoint(paths: WorkerPersistencePaths, key: string, checkpoint: BatchTaskCheckpoint) {
    await updateBatchRecord(paths, record => {
        record.checkpoints[key] = checkpoint;
    });
}

async function clearCheckpoint(paths: WorkerPersistencePaths, key: string) {
    await updateBatchRecord(paths, record => {
        delete record.checkpoints[key];
    });
}

async function replaceFailuresForSource(paths: WorkerPersistencePaths, scope: BatchTaskScope, sourceId: string, failures: CompanionBatchFailure[]) {
    await updateBatchRecord(paths, record => {
        record.failures = record.failures.filter(item => !(item.scope === scope && item.sourceId === sourceId));
        for (const failure of failures.map(item => buildFailureRecord(scope, item))) {
            record.failures.unshift(failure);
        }
        if (record.failures.length > 500) record.failures = record.failures.slice(0, 500);
    });
}

async function removeFailures(paths: WorkerPersistencePaths, ids: string[]) {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    await updateBatchRecord(paths, record => {
        record.failures = record.failures.filter(item => !idSet.has(item.id));
    });
}

function touchProgress(task: CompanionTaskRuntime, updates: Partial<CompanionTaskProgress> = {}) {
    Object.assign(task.progress, updates, { updatedAt: Date.now() });
}

function bumpSourceRevision(task: CompanionTaskRuntime) {
    touchProgress(task, { sourceRevision: task.progress.sourceRevision + 1 });
}

function bumpRecordRevision(task: CompanionTaskRuntime) {
    touchProgress(task, { recordRevision: task.progress.recordRevision + 1 });
}

function isTaskActive(task: CompanionTaskRuntime) {
    return !task.cancelRequested && task.progress.status !== 'cancelled' && task.progress.status !== 'failed';
}

async function requestTaskCancel(task: CompanionTaskRuntime) {
    task.cancelRequested = true;
    touchProgress(task, { currentLabel: '正在停止' });
    const cleanup = task.extractCleanup;
    task.extractCleanup = null;
    if (cleanup) void Promise.resolve(cleanup()).catch((error: unknown) => console.warn('[i18n] Failed to cleanup extract workers:', error));
}

async function runConcurrentCancellable<T>(items: T[], limit: number, task: CompanionTaskRuntime, worker: (item: T, index: number) => Promise<void>) {
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
        while (isTaskActive(task)) {
            const index = nextIndex++;
            if (index >= items.length) return;
            await worker(items[index], index);
        }
    });
    await Promise.all(workers);
}

function getExtractThreadLimit(limit: number, total: number) {
    const cpuCount = os.cpus()?.length || 1;
    return Math.min(Math.max(1, Math.floor(limit || 1)), Math.max(1, total), Math.max(1, cpuCount));
}

type ExtractThreadRequest =
    | { type: 'plugin'; payload: CompanionPluginExtractPayload }
    | { type: 'theme'; payload: CompanionThemeExtractPayload };

type ExtractThreadResult = CompanionPluginExtractResult | CompanionThemeExtractResult;

type WeightedExtractThreadRequest = ExtractThreadRequest & {
    index: number;
    weight: number;
};

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

function createFailedExtractThreadResult(request: ExtractThreadRequest, error: unknown): ExtractThreadResult {
    return {
        status: 'failed',
        resourceId: request.payload.resourceId,
        label: request.payload.label,
        error: getErrorMessage(error),
    };
}

type ExtractCheckpointState<T extends CompanionBatchResource> = {
    scope: BatchTaskScope;
    mode: 'extract';
    resources: T[];
    completedIndexes: Set<number>;
    lastCheckpointAt: { value: number };
};

async function getExtractRequestSize(request: ExtractThreadRequest) {
    const targetPath = request.type === 'plugin' ? request.payload.mainDoc : request.payload.themeCssPath;
    try {
        return (await fs.stat(targetPath)).size;
    } catch {
        return 0;
    }
}

function getExtractRequestWeight(size: number) {
    const mb = size / (1024 * 1024);
    if (mb >= 25) return 8;
    if (mb >= 10) return 4;
    if (mb >= 5) return 2;
    return 1;
}

async function buildWeightedExtractRequests(requests: ExtractThreadRequest[]) {
    const weighted = await Promise.all(requests.map(async (request, index) => ({
        ...request,
        index,
        weight: getExtractRequestWeight(await getExtractRequestSize(request)),
    })));
    return weighted.sort((left, right) => right.weight - left.weight);
}

async function runExtractThreadPool(
    requests: ExtractThreadRequest[],
    limit: number,
    task: CompanionTaskRuntime,
    onComplete: (result: ExtractThreadResult, index: number) => Promise<void>,
) {
    if (requests.length === 0) return;

    if (!await fs.pathExists(extractThreadScript)) {
        throw new Error(`CJS extract thread worker not found: ${extractThreadScript}`);
    }

    let nextMessageId = 1;
    const workerCount = getExtractThreadLimit(limit, requests.length);
    const weightedRequests = await buildWeightedExtractRequests(requests);
    const runningWorkers = new Set<Worker>();
    let nextIndex = 0;
    let activeWeight = 0;
    let activeCount = 0;
    let completedCount = 0;

    const cleanupWorkers = () => {
        const workers = Array.from(runningWorkers);
        runningWorkers.clear();
        for (const worker of workers) {
            void worker.terminate().catch(() => undefined);
        }
    };

    task.extractCleanup = cleanupWorkers;

    const runRequestInWorker = async (request: WeightedExtractThreadRequest) => {
        const worker = new Worker(extractThreadScript);
        worker.unref();
        runningWorkers.add(worker);
        const pending = new Map<number, {
            resolve: (result: ExtractThreadResult) => void;
            reject: (error: Error) => void;
        }>();

        const cleanup = () => {
            pending.forEach(({ reject }) => reject(new Error('CJS extract thread stopped')));
            pending.clear();
            runningWorkers.delete(worker);
            void worker.terminate().catch(() => undefined);
        };

        worker.on('message', message => {
            const pendingRequest = pending.get(message?.id);
            if (!pendingRequest) return;
            pending.delete(message.id);
            if (message.ok) {
                pendingRequest.resolve(message.result);
            } else {
                pendingRequest.reject(new Error(message.error || 'CJS extract thread failed'));
            }
        });

        worker.on('error', error => {
            pending.forEach(({ reject }) => reject(error));
            pending.clear();
        });

        worker.on('exit', code => {
            if (code === 0 || pending.size === 0) return;
            const error = new Error(`CJS extract thread exited with code ${code}`);
            pending.forEach(({ reject }) => reject(error));
            pending.clear();
        });

        const runRequest = (request: ExtractThreadRequest) => new Promise<ExtractThreadResult>((resolve, reject) => {
            const id = nextMessageId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`CJS extract thread timeout after ${extractThreadTimeoutMs}ms`));
                void worker.terminate().catch(() => undefined);
            }, extractThreadTimeoutMs);
            const settleResolve = (result: ExtractThreadResult) => {
                clearTimeout(timer);
                resolve(result);
            };
            const settleReject = (error: Error) => {
                clearTimeout(timer);
                reject(error);
            };
            pending.set(id, { resolve: settleResolve, reject: settleReject });
            try {
                worker.postMessage({ id, ...request });
            } catch (error) {
                pending.delete(id);
                settleReject(error instanceof Error ? error : new Error(String(error)));
            }
        });

        try {
            if (!isTaskActive(task)) return;
            touchProgress(task, { currentLabel: request.payload.label });
            let result: ExtractThreadResult;
            try {
                result = await runRequest(request);
            } catch (error) {
                result = createFailedExtractThreadResult(request, error);
            }
            await onComplete(result, request.index);
        } finally {
            cleanup();
        }
    };

    await new Promise<void>((resolve, reject) => {
        let settled = false;

        const settleReject = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanupWorkers();
            reject(error);
        };

        const finishOne = (request: WeightedExtractThreadRequest) => {
            activeCount--;
            activeWeight -= request.weight;
            completedCount++;
            if (completedCount >= weightedRequests.length) {
                settled = true;
                task.extractCleanup = null;
                cleanupWorkers();
                resolve();
                return;
            }
            schedule();
        };

        const schedule = () => {
            if (settled) return;
            if (!isTaskActive(task)) {
                settled = true;
                cleanupWorkers();
                resolve();
                return;
            }

            while (
                nextIndex < weightedRequests.length &&
                activeCount < workerCount &&
                activeWeight + weightedRequests[nextIndex].weight <= workerCount
            ) {
                const request = weightedRequests[nextIndex++];
                activeCount++;
                activeWeight += request.weight;
                runRequestInWorker(request)
                    .then(() => finishOne(request))
                    .catch(error => {
                        activeCount--;
                        activeWeight -= request.weight;
                        settleReject(error);
                    });
            }

            if (activeCount === 0 && nextIndex < weightedRequests.length) {
                const request = weightedRequests[nextIndex++];
                activeCount++;
                activeWeight += request.weight;
                runRequestInWorker(request)
                    .then(() => finishOne(request))
                    .catch(error => {
                        activeCount--;
                        activeWeight -= request.weight;
                        settleReject(error);
                    });
            }
        };

        schedule();
    }).finally(() => {
        task.extractCleanup = null;
    });
}

function countPendingPluginItems(json: PluginTranslationV1, overwriteExisting = false): number {
    let count = 0;
    for (const dict of Object.values(json?.dict || {})) {
        count += dict.ast.filter(item => shouldTranslateText(item.target, item.source, overwriteExisting)).length;
        count += dict.regex.filter(item => shouldTranslateText(item.target, item.source, overwriteExisting)).length;
    }
    return count;
}

function countPendingThemeItems(json: ThemeTranslationV1, overwriteExisting = false): number {
    return (json?.dict || []).filter(item => shouldTranslateText(item.target, item.source, overwriteExisting)).length;
}

function createCheckpoint<T extends CompanionBatchResource>(scope: BatchTaskScope, mode: 'extract' | 'translate', resources: T[], completedIndexes: Set<number>, progress: CompanionTaskProgress): BatchTaskCheckpoint {
    return {
        scope,
        mode,
        resources: resources.filter((_, index) => !completedIndexes.has(index)).map(resource => ({
            resourceId: resource.resourceId,
            label: resource.label,
            sourceId: resource.sourceId ?? null,
        })),
        totalResources: progress.totalResources,
        completedResources: progress.processedResources,
        totalItems: progress.totalItems,
        processedItems: progress.processedItems,
        stoppedAt: Date.now(),
    };
}

function shouldSaveExtractCheckpoint(progress: CompanionTaskProgress, lastCheckpointAt: { value: number }) {
    if (progress.processedResources === progress.totalResources) return false;
    if (progress.processedResources % extractCheckpointEveryResources === 0) return true;
    const now = Date.now();
    if (now - lastCheckpointAt.value < extractCheckpointEveryMs) return false;
    lastCheckpointAt.value = now;
    return true;
}

async function saveExtractCheckpointIfNeeded<T extends CompanionBatchResource>(
    paths: WorkerPersistencePaths,
    key: string,
    progress: CompanionTaskProgress,
    state: ExtractCheckpointState<T>,
) {
    if (!shouldSaveExtractCheckpoint(progress, state.lastCheckpointAt)) return false;
    await saveCheckpoint(paths, key, createCheckpoint(state.scope, state.mode, state.resources, state.completedIndexes, progress));
    return true;
}

async function handlePluginBatchExtract(task: CompanionTaskRuntime, payload: CompanionPluginBatchExtractPayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const translationVersion = payload.translationVersion || payload.settings.translationVersion || '1.0.1';
    const checkpointState: ExtractCheckpointState<CompanionBatchResource> = {
        scope: 'plugin',
        mode: 'extract',
        resources: payload.resources,
        completedIndexes: new Set<number>(),
        lastCheckpointAt: { value: Date.now() },
    };
    const requests: ExtractThreadRequest[] = [];
    const requestIndexes: number[] = [];
    for (const [index, resource] of payload.resources.entries()) {
        if (await hasExistingExtractedSource(paths, resource.resourceId, 'plugin', translationVersion)) {
            checkpointState.completedIndexes.add(index);
            task.progress.processedResources++;
            task.progress.skippedCount++;
            if (task.progress.processedResources === task.progress.totalResources) touchProgress(task, { currentLabel: '' });
            touchProgress(task);
            if (await saveExtractCheckpointIfNeeded(paths, payload.checkpointKey, task.progress, checkpointState)) {
                bumpRecordRevision(task);
            }
            continue;
        }
        requests.push({
            type: 'plugin',
            payload: { ...resource, language: payload.language, settings: payload.settings },
        });
        requestIndexes.push(index);
    }

    await runExtractThreadPool(requests, payload.concurrency, task, async (result, requestIndex) => {
        if (!isTaskActive(task)) return;
        const index = requestIndexes[requestIndex];
        if (result.status === 'success') {
            const saved = await saveExtractedSource(paths, result.pluginId, result.content, result.options);
            if (saved) {
                bumpSourceRevision(task);
                task.progress.successCount++;
            } else {
                task.progress.skippedCount++;
            }
        } else if (result.status === 'skipped') {
            task.progress.skippedCount++;
        } else {
            task.progress.failedCount++;
            console.error(`[i18n] Failed to batch extract plugin ${result.resourceId}:`, result.error);
        }
        checkpointState.completedIndexes.add(index);
        task.progress.processedResources++;
        if (task.progress.processedResources === task.progress.totalResources) touchProgress(task, { currentLabel: '' });
        touchProgress(task);
        if (await saveExtractCheckpointIfNeeded(paths, payload.checkpointKey, task.progress, checkpointState)) {
            bumpRecordRevision(task);
        }
    });

    if (task.cancelRequested) return;
    await clearCheckpoint(paths, payload.checkpointKey);
    bumpRecordRevision(task);
}

async function handleThemeBatchExtract(task: CompanionTaskRuntime, payload: CompanionThemeBatchExtractPayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const translationVersion = payload.translationVersion || payload.settings.translationVersion || '1.0.1';
    const checkpointState: ExtractCheckpointState<CompanionBatchResource> = {
        scope: 'theme',
        mode: 'extract',
        resources: payload.resources,
        completedIndexes: new Set<number>(),
        lastCheckpointAt: { value: Date.now() },
    };
    const requests: ExtractThreadRequest[] = [];
    const requestIndexes: number[] = [];
    for (const [index, resource] of payload.resources.entries()) {
        if (await hasExistingExtractedSource(paths, resource.resourceId, 'theme', translationVersion)) {
            checkpointState.completedIndexes.add(index);
            task.progress.processedResources++;
            task.progress.skippedCount++;
            if (task.progress.processedResources === task.progress.totalResources) touchProgress(task, { currentLabel: '' });
            touchProgress(task);
            if (await saveExtractCheckpointIfNeeded(paths, payload.checkpointKey, task.progress, checkpointState)) {
                bumpRecordRevision(task);
            }
            continue;
        }
        requests.push({
            type: 'theme',
            payload: { ...resource, settings: payload.settings },
        });
        requestIndexes.push(index);
    }

    await runExtractThreadPool(requests, payload.concurrency, task, async (result, requestIndex) => {
        if (!isTaskActive(task)) return;
        const index = requestIndexes[requestIndex];
        if (result.status === 'success') {
            const saved = await saveExtractedSource(paths, result.pluginId, result.content, { title: result.options.title, type: 'theme' });
            if (saved) {
                bumpSourceRevision(task);
                task.progress.successCount++;
            } else {
                task.progress.skippedCount++;
            }
        } else if (result.status === 'skipped') {
            task.progress.skippedCount++;
        } else {
            task.progress.failedCount++;
            console.error(`[i18n] Failed to batch extract theme ${result.resourceId}:`, result.error);
        }
        checkpointState.completedIndexes.add(index);
        task.progress.processedResources++;
        if (task.progress.processedResources === task.progress.totalResources) touchProgress(task, { currentLabel: '' });
        touchProgress(task);
        if (await saveExtractCheckpointIfNeeded(paths, payload.checkpointKey, task.progress, checkpointState)) {
            bumpRecordRevision(task);
        }
    });

    if (task.cancelRequested) return;
    await clearCheckpoint(paths, payload.checkpointKey);
    bumpRecordRevision(task);
}

async function handlePluginBatchTranslate(task: CompanionTaskRuntime, payload: CompanionPluginBatchTranslatePayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const completedIndexes = new Set<number>();
    await runConcurrentCancellable(payload.resources, Math.max(1, payload.concurrency || 1), task, async (resource, index) => {
        if (!isTaskActive(task)) return;
        touchProgress(task, { currentLabel: resource.label });
        const sourceId = resource.sourceId;
        if (!sourceId) {
            task.progress.skippedCount++;
        } else {
            const translationJson = await readTranslationFile<PluginTranslationV1>(paths, sourceId);
            const pendingCount = translationJson ? countPendingPluginItems(translationJson, payload.config.overwriteExistingTranslations) : 0;
            if (!translationJson || pendingCount === 0) {
                task.progress.skippedCount++;
            } else {
                try {
                    const result = await handlePluginTranslate({
                        resourceId: resource.resourceId,
                        resourceLabel: resource.label,
                        sourceId,
                        translationJson,
                        config: payload.config,
                    }, task);
                    await saveTranslatedSource(paths, sourceId, result.translationJson);
                    await replaceFailuresForSource(paths, 'plugin', sourceId, result.failures);
                    const processingState = getProcessingStateFromTranslationResult(result);
                    await updateSourceProcessingState(
                        paths,
                        sourceId,
                        processingState.processedTranslationCount,
                        processingState.unprocessedTranslationCount,
                        processingState.translationProcessingComplete,
                    );
                    task.progress.processedItems += result.processedItems;
                    if (result.failures.length === 0) {
                        task.progress.successCount++;
                    } else {
                        task.progress.failedCount++;
                    }
                    bumpSourceRevision(task);
                    bumpRecordRevision(task);
                } catch (error) {
                    const normalizedError = error instanceof Error ? error : new Error(String(error));
                    if (isManualStopError(normalizedError)) throw normalizedError;
                    task.progress.failedCount++;
                    console.error(`[i18n] Failed to batch translate plugin ${resource.resourceId}:`, error);
                }
            }
        }
        completedIndexes.add(index);
        task.progress.processedResources++;
        touchProgress(task);
        await saveCheckpoint(paths, payload.checkpointKey, createCheckpoint('plugin', 'translate', payload.resources, completedIndexes, task.progress));
        bumpRecordRevision(task);
    });

    if (task.cancelRequested) return;
    await clearCheckpoint(paths, payload.checkpointKey);
    bumpRecordRevision(task);
}

async function handleThemeBatchTranslate(task: CompanionTaskRuntime, payload: CompanionThemeBatchTranslatePayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const completedIndexes = new Set<number>();
    await runConcurrentCancellable(payload.resources, Math.max(1, payload.concurrency || 1), task, async (resource, index) => {
        if (!isTaskActive(task)) return;
        touchProgress(task, { currentLabel: resource.label });
        const sourceId = resource.sourceId;
        if (!sourceId) {
            task.progress.skippedCount++;
        } else {
            const translationJson = await readTranslationFile<ThemeTranslationV1>(paths, sourceId);
            const pendingCount = translationJson ? countPendingThemeItems(translationJson, payload.config.overwriteExistingTranslations) : 0;
            if (!translationJson || pendingCount === 0) {
                task.progress.skippedCount++;
            } else {
                try {
                    const result = await handleThemeTranslate({
                        resourceId: resource.resourceId,
                        resourceLabel: resource.label,
                        sourceId,
                        translationJson,
                        config: payload.config,
                    }, task);
                    await saveTranslatedSource(paths, sourceId, result.translationJson);
                    await replaceFailuresForSource(paths, 'theme', sourceId, result.failures);
                    const processingState = getProcessingStateFromTranslationResult(result);
                    await updateSourceProcessingState(
                        paths,
                        sourceId,
                        processingState.processedTranslationCount,
                        processingState.unprocessedTranslationCount,
                        processingState.translationProcessingComplete,
                    );
                    task.progress.processedItems += result.processedItems;
                    if (result.failures.length === 0) {
                        task.progress.successCount++;
                    } else {
                        task.progress.failedCount++;
                    }
                    bumpSourceRevision(task);
                    bumpRecordRevision(task);
                } catch (error) {
                    const normalizedError = error instanceof Error ? error : new Error(String(error));
                    if (isManualStopError(normalizedError)) throw normalizedError;
                    task.progress.failedCount++;
                    console.error(`[i18n] Failed to batch translate theme ${resource.resourceId}:`, error);
                }
            }
        }
        completedIndexes.add(index);
        task.progress.processedResources++;
        touchProgress(task);
        await saveCheckpoint(paths, payload.checkpointKey, createCheckpoint('theme', 'translate', payload.resources, completedIndexes, task.progress));
        bumpRecordRevision(task);
    });

    if (task.cancelRequested) return;
    await clearCheckpoint(paths, payload.checkpointKey);
    bumpRecordRevision(task);
}

async function handlePluginFailureRetry(task: CompanionTaskRuntime, payload: CompanionPluginFailureRetryPayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const record = await loadBatchTaskRecord(paths);
    const failuresForScope = record.failures.filter(failure => failure.scope === 'plugin');
    const groups = Array.from(failuresForScope.reduce((map, failure) => {
        const group = map.get(failure.sourceId) || [];
        group.push(failure);
        map.set(failure.sourceId, group);
        return map;
    }, new Map<string, BatchTaskFailureRecord[]>()).values());

    await runConcurrentCancellable(groups, Math.max(1, payload.concurrency || 1), task, async failures => {
        if (!isTaskActive(task)) return;
        const firstFailure = failures[0];
        touchProgress(task, { currentLabel: firstFailure.resourceLabel });
        const translationJson = await readTranslationFile<PluginTranslationV1>(paths, firstFailure.sourceId);
        if (!translationJson) {
            task.progress.skippedCount += failures.length;
            task.progress.processedResources += failures.length;
            touchProgress(task);
            return;
        }

        try {
            const result = await handlePluginRetry({
                resourceId: firstFailure.resourceId,
                resourceLabel: firstFailure.resourceLabel,
                sourceId: firstFailure.sourceId,
                failures,
                config: payload.config,
            }, task);
            for (const update of result.updates) {
                const dictItem = update.batchType === 'ast'
                    ? translationJson.dict[update.file]?.ast[update.dictIndex]
                    : translationJson.dict[update.file]?.regex[update.dictIndex];
                if (dictItem) dictItem.target = update.target;
            }
            await saveTranslatedSource(paths, firstFailure.sourceId, translationJson);
            await removeFailures(paths, result.completedFailureIds);
            task.progress.processedItems += result.processedItems;
            task.progress.successCount += result.completedFailureIds.length;
            task.progress.failedCount += result.failedFailureIds.length;
            task.progress.skippedCount += result.skippedFailureIds.length;
            bumpSourceRevision(task);
            bumpRecordRevision(task);
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (isManualStopError(normalizedError)) throw normalizedError;
            task.progress.failedCount += failures.length;
            console.error(`[i18n] Failed to retry plugin source ${firstFailure.sourceId}:`, error);
        }
        task.progress.processedResources += failures.length;
        touchProgress(task);
    });
}

async function handleThemeFailureRetry(task: CompanionTaskRuntime, payload: CompanionThemeFailureRetryPayload) {
    const paths = getPersistencePaths(payload.persistence.basePath);
    const record = await loadBatchTaskRecord(paths);
    const failuresForScope = record.failures.filter(failure => failure.scope === 'theme');
    const groups = Array.from(failuresForScope.reduce((map, failure) => {
        const group = map.get(failure.sourceId) || [];
        group.push(failure);
        map.set(failure.sourceId, group);
        return map;
    }, new Map<string, BatchTaskFailureRecord[]>()).values());

    await runConcurrentCancellable(groups, Math.max(1, payload.concurrency || 1), task, async failures => {
        if (!isTaskActive(task)) return;
        const firstFailure = failures[0];
        touchProgress(task, { currentLabel: firstFailure.resourceLabel });
        const translationJson = await readTranslationFile<ThemeTranslationV1>(paths, firstFailure.sourceId);
        if (!translationJson) {
            task.progress.skippedCount += failures.length;
            task.progress.processedResources += failures.length;
            touchProgress(task);
            return;
        }

        try {
            const result = await handleThemeRetry({
                resourceId: firstFailure.resourceId,
                resourceLabel: firstFailure.resourceLabel,
                sourceId: firstFailure.sourceId,
                failures,
                config: payload.config,
            }, task);
            for (const update of result.updates) {
                const dictItem = translationJson.dict[update.dictIndex];
                if (dictItem) dictItem.target = update.target;
            }
            await saveTranslatedSource(paths, firstFailure.sourceId, translationJson);
            await removeFailures(paths, result.completedFailureIds);
            task.progress.processedItems += result.processedItems;
            task.progress.successCount += result.completedFailureIds.length;
            task.progress.failedCount += result.failedFailureIds.length;
            task.progress.skippedCount += result.skippedFailureIds.length;
            bumpSourceRevision(task);
            bumpRecordRevision(task);
        } catch (error) {
            const normalizedError = error instanceof Error ? error : new Error(String(error));
            if (isManualStopError(normalizedError)) throw normalizedError;
            task.progress.failedCount += failures.length;
            console.error(`[i18n] Failed to retry theme source ${firstFailure.sourceId}:`, error);
        }
        task.progress.processedResources += failures.length;
        touchProgress(task);
    });
}

function createInitialProgress(type: CompanionAsyncTaskType, payload: any, taskId: string): CompanionTaskProgress {
    const now = Date.now();
    const isTheme = type.startsWith('theme');
    const isExtract = type.endsWith('extract');
    const isRetry = type.endsWith('retry');
    const resources = isRetry ? [] : (payload.resources || []);
    return {
        taskId,
        scope: isTheme ? 'theme' : 'plugin',
        mode: isExtract ? 'extract' : 'translate',
        status: 'queued',
        currentLabel: '',
        processedResources: Number(payload.completedResources || 0),
        totalResources: Number(payload.totalResources || resources.length),
        processedItems: Number(payload.processedItems || 0),
        totalItems: Number(payload.totalItems || 0),
        successCount: 0,
        failedCount: 0,
        skippedCount: 0,
        sourceRevision: 0,
        recordRevision: 0,
        updatedAt: now,
    };
}

async function runAsyncTask(task: CompanionTaskRuntime, type: CompanionAsyncTaskType, payload: any) {
    try {
        touchProgress(task, {
            status: 'running',
            processedResources: Number(payload.completedResources || task.progress.processedResources || 0),
            totalResources: Number(payload.totalResources || task.progress.totalResources || 0),
            processedItems: Number(payload.processedItems || task.progress.processedItems || 0),
            totalItems: Number(payload.totalItems || task.progress.totalItems || 0),
        });
        if (!cjsAsyncTaskTypes.has(type)) {
            throw new Error(`Rust companion worker owns task: ${type}`);
        }
        if (type === 'plugin-batch-extract') await handlePluginBatchExtract(task, payload);
        else if (type === 'theme-batch-extract') await handleThemeBatchExtract(task, payload);
        else throw new Error(`未知任务类型: ${type}`);

        touchProgress(task, {
            status: task.cancelRequested ? 'cancelled' : 'completed',
            currentLabel: '',
        });
    } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        touchProgress(task, {
            status: task.cancelRequested || isManualStopError(normalizedError) ? 'cancelled' : 'failed',
            currentLabel: '',
            error: normalizedError.message,
        });
    } finally {
        const cleanup = task.extractCleanup;
        task.extractCleanup = null;
        if (cleanup) await Promise.resolve(cleanup()).catch((error: unknown) => console.warn('[i18n] Failed to cleanup extract workers:', error));
    }
}

async function handleSourceRead(payload: CompanionSourceManagerRequest): Promise<CompanionSourceManagerResponse> {
    const paths = getPersistencePaths(payload.persistence.basePath);
    if (!payload.sourceId) throw new Error('缺少 sourceId');
    const source = await readTranslationFile(paths, payload.sourceId);
    if (!source) throw new Error('翻译文件不存在');
    return {
        state: true,
        source,
        addedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        deletedCount: 0,
    };
}

function startAsyncTask(type: CompanionAsyncTaskType, payload: any) {
    if (!cjsAsyncTaskTypes.has(type)) {
        throw new Error(`Rust companion worker owns task: ${type}`);
    }
    const taskId = nanoid(16);
    const task: CompanionTaskRuntime = {
        progress: createInitialProgress(type, payload, taskId),
        cancelRequested: false,
        promise: null,
        aiQueue: Promise.resolve(),
    };
    tasks.set(taskId, task);
    task.promise = runAsyncTask(task, type, payload).finally(() => {
        setTimeout(() => {
            const current = tasks.get(taskId);
            if (current === task && ['completed', 'cancelled', 'failed'].includes(task.progress.status)) {
                tasks.delete(taskId);
            }
        }, 5 * 60 * 1000).unref?.();
    });
    return task;
}

function getTask(taskId: string): CompanionTaskRuntime {
    const task = tasks.get(taskId);
    if (!task) throw new Error('任务不存在');
    return task;
}

async function handleTask(type: string, payload: any, options: { allowIsolation?: boolean } = {}) {
    if (rustOwnedTaskTypes.has(type)) {
        throw new Error(`Rust companion worker owns task: ${type}`);
    }
    if (!cjsSyncTaskTypes.has(type)) {
        throw new Error(`未知任务类型: ${type}`);
    }
    if (options.allowIsolation !== false && isolatedSyncTaskTypes.has(type)) {
        const raw = await runIsolatedStdioTaskRaw(JSON.stringify({ type, payload }));
        const envelope = JSON.parse(raw || '{}');
        if (!envelope?.ok) {
            throw new Error(envelope?.error || '隔离 CJS 任务失败');
        }
        return envelope.result;
    }
    if (type === 'plugin-extract') return handlePluginExtract(payload);
    if (type === 'theme-extract') return handleThemeExtract(payload);
    if (type === 'code-extract') return handleCodeExtract(payload);
    if (type === 'ast-replace') return handleAstReplace(payload);
    if (type === 'plugin-render-translation' || type === 'plugin-diagnose-render-probe') return handlePluginRenderTranslation(payload);
    if (type === 'plugin-apply-translation') return handlePluginApplyTranslation(payload);
    if (type === 'theme-apply-translation') return handleThemeApplyTranslation(payload);
    throw new Error(`未知任务类型: ${type}`);
}

function readStdin(): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        process.stdin.on('data', chunk => chunks.push(Buffer.from(chunk)));
        process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        process.stdin.on('error', reject);
    });
}

async function runStdioTask() {
    const logToStderr = (...args: any[]) => process.stderr.write(`${args.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ')}\n`);
    console.log = logToStderr;
    console.debug = logToStderr;
    console.warn = logToStderr;
    console.error = logToStderr;

    try {
        const body = await readStdin();
        const payload = JSON.parse(body || '{}');
        const result = await handleTask(payload.type, payload.payload, { allowIsolation: false });
        process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
}

if (process.argv[2] === 'stdio-task') {
    runStdioTask();
} else {
    const server = http.createServer(async (req, res) => {
        try {
            if (req.method === 'GET' && req.url === '/health') {
                send(res, 200, { ok: true });
                return;
            }

            if (req.method === 'GET' && req.url === '/identity') {
                send(res, 200, {
                    ok: true,
                    backend: 'cjs',
                    protocolVersion: companionWorkerProtocolVersion,
                    pluginDir: process.cwd(),
                });
                return;
            }

            if (req.method === 'POST' && req.url === '/shutdown') {
                send(res, 200, { ok: true });
                setTimeout(shutdown, 0);
                return;
            }

            if (req.method === 'POST' && req.url === '/proxy') {
                const body = await readBody(req);
                const payload = JSON.parse(body || '{}');
                const response = await proxy(payload);
                send(res, 200, { ok: true, response });
                return;
            }

            if (req.method === 'POST' && req.url === '/task/start') {
                const body = await readBody(req);
                const payload = JSON.parse(body || '{}');
                const task = startAsyncTask(payload.type, payload.payload);
                send(res, 200, { ok: true, taskId: task.progress.taskId, progress: task.progress });
                return;
            }

            if (req.method === 'GET' && req.url?.startsWith('/task/status')) {
                const target = new URL(req.url, `http://${host}:${port}`);
                const taskId = target.searchParams.get('id') || '';
                const task = getTask(taskId);
                send(res, 200, { ok: true, progress: task.progress });
                return;
            }

            if (req.method === 'POST' && req.url === '/task/cancel') {
                const body = await readBody(req);
                const payload = JSON.parse(body || '{}');
                const task = getTask(payload.taskId || '');
                void requestTaskCancel(task);
                send(res, 200, { ok: true, progress: task.progress });
                return;
            }

            if (req.method === 'POST' && req.url === '/task') {
                const body = await readBody(req);
                const rawTaskType = readTaskTypeFromRawBody(body);
                if (isolatedSyncTaskTypes.has(rawTaskType)) {
                    const raw = await runIsolatedStdioTaskRaw(body);
                    writeRawJson(res, 200, raw);
                    return;
                }
                const payload = JSON.parse(body || '{}');
                const result = await handleTask(payload.type, payload.payload);
                send(res, 200, { ok: true, result });
                return;
            }

            send(res, 404, { ok: false, error: 'not found' });
        } catch (error) {
            const status = error instanceof BodyLimitError ? 413 : 500;
            send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    });

    server.listen(port, host, () => {
        console.log(`ready ${host}:${port}`);
    });

    function shutdown() {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    }

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
}
