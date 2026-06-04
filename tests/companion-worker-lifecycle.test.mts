import assert from 'node:assert/strict';
import test from 'node:test';

import {
    waitForWorkerReadyOrExit,
} from '../src/manager/companion-worker-lifecycle.ts';

test('stops waiting when a spawned worker exits before the ready timeout', async () => {
    const startedAt = Date.now();
    let polls = 0;

    const result = await waitForWorkerReadyOrExit({
        timeoutMs: 1000,
        pollIntervalMs: 100,
        isReady: async () => {
            polls++;
            return false;
        },
        waitForExit: () => new Promise(resolve => setTimeout(resolve, 20)),
    });

    assert.equal(result, 'exited');
    assert.ok(polls >= 1);
    assert.ok(Date.now() - startedAt < 300);
});

test('does not wait for a slow readiness probe after the worker exits', async () => {
    const startedAt = Date.now();

    const result = await waitForWorkerReadyOrExit({
        timeoutMs: 1000,
        pollIntervalMs: 100,
        isReady: async () => {
            await new Promise(resolve => setTimeout(resolve, 800));
            return false;
        },
        waitForExit: () => new Promise(resolve => setTimeout(resolve, 20)),
    });

    assert.equal(result, 'exited');
    assert.ok(Date.now() - startedAt < 300);
});
