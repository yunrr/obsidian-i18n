import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getCompanionWorkerPort,
    normalizeCompanionWorkerBasePort,
} from '../src/manager/companion-worker-ports.ts';

test('normalizes worker base ports without forcing odd values', () => {
    assert.equal(normalizeCompanionWorkerBasePort(undefined), 18743);
    assert.equal(normalizeCompanionWorkerBasePort(18743), 18743);
    assert.equal(normalizeCompanionWorkerBasePort(18744), 18744);
    assert.equal(normalizeCompanionWorkerBasePort(0), 1);
    assert.equal(normalizeCompanionWorkerBasePort(65534), 65534);
    assert.equal(normalizeCompanionWorkerBasePort(65535), 65534);
});

test('uses one fixed rust port and the next port for CJS', () => {
    assert.equal(getCompanionWorkerPort(18743, 'rust'), 18743);
    assert.equal(getCompanionWorkerPort(18743, 'cjs'), 18744);
    assert.equal(getCompanionWorkerPort(18744, 'rust'), 18744);
    assert.equal(getCompanionWorkerPort(18744, 'cjs'), 18745);
});
