import { createHash } from 'crypto';
import type { PluginTranslationV1, PluginTranslationV1Ast, PluginTranslationV1Regex, ThemeTranslationV1 } from '../../types';

const CHINESE_TEXT_RE = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2FA1F}]/u;

function isChineseCodePoint(codePoint: number): boolean {
    return (codePoint >= 0x3400 && codePoint <= 0x4DBF)
        || (codePoint >= 0x4E00 && codePoint <= 0x9FFF)
        || (codePoint >= 0xF900 && codePoint <= 0xFAFF)
        || (codePoint >= 0x20000 && codePoint <= 0x2FA1F);
}

function isHexText(text: string): boolean {
    for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 70) || (code >= 97 && code <= 102))) return false;
    }
    return text.length > 0;
}

function getChineseUnicodeEscapeLength(text: string, index: number): number {
    if (text[index] !== '\\' || text[index + 1] !== 'u') return 0;

    const next = text[index + 2];
    if (next === '{') {
        const closeIndex = text.indexOf('}', index + 3);
        if (closeIndex === -1) return 0;

        const hex = text.slice(index + 3, closeIndex);
        if (hex.length >= 4 && hex.length <= 6 && isHexText(hex) && isChineseCodePoint(Number.parseInt(hex, 16))) {
            return closeIndex - index + 1;
        }
        return 0;
    }

    const hex = text.slice(index + 2, index + 6);
    if (hex.length === 4 && isHexText(hex) && isChineseCodePoint(Number.parseInt(hex, 16))) {
        return 6;
    }
    return 0;
}

function countChineseUnicodeEscapes(text: string, limit: number): number {
    let count = 0;
    let index = text.indexOf('\\u');
    while (index !== -1) {
        const escapeLength = getChineseUnicodeEscapeLength(text, index);
        if (escapeLength > 0) {
            count++;
            if (count >= limit) return count;
            index = text.indexOf('\\u', index + escapeLength);
        } else {
            index = text.indexOf('\\u', index + 2);
        }
    }
    return count;
}

function hasChineseUnicodeEscape(text: string): boolean {
    return countChineseUnicodeEscapes(text, 1) > 0;
}

function hasChineseRunPattern(text: string, minRunLength: number, minRunCount: number, requiredRunLength: number): boolean {
    let matchedRuns = 0;
    let hasRequiredRun = false;
    let runLength = 0;

    const flushRun = () => {
        if (runLength >= minRunLength) {
            matchedRuns++;
        }
        if (runLength >= requiredRunLength) {
            hasRequiredRun = true;
        }
        runLength = 0;
    };

    for (let index = 0; index < text.length;) {
        const escapeLength = getChineseUnicodeEscapeLength(text, index);
        if (escapeLength > 0) {
            runLength++;
            index += escapeLength;
            continue;
        }

        const codePoint = text.codePointAt(index) || 0;
        if (isChineseCodePoint(codePoint)) {
            runLength++;
        } else {
            flushRun();
            if (matchedRuns >= minRunCount && hasRequiredRun) return true;
        }
        index += codePoint > 0xffff ? 2 : 1;
    }
    flushRun();
    return matchedRuns >= minRunCount && hasRequiredRun;
}

export function hasChineseText(text?: string | null): boolean {
    return !!text && (CHINESE_TEXT_RE.test(text) || hasChineseUnicodeEscape(text));
}

export function hasChineseTextAtLeast(text: string | undefined | null, minCount: number): boolean {
    if (!text || minCount <= 0) return false;
    let count = 0;
    for (const char of text) {
        if (isChineseCodePoint(char.codePointAt(0) || 0)) {
            count++;
            if (count >= minCount) return true;
        }
    }
    return count + countChineseUnicodeEscapes(text, minCount - count) >= minCount;
}

export function hasBoundedChineseRuns(text: string | undefined | null, minRunLength = 2, minRunCount = 5, requiredRunLength = 5): boolean {
    return !!text && hasChineseRunPattern(text, minRunLength, minRunCount, requiredRunLength);
}

export function countChineseTranslationSources(sources: Array<string | undefined | null>): number {
    return sources.reduce((count, source) => count + (hasChineseText(source) ? 1 : 0), 0);
}

export function shouldSkipExtractionForChineseContent(name: string | undefined | null, sources: Array<string | undefined | null>, minChineseSourceCount = 1): boolean {
    return hasChineseText(name) || countChineseTranslationSources(sources) >= minChineseSourceCount;
}

export function hasExtractedTranslationContent(sources: Array<string | undefined | null>): boolean {
    return sources.some(source => !!source && source.trim() !== '');
}

export function getPluginTranslationSources(translationJson: PluginTranslationV1): string[] {
    return Object.values(translationJson.dict || {}).flatMap(dict => [
        ...(dict.ast || []).map(item => item.source),
        ...(dict.regex || []).map(item => item.source),
    ]);
}

export function getThemeTranslationSources(translationJson: ThemeTranslationV1): string[] {
    return (translationJson.dict || []).map(item => item.source);
}

export function calculateChecksum(data: any): string {
    const content = JSON.parse(JSON.stringify(data));
    if (content.checksum) delete content.checksum;
    return createHash('sha256').update(stableStringify(content)).digest('hex');
}

function stableStringify(obj: any): string {
    if (typeof obj !== 'object' || obj === null) {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        return '[' + obj.map(stableStringify).join(',') + ']';
    }
    return '{' + Object.keys(obj).sort().map(key =>
        JSON.stringify(key) + ':' + stableStringify(obj[key])
    ).join(',') + '}';
}

export function mergeAstItems(existingItems: PluginTranslationV1Ast[], newItems: PluginTranslationV1Ast[]): PluginTranslationV1Ast[] {
    const mergedMap = new Map<string, PluginTranslationV1Ast>();

    existingItems.forEach(item => {
        const key = `${item.type}|${item.name || ''}|${item.source}`;
        mergedMap.set(key, { ...item });
    });

    newItems.forEach(newItem => {
        const key = `${newItem.type}|${newItem.name || ''}|${newItem.source}`;
        if (!mergedMap.has(key)) {
            mergedMap.set(key, { ...newItem });
        }
    });

    return Array.from(mergedMap.values());
}

export function mergeRegexItems(existingItems: PluginTranslationV1Regex[], newItems: PluginTranslationV1Regex[]): PluginTranslationV1Regex[] {
    const mergedMap = new Map<string, PluginTranslationV1Regex>();

    existingItems.forEach(item => {
        mergedMap.set(item.source, { ...item });
    });

    newItems.forEach(newItem => {
        if (!mergedMap.has(newItem.source)) {
            mergedMap.set(newItem.source, { ...newItem });
        }
    });

    return Array.from(mergedMap.values());
}
