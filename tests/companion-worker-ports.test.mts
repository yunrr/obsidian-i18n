import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getCompanionWorkerPortCandidates,
} from '../src/manager/companion-worker-ports.ts';

test('allocates rust and CJS worker candidates in paired odd/even slots', () => {
    assert.deepEqual(getCompanionWorkerPortCandidates(18743, 'rust', 4), [
        18743,
        18745,
        18747,
        18749,
    ]);
    assert.deepEqual(getCompanionWorkerPortCandidates(18743, 'cjs', 4), [
        18744,
        18746,
        18748,
        18750,
    ]);
});

test('does not wrap worker port candidates past the TCP port range', () => {
    assert.deepEqual(getCompanionWorkerPortCandidates(65534, 'rust', 4), [65534]);
    assert.deepEqual(getCompanionWorkerPortCandidates(65534, 'cjs', 4), [65535]);
});
