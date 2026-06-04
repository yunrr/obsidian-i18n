import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
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
