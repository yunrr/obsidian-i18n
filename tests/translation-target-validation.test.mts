import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('translation validation does not reject the literal Chinese word for Empty', async () => {
    const sources = await Promise.all([
        readFile('src/ai/base-provider.ts', 'utf8'),
        readFile('src/manager/companion-worker.ts', 'utf8'),
    ]);

    for (const source of sources) {
        assert.equal(source.includes("trim() === '空'"), false);
        assert.equal(source.includes('trim() === "空"'), false);
    }
});
