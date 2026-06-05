import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';

const workerPath = path.resolve('i18n-companion-worker.cjs');

const getFreePort = async (): Promise<number> => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (!address || typeof address === 'string') throw new Error('failed to allocate test port');
    return address.port;
};

const request = async (port: number, pathName: string, method: string, body = ''): Promise<{ status: number; text: string }> => {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port,
            path: pathName,
            method,
            headers: body ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            } : undefined,
        }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', chunk => {
                text += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode || 0, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
};

const waitForReady = async (worker: ReturnType<typeof spawn>, port: number) => {
    let stderr = '';
    worker.stderr?.setEncoding('utf8');
    worker.stderr?.on('data', chunk => {
        stderr += chunk;
    });
    const startedAt = Date.now();
    while (true) {
        try {
            const response = await request(port, '/identity', 'GET');
            if (response.status === 200) return;
        } catch {
            // keep polling until the worker opens the port
        }
        if (worker.exitCode !== null) {
            throw new Error(`worker exited before ready, stderr: ${stderr}`);
        }
        if (Date.now() - startedAt > 5_000) {
            throw new Error(`worker did not become ready, stderr: ${stderr}`);
        }
        await new Promise(resolve => setTimeout(resolve, 25));
    }
};

const postJson = async (port: number, body: string): Promise<{ status: number; text: string }> => {
    return request(port, '/task', 'POST', body);
};

test('CJS worker returns a JSON 413 response when request body exceeds the configured limit', async () => {
    const port = await getFreePort();
    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        env: {
            ...process.env,
            I18N_COMPANION_MAX_BODY_BYTES: '1024',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        const body = JSON.stringify({ type: '__body_limit_test__', payload: { data: 'x'.repeat(2048) } });
        const response = await postJson(port, body);

        assert.equal(response.status, 413);
        const payload = JSON.parse(response.text);
        assert.equal(payload.ok, false);
        assert.match(payload.error, /请求体过大/);
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
    }
});

test('CJS worker rejects workflow and persistence tasks owned by Rust', async () => {
    const port = await getFreePort();
    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        for (const taskType of ['source-read', 'plugin-translate', 'theme-retry']) {
            const response = await postJson(port, JSON.stringify({
                type: taskType,
                payload: {
                    persistence: { basePath: path.join(os.tmpdir(), 'i18n-cjs-boundary') },
                },
            }));

            assert.equal(response.status, 500, taskType);
            const payload = JSON.parse(response.text);
            assert.equal(payload.ok, false, taskType);
            assert.match(payload.error, /Rust companion worker owns task/, taskType);
        }
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
    }
});

test('CJS worker rejects async workflow tasks owned by Rust', async () => {
    const port = await getFreePort();
    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        for (const taskType of ['plugin-batch-translate', 'theme-failure-retry', 'cloud-backup-all']) {
            const response = await request(port, '/task/start', 'POST', JSON.stringify({
                type: taskType,
                payload: {
                    resources: [],
                    persistence: { basePath: path.join(os.tmpdir(), 'i18n-cjs-boundary') },
                },
            }));

            assert.equal(response.status, 500, taskType);
            const payload = JSON.parse(response.text);
            assert.equal(payload.ok, false, taskType);
            assert.match(payload.error, /Rust companion worker owns task/, taskType);
        }
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
    }
});

test('CJS worker renders plugin translation code without owning apply file writes', async () => {
    const port = await getFreePort();
    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        const body = JSON.stringify({
            type: 'plugin-render-translation',
            payload: {
                files: [
                    {
                        file: 'main.js',
                        code: 'const title = "Hello"; // keep this comment\nconsole.log("World");',
                    },
                ],
                candidates: [
                    {
                        file: 'main.js',
                        kind: 'ast',
                        index: 0,
                        item: { type: 'VariableDeclarator', name: 'title', source: 'Hello', target: '你好' },
                    },
                    {
                        file: 'main.js',
                        kind: 'regex',
                        index: 0,
                        item: { source: 'World', target: '世界' },
                    },
                ],
            },
        });
        const response = await postJson(port, body);

        assert.equal(response.status, 200);
        const payload = JSON.parse(response.text);
        assert.equal(payload.ok, true);
        assert.equal(payload.result.state, true);
        assert.equal(payload.result.files.length, 1);
        assert.match(payload.result.files[0].code, /你好/);
        assert.match(payload.result.files[0].code, /世界/);
        assert.match(payload.result.files[0].code, /keep this comment/);
        assert.match(payload.result.files[0].code, /\nconsole\.log/);
        assert.equal(payload.result.files[0].file, 'main.js');
        assert.equal(payload.result.processedFiles, undefined);
        assert.equal(payload.result.diagnostics.totalCandidates, 2);
        assert.equal(payload.result.diagnostics.astCandidates, 1);
        assert.equal(payload.result.diagnostics.regexCandidates, 1);
        assert.equal(payload.result.diagnostics.files.length, 1);
        assert.equal(payload.result.diagnostics.files[0].file, 'main.js');
        assert.equal(payload.result.diagnostics.files[0].astCandidates, 1);
        assert.equal(payload.result.diagnostics.files[0].regexCandidates, 1);
        assert.equal(typeof payload.result.diagnostics.files[0].regexReplaceMs, 'number');
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
    }
});

test('CJS worker applies plugin translation with the legacy file write flow', async () => {
    const port = await getFreePort();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-cjs-apply-'));
    const pluginDir = path.join(tempDir, 'plugin');
    const backupBasePath = path.join(tempDir, 'plugin-data');
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, 'main.js'), 'const title = "Hello"; console.log("World");');

    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        const body = JSON.stringify({
            type: 'plugin-apply-translation',
            payload: {
                pluginId: 'plugin-a',
                pluginDir,
                backupBasePath,
                translationJson: {
                    schemaVersion: 1,
                    metadata: {
                        plugin: 'plugin-a',
                        title: 'Plugin A',
                        version: '2.0.0',
                    },
                    dict: {
                        'main.js': {
                            ast: [
                                { type: 'VariableDeclarator', name: 'title', source: 'Hello', target: '你好' },
                            ],
                            regex: [
                                { source: 'World', target: '世界' },
                            ],
                        },
                    },
                },
                applyAst: true,
                applyRegex: true,
            },
        });
        const response = await postJson(port, body);

        assert.equal(response.status, 200);
        const payload = JSON.parse(response.text);
        assert.equal(payload.ok, true);
        assert.equal(payload.result.state, true);
        assert.equal(payload.result.processedFiles, 1);
        assert.equal(payload.result.translationVersion, '2.0.0');
        const translated = await fs.readFile(path.join(pluginDir, 'main.js'), 'utf8');
        assert.match(translated, /你好/);
        assert.match(translated, /世界/);
        await fs.access(path.join(backupBasePath, 'backups', 'plugin-a', 'main.js.gz'));
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});

test('CJS worker applies theme translation with the legacy file write flow', async () => {
    const port = await getFreePort();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'i18n-cjs-theme-apply-'));
    const themeDir = path.join(tempDir, 'theme');
    const backupBasePath = path.join(tempDir, 'plugin-data');
    const themeCssPath = path.join(themeDir, 'theme.css');
    await fs.mkdir(themeDir, { recursive: true });
    await fs.writeFile(themeCssPath, '/* @settings\nname: Accent\nlabel: Accent color\n*/\nbody { color: red; }');

    const worker = spawn(process.execPath, [workerPath, String(port)], {
        cwd: path.resolve('.'),
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
        await waitForReady(worker, port);
        const body = JSON.stringify({
            type: 'theme-apply-translation',
            payload: {
                themeId: 'theme-a',
                themeDir,
                themeCssPath,
                themeCssRelativePath: 'theme.css',
                backupBasePath,
                translationJson: {
                    schemaVersion: 1,
                    metadata: {
                        plugin: 'theme-a',
                        title: 'Theme A',
                        version: '3.0.0',
                    },
                    dict: [
                        { source: 'Accent color', target: '强调色' },
                    ],
                },
            },
        });
        const response = await postJson(port, body);

        assert.equal(response.status, 200);
        const payload = JSON.parse(response.text);
        assert.equal(payload.ok, true);
        assert.equal(payload.result.state, true);
        assert.equal(payload.result.processedFiles, 1);
        assert.equal(payload.result.translationVersion, '3.0.0');
        const translated = await fs.readFile(themeCssPath, 'utf8');
        assert.match(translated, /强调色/);
        assert.match(translated, /body \{ color: red; \}/);
        await fs.access(path.join(backupBasePath, 'backups', 'theme-a', 'theme.css.gz'));
    } finally {
        worker.kill();
        await Promise.race([
            once(worker, 'exit'),
            new Promise(resolve => setTimeout(resolve, 1_000)),
        ]);
        await fs.rm(tempDir, { recursive: true, force: true });
    }
});
