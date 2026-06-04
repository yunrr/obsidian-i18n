import * as path from 'path';
import type { WorkerBackend } from './companion-worker-ports';

export const COMPANION_WORKER_PROTOCOL_VERSION = 2;

export type CompanionWorkerIdentityState = 'same' | 'other' | 'stale' | 'missing';

interface CompanionWorkerIdentityPayload {
    ok?: boolean;
    pluginDir?: unknown;
    backend?: unknown;
    protocolVersion?: unknown;
}

const isSamePluginDir = (leftValue: unknown, rightValue: string): boolean => {
    if (typeof leftValue !== 'string') return false;
    const left = path.resolve(leftValue);
    const right = path.resolve(rightValue);
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
};

export const classifyCompanionWorkerIdentity = (
    payload: CompanionWorkerIdentityPayload | null | undefined,
    pluginDir: string,
    backend: WorkerBackend,
): CompanionWorkerIdentityState => {
    if (!payload?.ok || typeof payload.pluginDir !== 'string') return 'missing';
    if (!isSamePluginDir(payload.pluginDir, pluginDir)) return 'other';
    if (
        payload.protocolVersion !== COMPANION_WORKER_PROTOCOL_VERSION ||
        payload.backend !== backend
    ) {
        return 'stale';
    }
    return 'same';
};
