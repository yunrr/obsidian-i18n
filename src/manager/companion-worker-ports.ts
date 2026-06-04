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
    const clamped = Math.min(MAX_PORT - 2, Math.max(1, Math.floor(port)));
    return clamped % 2 === 0 ? clamped + 1 : clamped;
};

export const getCompanionWorkerPort = (
    basePortValue: unknown,
    backend: WorkerBackend,
): number => {
    const basePort = normalizeCompanionWorkerBasePort(basePortValue);
    return backend === 'rust' ? basePort : basePort + 1;
};
