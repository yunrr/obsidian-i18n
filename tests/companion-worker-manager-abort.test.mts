import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('task abort does not stop the whole companion backend', async () => {
    const source = await readFile('src/manager/companion-worker-manager.ts', 'utf8');
    const abortHandlerMatch = source.match(/const abortHandler = \(\) => \{([\s\S]*?)\n            \};/);

    assert.ok(abortHandlerMatch, 'runTask abort handler should be easy to inspect');
    assert.equal(
        abortHandlerMatch[1].includes('stopBackend'),
        false,
        'aborting one task request must not kill the companion backend; cleanup is handled by task-specific cancel flows',
    );
});
