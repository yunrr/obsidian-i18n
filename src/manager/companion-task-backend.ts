import type { WorkerBackend } from './companion-worker-ports';

export function resolveCompanionTaskBackend(
    taskBackends: ReadonlyMap<string, WorkerBackend>,
    taskId: string,
    fallbackBackend: WorkerBackend = 'rust',
): WorkerBackend {
    return taskBackends.get(taskId) || fallbackBackend;
}
