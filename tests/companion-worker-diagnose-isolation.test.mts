import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('diagnose render probes run outside the long-lived CJS HTTP process', async () => {
    const source = await readFile('src/manager/companion-worker.ts', 'utf8');

    assert.match(
        source,
        /isolatedSyncTaskTypes[\s\S]*plugin-diagnose-render-probe/,
        'runtime preflight probe rendering should be registered as an isolated sync task',
    );
    assert.match(
        source,
        /runIsolatedStdioTaskRaw/,
        'isolated sync tasks should be executed through a short-lived stdio worker',
    );
    assert.match(
        source,
        /handleTask\(payload\.type,\s*payload\.payload,\s*\{\s*allowIsolation:\s*false\s*\}/,
        'the stdio worker must execute the task directly instead of recursively spawning another worker',
    );
});
