import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('manager batch extraction reacts to settings version updates', async () => {
    const pluginManager = await readFile('src/views/manager/plugin-manager.tsx', 'utf8');
    const themeManager = await readFile('src/views/manager/theme-manager.tsx', 'utf8');

    for (const source of [pluginManager, themeManager]) {
        assert.match(
            source,
            /settingsUpdateTick/,
            'batch managers must subscribe to settings updates so changing the default translation version refreshes extractability',
        );
        assert.match(
            source,
            /getBatchTranslationVersionOptions/,
            'batch managers must include the current default extraction version in the version selector options',
        );
    }
});
