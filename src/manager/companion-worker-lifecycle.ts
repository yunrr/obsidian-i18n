export type WorkerReadyWaitResult = 'ready' | 'timeout' | 'exited';

export interface WorkerReadyWaitOptions {
    timeoutMs: number;
    pollIntervalMs: number;
    isReady: () => Promise<boolean>;
    waitForExit: () => Promise<unknown>;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const waitForWorkerReadyOrExit = async (
    options: WorkerReadyWaitOptions,
): Promise<WorkerReadyWaitResult> => {
    const startedAt = Date.now();
    let exited = false;
    const exitPromise = options.waitForExit().then(() => {
        exited = true;
    });

    while (Date.now() - startedAt < options.timeoutMs) {
        if (exited) return 'exited';
        const remainingMs = Math.max(0, options.timeoutMs - (Date.now() - startedAt));
        const readyResult = await Promise.race([
            options.isReady()
                .then(isReady => isReady ? 'ready' as const : 'not-ready' as const)
                .catch(() => 'not-ready' as const),
            exitPromise.then(() => 'exited' as const),
        ]);

        if (readyResult === 'ready') return 'ready';
        if (readyResult === 'exited') return 'exited';

        const waitResult = await Promise.race([
            exitPromise.then(() => 'exited' as const),
            delay(Math.min(options.pollIntervalMs, remainingMs)).then(() => 'poll' as const),
        ]);
        if (waitResult === 'exited') return 'exited';
    }

    return exited ? 'exited' : 'timeout';
};
