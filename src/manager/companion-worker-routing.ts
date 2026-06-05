import type { WorkerBackend } from './companion-worker-ports';
import type {
    CompanionAsyncTaskType,
    CompanionBatchTaskType,
} from './companion-worker-types';

export function getCompanionWorkerTaskBackend(type: CompanionBatchTaskType | CompanionAsyncTaskType): WorkerBackend {
    if (
        type === 'plugin-extract' ||
        type === 'theme-extract' ||
        type === 'plugin-batch-extract' ||
        type === 'theme-batch-extract' ||
        type === 'code-extract' ||
        type === 'ast-replace' ||
        type === 'plugin-render-translation' ||
        type === 'plugin-apply-translation' ||
        type === 'theme-apply-translation' ||
        type === 'plugin-diagnose-render-probe'
    ) {
        return 'cjs';
    }
    return 'rust';
}
