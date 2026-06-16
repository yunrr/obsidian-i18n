import * as fs from 'fs-extra';

export function simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return hex.repeat(4);
}

export function translationContentHash(content: string): string {
    try {
        return simpleHash(JSON.stringify(JSON.parse(content), null, 2));
    } catch {
        return simpleHash(content);
    }
}

export function translationFileHash(filePath: string): string {
    return translationContentHash(fs.readFileSync(filePath, 'utf-8'));
}
