import assert from 'node:assert/strict';
import test from 'node:test';

import { applySourceEdits } from '../src/utils/translator/source-edits.ts';

test('applies many source edits without rewriting untouched code', () => {
    const count = 10_000;
    const lines: string[] = [];
    const edits: Array<{ start: number; end: number; replacement: string }> = [];
    let offset = 0;

    for (let index = 0; index < count; index++) {
        const literal = JSON.stringify(`Source text ${index}`);
        const line = `const title_${index} = ${literal}; // keep comment ${index}\n`;
        const start = offset + line.indexOf(literal);
        const end = start + literal.length;
        edits.push({ start, end, replacement: JSON.stringify(`Translated text ${index}`) });
        lines.push(line);
        offset += line.length;
    }

    const code = lines.join('');
    const startedAt = Date.now();
    const translated = applySourceEdits(code, edits);
    const elapsedMs = Date.now() - startedAt;

    assert.equal(translated.includes('Source text 9999'), false);
    assert.equal(translated.includes('Translated text 9999'), true);
    assert.equal(translated.includes('// keep comment 9999'), true);
    assert.ok(elapsedMs < 200, `source edits took ${elapsedMs}ms`);
});

test('rejects overlapping source edits', () => {
    assert.throws(
        () => applySourceEdits('abcdef', [
            { start: 1, end: 4, replacement: 'X' },
            { start: 3, end: 5, replacement: 'Y' },
        ]),
        /overlap/,
    );
});
