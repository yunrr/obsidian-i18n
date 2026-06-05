import assert from 'node:assert/strict';
import test from 'node:test';

import { extractRegexTranslations } from '../src/utils/translator/regex-extractor.ts';

test('extracts regex translations in pattern order with dedupe and validation caching', () => {
    const patterns = [
        /label:\s*"[^"]*"/g,
        /title:\s*"[^"]*"/g,
        /label:\s*"[^"]*"/g,
    ];
    const validationCalls = new Map<string, number>();
    const isValidText = (text: string) => {
        validationCalls.set(text, (validationCalls.get(text) || 0) + 1);
        return !text.includes('Skip');
    };

    const translations = extractRegexTranslations(
        'label: "Keep"; title: "Title"; label: "Keep"; label: "Skip"; label: "Skip";',
        patterns,
        isValidText,
    );

    assert.deepEqual(translations, [
        { source: 'label: "Keep"', target: 'label: "Keep"' },
        { source: 'title: "Title"', target: 'title: "Title"' },
    ]);
    assert.equal(validationCalls.get('label: "Keep"'), 1);
    assert.equal(validationCalls.get('label: "Skip"'), 1);
});

test('handles zero-length regex matches without looping forever', () => {
    const translations = extractRegexTranslations('abc', [/()/g], () => false);

    assert.deepEqual(translations, []);
});

test('keeps legacy capture-group candidates for non-global regex patterns', () => {
    const translations = extractRegexTranslations(
        'label: "Captured"',
        [/label:\s*"([^"]*)"/],
        text => text.length > 0,
    );

    assert.deepEqual(translations, [
        { source: 'label: "Captured"', target: 'label: "Captured"' },
        { source: 'Captured', target: 'Captured' },
    ]);
});

test('streams large regex extraction results without changing accepted output', () => {
    const count = 20_000;
    const code = Array.from({ length: count }, (_, index) => `text: "Entry ${index}"`).join('\n');
    const startedAt = Date.now();
    const translations = extractRegexTranslations(code, [/text:\s*"[^"]*"/g], text => text.includes('Entry'));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(translations.length, count);
    assert.equal(translations[0].source, 'text: "Entry 0"');
    assert.equal(translations[count - 1].source, `text: "Entry ${count - 1}"`);
    assert.ok(elapsedMs < 1_000, `regex extraction took ${elapsedMs}ms`);
});
