import { parentPort } from 'worker_threads';
import { handlePluginExtractCore, handleThemeExtractCore } from './companion-extract-core';
import type { CompanionPluginExtractPayload, CompanionThemeExtractPayload } from './companion-worker-types';

type ExtractThreadRequest =
    | { id: number; type: 'plugin'; payload: CompanionPluginExtractPayload }
    | { id: number; type: 'theme'; payload: CompanionThemeExtractPayload };

async function handleRequest(message: ExtractThreadRequest) {
    const result = message.type === 'plugin'
        ? await handlePluginExtractCore(message.payload)
        : await handleThemeExtractCore(message.payload);
    parentPort?.postMessage({ id: message.id, ok: true, result });
}

parentPort?.on('message', (message: ExtractThreadRequest) => {
    handleRequest(message).catch(error => {
        parentPort?.postMessage({
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        });
    });
});
