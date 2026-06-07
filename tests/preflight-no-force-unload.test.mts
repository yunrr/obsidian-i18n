import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('plugin editor runtime preflight does not force-unload plugins after disable timeout', async () => {
    const editorSource = await readFile('src/views/plugin_editor/editor.tsx', 'utf8');

    assert.equal(
        editorSource.includes('forceUnloadPluginRuntime'),
        false,
        'runtime preflight must not directly force-unload or delete Obsidian plugin runtime records',
    );
    assert.match(
        editorSource,
        /terminalFailure:\s*probeResult\.terminalFailure/,
        'disable failures must be reported to the backend as terminal probe failures',
    );
});
