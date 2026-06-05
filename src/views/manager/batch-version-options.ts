export const getBatchTranslationVersionOptions = (versions: string[], currentVersion: string) => {
    const merged = new Set<string>();
    if (currentVersion) merged.add(currentVersion);
    versions.forEach(version => {
        if (version) merged.add(version);
    });
    return Array.from(merged);
};
