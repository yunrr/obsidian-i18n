export type WorkerBackend = 'rust' | 'cjs';

const DEFAULT_WORKER_PORT = 18743;
const MAX_PORT = 65535;

export const normalizeCompanionWorkerBasePort = (value: unknown): number => {
    const port = typeof value === 'number'
        ? value
        : typeof value === 'string'
            ? Number.parseInt(value, 10)
            : Number.NaN;
    if (!Number.isFinite(port)) return DEFAULT_WORKER_PORT;
    return Math.min(MAX_PORT - 1, Math.max(1, Math.floor(port)));
};

export const getCompanionWorkerPort = (
    basePortValue: unknown,
    backend: WorkerBackend,
): number => {
    const basePort = normalizeCompanionWorkerBasePort(basePortValue);
    return backend === 'rust' ? basePort : basePort + 1;
};
