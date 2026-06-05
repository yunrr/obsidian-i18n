import assert from 'node:assert/strict';
import test from 'node:test';

import { getBatchTranslationVersionOptions } from '../src/views/manager/batch-version-options.ts';

test('batch version options include current default version before indexed versions', () => {
    assert.deepEqual(
        getBatchTranslationVersionOptions(['1.0.1', '1.0.0'], '2.0.0'),
        ['2.0.0', '1.0.1', '1.0.0'],
    );
});

test('batch version options do not duplicate current default version', () => {
    assert.deepEqual(
        getBatchTranslationVersionOptions(['2.0.0', '1.0.1'], '2.0.0'),
        ['2.0.0', '1.0.1'],
    );
});
