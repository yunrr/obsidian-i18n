/**
 * 大模型响应返回解析工具箱
 */

export function parseTranslationResponse(content: string): Array<{ i: number; t: string }> {
    if (!content || content.trim() === '') {
        throw new Error('AI 返回内容为空');
    }

    let jsonText = content.trim();
    let parsedData: unknown;
    let isParsedObject = false;

    // 【阶段 1: 定位 JSON 内容】
    const codeBlockMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
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

    try {
        parsedData = JSON.parse(jsonText);
        isParsedObject = true;
    } catch (e) {
        isParsedObject = false;
    }

    if (isParsedObject) {
        try {
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
            console.warn('[AI Response] 抽取 JSON 对象失败，准备按原样提取 t 字段...', (e as Error).message);
        }
    }

    const fallbackResults: Array<{ i: number; t: string }> = [];
    const extractRegex = /"i"\s*:\s*(\d+)\s*,\s*"t"\s*:\s*"/g;

    let match;
    while ((match = extractRegex.exec(jsonText)) !== null) {
        try {
            const id = parseInt(match[1]);
            const rawText = rawTFieldUntilObjectEnd(jsonText, extractRegex.lastIndex);
            if (rawText !== null) fallbackResults.push({ i: id, t: rawText });
        } catch (e) {
            // 忽略单个畸形项
        }
    }

    if (fallbackResults.length > 0) {
        return fallbackResults;
    }

    throw new Error('AI 返回数据格式严重损坏，原样提取也未能提取到业务结构 ({i, t})。');
}

function rawTFieldUntilObjectEnd(text: string, start: number): string | null {
    for (let index = start; index < text.length; index++) {
        if (text[index] !== '"') continue;
        if (text.slice(index + 1).trimStart().startsWith('}')) {
            return text.slice(start, index);
        }
    }
    const objectEnd = text.indexOf('}', start);
    return objectEnd >= 0 ? text.slice(start, objectEnd) : null;
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
