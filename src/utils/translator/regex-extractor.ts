import type { PluginTranslationV1Regex } from '~/types';

export function extractRegexTranslations(
    code: string,
    patterns: RegExp[],
    isValidText: (text: string) => boolean,
): PluginTranslationV1Regex[] {
    const translations: PluginTranslationV1Regex[] = [];
    const seenSources = new Set<string>();
    const validationCache = new Map<string, boolean>();

    const accept = (source: string | undefined) => {
        if (!source || seenSources.has(source)) return;
        let valid = validationCache.get(source);
        if (valid === undefined) {
            valid = isValidText(source);
            validationCache.set(source, valid);
        }
        if (!valid) return;
        seenSources.add(source);
        translations.push({ source, target: source });
    };

    for (const regex of patterns) {
        regex.lastIndex = 0;
        if (!regex.global) {
            const match = code.match(regex);
            if (match) {
                for (const item of match) accept(item);
            }
            continue;
        }

        let match: RegExpExecArray | null;
        while ((match = regex.exec(code)) !== null) {
            accept(match[0]);
            if (match[0] === '') regex.lastIndex++;
        }
    }

    return translations;
}
