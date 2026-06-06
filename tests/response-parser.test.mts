import assert from 'node:assert/strict';
import test from 'node:test';

import { parseTranslationResponse } from '../src/utils/ai/response-parser.ts';

const fullThemeRetrySample = `[{"i":0,"t":"选择您的调色板"},{"i":1,"t":"默认"},{"i":2,"t":"百合"},{"i":3,"t":"象牙白"},{"i":4,"t":"天空蓝"},{"i":5,"t":"石板灰"},{"i":6,"t":"深色主题"},{"i":7,"t":"暖色"},{"i":8,"t":"丁香紫"},{"i":9,"t":"纯净"},{"i":10,"t":"启用强调色样式"},{"i":11,"t":"使用下方的强调色调整主题风格"},{"i":12,"t":"强调色"},{"i":13,"t":"与高亮颜色兼容"},{"i":14,"t":"红色"},{"i":15,"t":"玫瑰红"},{"i":16,"t":"紫罗兰"},{"i":17,"t":"蓝色"},{"i":18,"t":"海蓝"},{"i":19,"t":"青色"},{"i":20,"t":"绿松石"},{"i":21,"t":"绿色"},{"i":22,"t":"黄色"},{"i":23,"t":"柠檬黄"},{"i":24,"t":"橙色"},{"i":25,"t":"自定义调色板"},{"i":26,"t":"自定义您专属的调色板！"},{"i":27,"t":"主背景色"},{"i":28,"t":"基础色；用于 Markdown、垂直标签页内容及活动标签页。"},{"i":29,"t":"主背景色（备用）"},{"i":30,"t":"次背景色"},{"i":31,"t":"侧边色；用于布局、垂直标签页标题及非活动标签页。"},{"i":32,"t":"次背景色（备用）"},{"i":33,"t":"背景修饰边框色"},{"i":34,"t":"表面色；用于滚动条和边框。"},{"i":35,"t":"自定义强调色"},{"i":36,"t":"自定义您专属的强调色！"},{"i":37,"t":"强调色"},{"i":38,"t":"更改强调色的颜色。"},{"i":39,"t":"编辑器"},{"i":40,"t":"个性化笔记中标题、文本、引用块、标注及其他元素的外观。"},{"i":41,"t":"字体"},{"i":42,"t":"字体的特性、样式和选项。"},{"i":43,"t":"字体族"},{"i":44,"t":"文本字体"},{"i":45,"t":"主要字体不应用于代码文本。"},{"i":46,"t":"垂直栏（设置）"},{"i":47,"t":"文件夹与文件标题"},{"i":48,"t":"代码框"},{"i":49,"t":"codebox"},{"i":50,"t":"行内代码"},{"i":51,"t":"inline"},{"i":52,"t":"标签"},{"i":53,"t":"仓库名称"},{"i":54,"t":"字体大小"},{"i":55,"t":"文件夹与文件"},{"i":56,"t":"文件标题"},{"i":57,"t":"不适用于 Sliding Pane 插件。"},{"i":58,"t":"代码块"},{"i":59,"t":"标题"},{"i":60,"t":"标题的特性、颜色和字体。"},{"i":61,"t":"启用自定义标题颜色"},{"i":62,"t":"启用简洁标题"},{"i":63,"t":"编辑时显示格式标记，若非活动行则替换为灰色的 "H1"、"H2" 等。"},{"i":64,"t":"禁用 H1-H6 指示器"},{"i":65,"t":"鼠标悬停时移除标题前的 H1-H6 指示器。"},{"i":66,"t":"H1 设置"},{"i":67,"t":"H1 Shiba 字体"},{"i":68,"t":"H1 自定义字体"},{"i":69,"t":"H1 大小 (em)"},{"i":70,"t":"H1 字重"},{"i":71,"t":"H1 行高"},{"i":72,"t":"H1 颜色"},{"i":73,"t":"自定义 H1 颜色"},{"i":74,"t":"H1 下划线"},{"i":75,"t":"您必须启用自定义标题颜色，或者如果禁用，则需选择自定义颜色才能生效。"},{"i":76,"t":"H2 设置"},{"i":77,"t":"H2 Shiba 字体"},{"i":78,"t":"H2 自定义字体"},{"i":79,"t":"H2 大小 (em)"},{"i":80,"t":"H2 字重"},{"i":81,"t":"H2 行高"},{"i":82,"t":"H2 颜色"},{"i":83,"t":"自定义 H2 颜色"},{"i":84,"t":"H2 下划线"},{"i":85,"t":"H3 设置"},{"i":86,"t":"H3 Shiba 字体"},{"i":87,"t":"H3 自定义字体"},{"i":88,"t":"H3 大小 (em)"},{"i":89,"t":"H3 字重"},{"i":90,"t":"H3 行高"},{"i":91,"t":"H3 颜色"},{"i":92,"t":"自定义 H3 颜色"},{"i":93,"t":"H3 下划线"},{"i":94,"t":"H4 设置"},{"i":95,"t":"H4 Shiba 字体"},{"i":96,"t":"H4 自定义字体"},{"i":97,"t":"H4 大小 (em)"},{"i":98,"t":"H4 字重"},{"i":99,"t":"H4 行高"}]`;

test('reads malformed t field as raw text after JSON parse fails', () => {
    const items = parseTranslationResponse('{"items":[{"i":350,"t":""text:sdjifsjk"}]}');

    assert.deepEqual(items, [{ i: 350, t: '"text:sdjifsjk' }]);
});

test('raw fallback does not unescape recovered t text', () => {
    const items = parseTranslationResponse('{"items":[{"i":350,"t":"line\\nraw"broken"}]}');

    assert.deepEqual(items, [{ i: 350, t: 'line\\nraw"broken' }]);
});

test('raw parser uses the next increasing i marker as the entry boundary', () => {
    const items = parseTranslationResponse('[{"i":0,"t":"保留 "} 片段和 "H1""},{"i":1,"t":"第二条"}]');

    assert.deepEqual(items, [
        { i: 0, t: '保留 "} 片段和 "H1"' },
        { i: 1, t: '第二条' },
    ]);
});

test('raw parser does not unescape valid JSON t text', () => {
    const items = parseTranslationResponse('{"items":[{"i":0,"t":"line\\nraw \\"quote\\""}]}');

    assert.deepEqual(items, [{ i: 0, t: 'line\\nraw \\"quote\\"' }]);
});

test('raw parser reads theme translations with unescaped quoted heading markers', () => {
    const items = parseTranslationResponse('[{"i":62,"t":"启用简洁标题"},{"i":63,"t":"编辑时显示格式标记，若非活动行则替换为灰色的 "H1"、"H2" 等。"},{"i":64,"t":"禁用 H1-H6 指示器"}]');

    assert.deepEqual(items, [
        { i: 62, t: '启用简洁标题' },
        { i: 63, t: '编辑时显示格式标记，若非活动行则替换为灰色的 "H1"、"H2" 等。' },
        { i: 64, t: '禁用 H1-H6 指示器' },
    ]);
});

test('raw parser reads the full theme retry response with unescaped heading quotes', () => {
    const items = parseTranslationResponse(fullThemeRetrySample);

    assert.equal(items.length, 100);
    assert.deepEqual(items[0], { i: 0, t: '选择您的调色板' });
    assert.deepEqual(items[63], { i: 63, t: '编辑时显示格式标记，若非活动行则替换为灰色的 "H1"、"H2" 等。' });
    assert.deepEqual(items[99], { i: 99, t: 'H4 行高' });
});

test('raw parser keeps inline markdown code fences inside translation text', () => {
    const items = parseTranslationResponse('[{"i":50,"t":"Codebox"},{"i":51,"t":"```codebox```"},{"i":52,"t":"Inline Code"}]');

    assert.deepEqual(items, [
        { i: 50, t: 'Codebox' },
        { i: 51, t: '```codebox```' },
        { i: 52, t: 'Inline Code' },
    ]);
});

test('raw parser prefers the smallest increasing i boundary when text contains a later fake marker', () => {
    const items = parseTranslationResponse('[{"i":0,"t":"包含假边界 "}, {"i":99,"t":"只是文本"},{"i":1,"t":"真实下一条"}]');

    assert.deepEqual(items, [
        { i: 0, t: '包含假边界 "}, {"i":99,"t":"只是文本' },
        { i: 1, t: '真实下一条' },
    ]);
});
