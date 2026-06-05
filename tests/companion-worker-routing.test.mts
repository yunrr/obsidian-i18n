import assert from 'node:assert/strict';
import test from 'node:test';

import { getCompanionWorkerTaskBackend } from '../src/manager/companion-worker-routing.ts';

test('extraction and replacement tasks are routed to the CJS worker', () => {
    for (const taskType of [
        'plugin-extract',
        'theme-extract',
        'plugin-batch-extract',
        'theme-batch-extract',
        'code-extract',
        'ast-replace',
        'plugin-render-translation',
        'plugin-diagnose-render-probe',
        'plugin-apply-translation',
        'theme-apply-translation',
    ] as const) {
        assert.equal(getCompanionWorkerTaskBackend(taskType), 'cjs', taskType);
    }
});

test('workflow, state, translation, retry, source, and cloud tasks are routed to the Rust worker', () => {
    for (const taskType of [
        'plugin-translate',
        'theme-translate',
        'plugin-retry',
        'theme-retry',
        'plugin-batch-translate',
        'theme-batch-translate',
        'plugin-failure-retry',
        'theme-failure-retry',
        'plugin-diagnose-cleanup-start',
        'plugin-diagnose-cleanup-step',
        'plugin-diagnose-cleanup-cancel',
        'plugin-diagnose-cleanup-apply',
        'source-read',
        'source-export',
        'source-import',
        'source-remove',
        'source-set-active',
        'source-index',
        'source-clear-batch-records',
        'cloud-publish-source',
        'cloud-download-source',
        'cloud-update-sources',
        'cloud-prepare-backup',
        'cloud-restore-all',
        'cloud-backup-all',
    ] as const) {
        assert.equal(getCompanionWorkerTaskBackend(taskType), 'rust', taskType);
    }
});
