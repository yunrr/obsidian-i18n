import assert from 'node:assert/strict';
import test from 'node:test';

import { chooseTranslationResponseContent, normalizeStreamingResponseText } from '../src/manager/streaming-response-normalizer.ts';
import { parseTranslationResponse } from '../src/utils/ai/response-parser.ts';

const streamEvent = (delta: Record<string, unknown>, finishReason: string | null = null) => {
    return `data: ${JSON.stringify({
        id: 'stream-test',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
};

test('stream normalizer recovers translation JSON continued in reasoning_content', () => {
    const stream = [
        streamEvent({ content: '[{"i":0,"t":"空"},{"i":1,"t":"从助手输出中移除 ' }),
        streamEvent({ reasoning_content: '、<reasoning> 和 <thought> 块。"},{"i":2,"t":"完成"}]' }, 'stop'),
        'data: [DONE]\n\n',
    ].join('');

    const normalized = JSON.parse(normalizeStreamingResponseText(stream));
    const content = normalized.choices[0].message.content;
    const parsed = parseTranslationResponse(content);

    assert.deepEqual(parsed, [
        { i: 0, t: '空' },
        { i: 1, t: '从助手输出中移除 、<reasoning> 和 <thought> 块。' },
        { i: 2, t: '完成' },
    ]);
});

test('translation content chooser keeps normal content unless recovered text parses more items', () => {
    const content = '[{"i":0,"t":"空"},{"i":1,"t":"从助手输出中移除 ';
    const recovered = '[{"i":0,"t":"空"},{"i":1,"t":"从助手输出中移除 、<reasoning> 和 <thought> 块。"},{"i":2,"t":"完成"}]';

    assert.equal(chooseTranslationResponseContent(content, recovered), recovered);
    assert.equal(chooseTranslationResponseContent(recovered, `${recovered}普通思考文本`), recovered);
});
