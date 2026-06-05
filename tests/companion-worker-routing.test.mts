import assert from 'node:assert/strict';
import test from 'node:test';

import { getCompanionWorkerTaskBackend } from '../src/manager/companion-worker-routing.ts';

test('file apply translation tasks are routed to the CJS worker', () => {
    assert.equal(getCompanionWorkerTaskBackend('plugin-apply-translation'), 'cjs');
    assert.equal(getCompanionWorkerTaskBackend('theme-apply-translation'), 'cjs');
});
