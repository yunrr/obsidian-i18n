export interface LiteralTranslation {
    source?: string;
    target?: string;
}

interface ActiveReplacement {
    source: string;
    target: string;
    order: number;
}

interface Match {
    start: number;
    end: number;
    replacement: ActiveReplacement;
}

interface TrieNode {
    children: Map<string, TrieNode>;
    replacement?: ActiveReplacement;
    terminal?: boolean;
}

function createNode(): TrieNode {
    return { children: new Map() };
}

function collectActiveTranslations(translations: LiteralTranslation[]): ActiveReplacement[] {
    const active: ActiveReplacement[] = [];
    for (let index = 0; index < translations.length; index++) {
        const item = translations[index];
        const source = item.source || '';
        const target = item.target || '';
        if (!source || !target || source === target) continue;
        active.push({ source, target, order: index });
    }
    return active;
}

function legacyReplace(code: string, active: ActiveReplacement[]): string {
    let translatedCode = code;
    for (const item of active) {
        translatedCode = translatedCode.split(item.source).join(item.target);
    }
    return translatedCode;
}

function insertReplacement(root: TrieNode, replacement: ActiveReplacement) {
    let node = root;
    for (let index = 0; index < replacement.source.length; index++) {
        const char = replacement.source[index];
        let child = node.children.get(char);
        if (!child) {
            child = createNode();
            node.children.set(char, child);
        }
        node = child;
    }
    node.replacement = replacement;
    node.terminal = true;
}

function insertTerminal(root: TrieNode, text: string) {
    let node = root;
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        let child = node.children.get(char);
        if (!child) {
            child = createNode();
            node.children.set(char, child);
        }
        node = child;
    }
    node.terminal = true;
}

function trieContainsAny(root: TrieNode, text: string): boolean {
    if (root.children.size === 0) return false;
    for (let start = 0; start < text.length; start++) {
        let node: TrieNode | undefined = root;
        for (let index = start; index < text.length; index++) {
            node = node.children.get(text[index]);
            if (!node) break;
            if (node.terminal) return true;
        }
    }
    return false;
}

function hasCascadeRisk(active: ActiveReplacement[]): boolean {
    const laterSources = createNode();
    for (let index = active.length - 1; index >= 0; index--) {
        const item = active[index];
        if (trieContainsAny(laterSources, item.target)) return true;
        insertTerminal(laterSources, item.source);
    }
    return false;
}

function uniqueBySource(active: ActiveReplacement[]): ActiveReplacement[] {
    const seen = new Set<string>();
    const unique: ActiveReplacement[] = [];
    for (const item of active) {
        if (seen.has(item.source)) continue;
        seen.add(item.source);
        unique.push(item);
    }
    return unique;
}

function collectMatchesAt(code: string, start: number, root: TrieNode): Match[] | null {
    let node = root.children.get(code[start]);
    if (!node) return null;
    const matches: Match[] = [];
    if (node.replacement) {
        matches.push({
            start,
            end: start + 1,
            replacement: node.replacement,
        });
    }
    for (let index = start + 1; index < code.length; index++) {
        node = node.children.get(code[index]);
        if (!node) break;
        if (node.replacement) {
            matches.push({
                start,
                end: index + 1,
                replacement: node.replacement,
            });
        }
    }
    return matches.length > 0 ? matches : null;
}

function overlapsSelected(match: Match, selected: Match[]): boolean {
    for (const item of selected) {
        if (match.start < item.end && item.start < match.end) return true;
    }
    return false;
}

function selectClusterMatches(matches: Match[]): Match[] {
    const byLegacyPriority = [...matches].sort((a, b) => {
        if (a.replacement.order !== b.replacement.order) {
            return a.replacement.order - b.replacement.order;
        }
        if (a.start !== b.start) return a.start - b.start;
        return a.end - b.end;
    });
    const selected: Match[] = [];
    for (const match of byLegacyPriority) {
        if (!overlapsSelected(match, selected)) selected.push(match);
    }
    selected.sort((a, b) => a.start - b.start || a.end - b.end);
    return selected;
}

function replaceWithOriginalSourceMatches(code: string, active: ActiveReplacement[]): string {
    const root = createNode();
    for (const item of uniqueBySource(active)) {
        insertReplacement(root, item);
    }

    let output = '';
    let flushedUntil = 0;
    let clusterEnd = -1;
    let clusterMatches: Match[] = [];

    const flushCluster = () => {
        if (clusterMatches.length === 0) return;
        const selected = selectClusterMatches(clusterMatches);
        for (const match of selected) {
            output += code.slice(flushedUntil, match.start);
            output += match.replacement.target;
            flushedUntil = match.end;
        }
        clusterMatches = [];
        clusterEnd = -1;
    };

    for (let index = 0; index < code.length; index++) {
        if (clusterEnd >= 0 && index >= clusterEnd) flushCluster();
        const matches = collectMatchesAt(code, index, root);
        if (!matches) continue;
        for (const match of matches) {
            clusterMatches.push(match);
            if (match.end > clusterEnd) clusterEnd = match.end;
        }
    }
    flushCluster();

    output += code.slice(flushedUntil);
    return output;
}

export function replaceLiteralTranslations(code: string, translations: LiteralTranslation[]): string {
    const active = collectActiveTranslations(translations);
    if (active.length === 0) return code;
    if (hasCascadeRisk(active)) return legacyReplace(code, active);
    return replaceWithOriginalSourceMatches(code, active);
}
