import assert from 'node:assert/strict';
import test from 'node:test';

import { replaceLiteralTranslations } from '../src/utils/translator/literal-replacer.ts';

test('replaces many literal translations without repeatedly scanning the whole file', () => {
    const itemCount = 5_000;
    const repeatCount = 70_000;
    const code = Array.from({ length: repeatCount }, (_, index) => `key_${index % itemCount}_value`).join('|');
    const translations = Array.from({ length: itemCount }, (_, index) => ({
        source: `key_${index}_value`,
        target: `translated_${index}`,
    }));

    const startedAt = Date.now();
    const translated = replaceLiteralTranslations(code, translations);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(translated.includes('key_4999_value'), false);
    assert.equal(translated.includes('translated_4999'), true);
    assert.ok(elapsedMs < 1_500, `literal replacement took ${elapsedMs}ms`);
});

test('keeps legacy skip and duplicate source behavior for literal replacements', () => {
    const translated = replaceLiteralTranslations('A B C A', [
        { source: 'A', target: '' },
        { source: 'B', target: 'B' },
        { source: 'C', target: 'cee' },
        { source: 'C', target: 'later' },
        { source: 'A', target: 'aye' },
    ]);

    assert.equal(translated, 'aye B cee aye');
});

test('falls back to legacy sequential behavior when targets can cascade into later sources', () => {
    const translated = replaceLiteralTranslations('A B', [
        { source: 'A', target: 'B' },
        { source: 'B', target: 'C' },
    ]);

    assert.equal(translated, 'C C');
});
