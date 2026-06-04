import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTranslationResponse } from '../src/utils/ai/response-parser.ts';

test('reads malformed t field as raw text after JSON parse fails', () => {
    const items = parseTranslationResponse('{"items":[{"i":350,"t":""text:sdjifsjk"}]}');

    assert.deepEqual(items, [{ i: 350, t: '"text:sdjifsjk' }]);
});

test('raw fallback does not unescape recovered t text', () => {
    const items = parseTranslationResponse('{"items":[{"i":350,"t":"line\\nraw"broken"}]}');

    assert.deepEqual(items, [{ i: 350, t: 'line\\nraw"broken' }]);
});
