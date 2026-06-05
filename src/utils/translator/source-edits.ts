export interface SourceEdit {
    start: number;
    end: number;
    replacement: string;
}

export function applySourceEdits(code: string, edits: SourceEdit[]): string {
    if (edits.length === 0) return code;

    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
    let cursor = 0;
    let output = '';

    for (const edit of sorted) {
        if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > code.length) {
            throw new Error(`Invalid source edit range: ${edit.start}-${edit.end}`);
        }
        if (edit.start < cursor) {
            throw new Error(`Source edit overlap at ${edit.start}-${edit.end}`);
        }
        output += code.slice(cursor, edit.start);
        output += edit.replacement;
        cursor = edit.end;
    }

    output += code.slice(cursor);
    return output;
}
