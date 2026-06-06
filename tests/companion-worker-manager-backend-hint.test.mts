import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCompanionTaskBackend } from '../src/manager/companion-task-backend.ts';

test('task status routing uses the caller backend hint when task mapping is unavailable', () => {
    const taskBackends = new Map<string, 'rust' | 'cjs'>();

    assert.equal(resolveCompanionTaskBackend(taskBackends, 'lost-cjs-task', 'cjs'), 'cjs');
    assert.equal(resolveCompanionTaskBackend(taskBackends, 'lost-rust-task', 'rust'), 'rust');
    assert.equal(resolveCompanionTaskBackend(taskBackends, 'unknown-task'), 'rust');
});

test('task status routing keeps the recorded task backend ahead of a stale caller hint', () => {
    const taskBackends = new Map<string, 'rust' | 'cjs'>([
        ['known-cjs-task', 'cjs'],
        ['known-rust-task', 'rust'],
    ]);

    assert.equal(resolveCompanionTaskBackend(taskBackends, 'known-cjs-task', 'rust'), 'cjs');
    assert.equal(resolveCompanionTaskBackend(taskBackends, 'known-rust-task', 'cjs'), 'rust');
});
