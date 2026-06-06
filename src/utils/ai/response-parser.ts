/**
 * 大模型响应返回解析工具箱
 */

export function parseTranslationResponse(content: string): Array<{ i: number; t: string }> {
    if (!content || content.trim() === '') {
        throw new Error('AI 返回内容为空');
    }

    let jsonText = content.trim();

    // 【阶段 1: 定位 JSON 内容】
    const codeBlockMatch = jsonText.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    if (codeBlockMatch) {
        jsonText = codeBlockMatch[1].trim();
    } else {
        // 如果没有包裹代码块，强行找首尾括号
        const firstBracket = Math.min(
            jsonText.indexOf('[') !== -1 ? jsonText.indexOf('[') : Infinity,
            jsonText.indexOf('{') !== -1 ? jsonText.indexOf('{') : Infinity
        );
        const lastBracket = Math.max(jsonText.lastIndexOf(']'), jsonText.lastIndexOf('}'));
        if (firstBracket !== Infinity && lastBracket !== -1 && lastBracket > firstBracket) {
            jsonText = jsonText.substring(firstBracket, lastBracket + 1);
        }
    }

    // 【阶段 2: 原文切条目】
    // 优先按递增的 i 锚点切分单条，直接抽取 t 字段原文，避免未转义引号或 JSON.parse 反转义破坏译文。
    const rawResults = extractRawTranslationItems(jsonText);
    if (rawResults.length > 0) {
        return rawResults;
    }

    // 【阶段 3: JSON 兜底】
    // 只在原文切分完全失败时使用，兼容少数字段顺序或包装结构不符合提示词的返回。
    try {
        const parsedData = JSON.parse(jsonText);
        const arr = extractArrayFromParsed(parsedData);
        const validated = arr.filter((item: any) => {
            if (item && typeof item.i === 'number' && typeof item.t === 'string') {
                return true;
            }
            console.warn('[AI Response] 跳过无效翻译项:', typeof item === 'object' ? JSON.stringify(item).substring(0, 50) : item);
            return false;
        });
        if (validated.length > 0) {
            return validated as Array<{ i: number; t: string }>;
        }
    } catch (e) {
        console.warn('[AI Response] 抽取 JSON 对象失败，且原文切分未提取到业务结构...', (e as Error).message);
    }

    throw new Error('AI 返回数据格式严重损坏，原样提取也未能提取到业务结构 ({i, t})。');
}

function extractRawTranslationItems(text: string): Array<{ i: number; t: string }> {
    const markers = collectItemMarkers(text);
    const results: Array<{ i: number; t: string }> = [];

    for (let index = 0; index < markers.length;) {
        const marker = markers[index];
        let selectedNextIndex = -1;
        let rawText: string | null = null;

        for (let candidateIndex = index + 1; candidateIndex < markers.length; candidateIndex++) {
            const candidate = markers[candidateIndex];
            if (candidate.i <= marker.i) continue;
            const candidateText = stripEntryTerminator(text.slice(marker.tStart, candidate.objectStart), true);
            if (candidateText === null) continue;
            if (selectedNextIndex >= 0 && candidate.i >= markers[selectedNextIndex].i) continue;
            selectedNextIndex = candidateIndex;
            rawText = candidateText;
        }

        if (rawText !== null) {
            results.push({ i: marker.i, t: rawText });
            index = selectedNextIndex;
            continue;
        }

        rawText = stripEntryTerminator(text.slice(marker.tStart), false);
        if (rawText !== null) {
            results.push({ i: marker.i, t: rawText });
            break;
        }

        index++;
    }

    return results;
}

function collectItemMarkers(text: string): Array<{ i: number; objectStart: number; tStart: number }> {
    const markers: Array<{ i: number; objectStart: number; tStart: number }> = [];
    const markerRegex = /\{\s*"?i"?\s*:\s*(\d+)\s*,\s*"?t"?\s*:\s*"/g;
    let match: RegExpExecArray | null;

    while ((match = markerRegex.exec(text)) !== null) {
        const i = Number.parseInt(match[1], 10);
        if (!Number.isFinite(i)) continue;
        if (!isLikelyEntryStart(text, match.index)) continue;
        markers.push({ i, objectStart: match.index, tStart: markerRegex.lastIndex });
    }

    return markers;
}

function stripEntryTerminator(segment: string, hasNextEntry: boolean): string | null {
    const match = segment.match(hasNextEntry ? /"\s*}\s*,?\s*$/ : /"\s*}\s*(?:[\]}]\s*)*$/);
    return match?.index === undefined ? null : segment.slice(0, match.index);
}

function isLikelyEntryStart(text: string, start: number): boolean {
    const before = previousNonWhitespaceIndex(text, start);
    return before < 0 || text[before] === '[' || text[before] === ',';
}

function previousNonWhitespaceIndex(text: string, endExclusive: number): number {
    let index = endExclusive - 1;
    while (index >= 0 && /\s/.test(text[index])) index--;
    return index;
}

/**
 * 智能数组向下钻取
 */
function extractArrayFromParsed(data: unknown): any[] {
    if (Array.isArray(data)) {
        return data;
    }

    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const obj = data as Record<string, unknown>;
        for (const value of Object.values(obj)) {
            if (Array.isArray(value) && value.length > 0) {
                return value;
            }
        }
        if ('i' in obj && 't' in obj) {
            return [obj];
        }
    }

    const preview = JSON.stringify(data).substring(0, 200);
    throw new Error(`无法从返回信息中识别提取数组: ${preview}`);
}
