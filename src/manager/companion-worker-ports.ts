export type WorkerBackend = 'rust' | 'cjs';

const DEFAULT_WORKER_PORT = 18743;
const MAX_PORT = 65535;
const MAX_CANDIDATE_COUNT = 16;

export const normalizeCompanionWorkerBasePort = (value: unknown): number => {
    const port = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN;
    if (!Number.isFinite(port)) return DEFAULT_WORKER_PORT;
    return Math.min(MAX_PORT - 1, Math.max(1, Math.floor(port)));
};

export const getCompanionWorkerPortCandidates = (
    basePortValue: unknown,
    backend: WorkerBackend,
    maxCandidates = MAX_CANDIDATE_COUNT,
): number[] => {
    const basePort = normalizeCompanionWorkerBasePort(basePortValue);
    const firstPort = backend === 'rust' ? basePort : basePort + 1;
    const limit = Math.max(1, Math.floor(maxCandidates));
    const ports: number[] = [];
    for (let port = firstPort; port <= MAX_PORT && ports.length < limit; port += 2) {
        ports.push(port);
    }
    return ports;
};
