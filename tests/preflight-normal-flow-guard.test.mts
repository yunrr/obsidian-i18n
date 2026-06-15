import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('plugin editor preflight button is wired to the normal backend preflight flow', async () => {
    const editorSource = await readFile('src/views/plugin_editor/editor.tsx', 'utf8');

    assert.equal(
        editorSource.includes('startPluginDiagnoseCleanup'),
        true,
        'the normal preflight flow must start backend diagnose cleanup',
    );
    assert.equal(
        editorSource.includes('stepPluginDiagnoseCleanup'),
        true,
        'the normal preflight flow must step backend diagnose cleanup probes',
    );
    assert.equal(
        editorSource.includes('cancelPluginDiagnoseCleanup'),
        true,
        'the normal preflight flow must cancel backend diagnose cleanup sessions on stop',
    );
    assert.equal(
        editorSource.includes('runPreflightPluginSwitchTest'),
        false,
        'the editor preflight button must not route to the temporary plugin switch test helper',
    );
});

test('plugin editor restores stale diagnose replacements before plugin switching', async () => {
    const editorSource = await readFile('src/views/plugin_editor/editor.tsx', 'utf8');
    const restoreIndex = editorSource.indexOf('restorePluginDiagnoseRecovery');
    const stopIndex = editorSource.indexOf('await stopPluginForBackendWrite');
    const startIndex = editorSource.indexOf('startPluginDiagnoseCleanup');

    assert.notEqual(
        restoreIndex,
        -1,
        'the normal preflight flow must ask Rust to restore stale recovery journal entries',
    );
    assert.notEqual(
        stopIndex,
        -1,
        'the normal preflight flow must stop the target plugin before backend writes',
    );
    assert.ok(
        restoreIndex < stopIndex,
        'stale recovery must happen before stopping/enabling the target plugin',
    );
    assert.ok(
        restoreIndex < startIndex,
        'stale recovery must happen before starting a new diagnose cleanup session',
    );
});
