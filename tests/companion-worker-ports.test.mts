import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getCompanionWorkerPort,
    normalizeCompanionWorkerBasePort,
} from '../src/manager/companion-worker-ports.ts';

test('normalizes worker base ports to valid odd rust ports', () => {
    assert.equal(normalizeCompanionWorkerBasePort(undefined), 18743);
    assert.equal(normalizeCompanionWorkerBasePort(18743), 18743);
    assert.equal(normalizeCompanionWorkerBasePort(18744), 18745);
    assert.equal(normalizeCompanionWorkerBasePort(0), 1);
    assert.equal(normalizeCompanionWorkerBasePort(65534), 65533);
    assert.equal(normalizeCompanionWorkerBasePort(65535), 65533);
});

test('uses one fixed rust port and the next port for CJS', () => {
    assert.equal(getCompanionWorkerPort(18743, 'rust'), 18743);
    assert.equal(getCompanionWorkerPort(18743, 'cjs'), 18744);
    assert.equal(getCompanionWorkerPort(18744, 'rust'), 18745);
    assert.equal(getCompanionWorkerPort(18744, 'cjs'), 18746);
});
