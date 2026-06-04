import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
    classifyCompanionWorkerIdentity,
    COMPANION_WORKER_PROTOCOL_VERSION,
} from '../src/manager/companion-worker-identity.ts';

const pluginDir = path.resolve('test-vault/.obsidian/plugins/i18n');

test('treats a matching plugin directory with the current protocol and backend as the same worker', () => {
    assert.equal(
        classifyCompanionWorkerIdentity(
            {
                ok: true,
                pluginDir,
                backend: 'rust',
                protocolVersion: COMPANION_WORKER_PROTOCOL_VERSION,
            },
            pluginDir,
            'rust',
        ),
        'same',
    );
});

test('treats an old worker in the same plugin directory as stale instead of reusable', () => {
    assert.equal(
        classifyCompanionWorkerIdentity(
            {
                ok: true,
                pluginDir,
            },
            pluginDir,
            'rust',
        ),
        'stale',
    );
});

test('treats a same-directory worker for the wrong backend as stale', () => {
    assert.equal(
        classifyCompanionWorkerIdentity(
            {
                ok: true,
                pluginDir,
                backend: 'cjs',
                protocolVersion: COMPANION_WORKER_PROTOCOL_VERSION,
            },
            pluginDir,
            'rust',
        ),
        'stale',
    );
});

test('treats another plugin directory as another worker even if protocol matches', () => {
    assert.equal(
        classifyCompanionWorkerIdentity(
            {
                ok: true,
                pluginDir: path.resolve('other-vault/.obsidian/plugins/i18n'),
                backend: 'rust',
                protocolVersion: COMPANION_WORKER_PROTOCOL_VERSION,
            },
            pluginDir,
            'rust',
        ),
        'other',
    );
});
