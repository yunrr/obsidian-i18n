export function normalizeStreamingResponseText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith('data:')) return text;

    const contentChunks: string[] = [];
    const recoveredChunks: string[] = [];
    let lastEvent: any = null;
    let errorEvent: any = null;

    for (const line of text.split(/\r?\n/)) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('data:')) continue;

        const payload = trimmedLine.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        try {
            const event = JSON.parse(payload);
            lastEvent = event;
            if (event?.error) errorEvent = event;
            const choice = event?.choices?.[0];
            const deltaContent = choice?.delta?.content;
            const messageContent = choice?.message?.content;
            const deltaReasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
            const messageReasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning;
            const rootReasoning = event?.reasoning_content ?? event?.reasoning;
            if (typeof deltaContent === 'string') {
                contentChunks.push(deltaContent);
                recoveredChunks.push(deltaContent);
            }
            if (typeof messageContent === 'string') {
                contentChunks.push(messageContent);
                recoveredChunks.push(messageContent);
            }
            for (const reasoning of [deltaReasoning, messageReasoning, rootReasoning]) {
                if (typeof reasoning === 'string') recoveredChunks.push(reasoning);
            }
        } catch { }
    }

    const content = chooseTranslationResponseContent(contentChunks.join(''), recoveredChunks.join(''));
    if (!content && errorEvent) return JSON.stringify(errorEvent);
    if (!content) return text;

    return JSON.stringify({
        id: lastEvent?.id || 'companion-worker-stream',
        object: 'chat.completion',
        created: lastEvent?.created || Math.floor(Date.now() / 1000),
        model: lastEvent?.model || '',
        choices: [{
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: lastEvent?.choices?.[0]?.finish_reason || 'stop',
        }],
        usage: lastEvent?.usage,
    });
}

export function chooseTranslationResponseContent(content: string, recoveredContent: string): string {
    if (!recoveredContent || recoveredContent === content) return content;
    const contentCount = countParsedTranslationItems(content);
    const recoveredCount = countParsedTranslationItems(recoveredContent);
    return recoveredCount > contentCount ? recoveredContent : content;
}

function countParsedTranslationItems(content: string): number {
    const normalized = extractJsonLikeText(content);
    const rawCount = countRawTranslationItems(normalized);
    if (rawCount > 0) return rawCount;

    try {
        const parsed = JSON.parse(normalized);
        const array = extractArrayFromParsed(parsed);
        return array.filter((item: any) => item && typeof item.i === 'number' && typeof item.t === 'string').length;
    } catch {
        return 0;
    }
}

function extractJsonLikeText(content: string): string {
    let text = String(content || '').trim();
    const codeBlockMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();

    const starts = [text.indexOf('['), text.indexOf('{')].filter(index => index >= 0);
    const first = starts.length > 0 ? Math.min(...starts) : -1;
    const last = Math.max(text.lastIndexOf(']'), text.lastIndexOf('}'));
    if (first >= 0 && last > first) {
        text = text.slice(first, last + 1);
    }
    return text;
}

function countRawTranslationItems(text: string): number {
    const markers = collectRawTranslationMarkers(text);
    let count = 0;
    for (let index = 0; index < markers.length;) {
        const marker = markers[index];
        let selectedNextIndex = -1;
        let matched = false;

        for (let candidateIndex = index + 1; candidateIndex < markers.length; candidateIndex++) {
            const candidate = markers[candidateIndex];
            if (candidate.i <= marker.i) continue;
            if (!stripEntryTerminator(text.slice(marker.tStart, candidate.objectStart), true)) continue;
            if (selectedNextIndex >= 0 && candidate.i >= markers[selectedNextIndex].i) continue;
            selectedNextIndex = candidateIndex;
            matched = true;
        }

        if (matched) {
            count++;
            index = selectedNextIndex;
            continue;
        }

        if (stripEntryTerminator(text.slice(marker.tStart), false)) {
            count++;
            break;
        }

        index++;
    }
    return count;
}

function collectRawTranslationMarkers(text: string): Array<{ i: number; objectStart: number; tStart: number }> {
    const markers: Array<{ i: number; objectStart: number; tStart: number }> = [];
    const markerRegex = /\{\s*"?i"?\s*:\s*(\d+)\s*,\s*"?t"?\s*:\s*"/g;
    let match: RegExpExecArray | null;
    while ((match = markerRegex.exec(text)) !== null) {
        const i = Number.parseInt(match[1], 10);
        if (!Number.isFinite(i)) continue;
        const before = previousNonWhitespaceIndex(text, match.index);
        if (before >= 0 && text[before] !== '[' && text[before] !== ',') continue;
        markers.push({ i, objectStart: match.index, tStart: markerRegex.lastIndex });
    }
    return markers;
}

function stripEntryTerminator(segment: string, hasNextEntry: boolean): string | null {
    const match = segment.match(hasNextEntry ? /"\s*}\s*,?\s*$/ : /"\s*}\s*(?:[\]}]\s*)*$/);
    return match?.index === undefined ? null : segment.slice(0, match.index);
}

function previousNonWhitespaceIndex(text: string, endExclusive: number): number {
    let index = endExclusive - 1;
    while (index >= 0 && /\s/.test(text[index])) index--;
    return index;
}

function extractArrayFromParsed(data: unknown): any[] {
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
        const obj = data as Record<string, unknown>;
        if ('i' in obj && 't' in obj) return [obj];
        for (const value of Object.values(obj)) {
            if (Array.isArray(value)) return value;
        }
    }
    return [];
}
