import assert from 'node:assert/strict';
import test from 'node:test';

import {
    runPreflightPluginSwitchTest,
} from '../src/views/plugin_editor/runtime-plugin-state.ts';

test('preflight switch test enables the plugin and force unloads it when normal disable leaves it loaded', async () => {
    const calls: string[] = [];
    const record = {
        _loaded: false,
        unload() {
            calls.push('record.unload');
            this._loaded = false;
        },
    };
    const api = {
        enabledPlugins: new Set<string>(),
        plugins: {} as Record<string, unknown>,
        getPlugin: () => record,
        async enablePlugin(id: string) {
            calls.push(`enable:${id}`);
            record._loaded = true;
            this.enabledPlugins.add(id);
            this.plugins[id] = record;
        },
        async disablePlugin(id: string) {
            calls.push(`disable:${id}`);
            this.enabledPlugins.delete(id);
        },
        async unloadPlugin(id: string) {
            calls.push(`unload:${id}`);
        },
    };

    const result = await runPreflightPluginSwitchTest({
        pluginsApi: api,
        pluginId: 'sample-plugin',
        pluginName: 'Sample Plugin',
        switchCooldownMs: 0,
        timeoutGraceMs: 0,
        stopTimeoutMs: 1,
        waitMs: async () => undefined,
        readNoticeTexts: () => [],
    });

    assert.equal(result.success, true);
    assert.equal(result.usedForcedUnload, true);
    assert.match(result.message, /强制关闭成功/);
    assert.deepEqual(result.finalState, { enabled: false, loaded: false });
    assert.deepEqual(calls, [
        'enable:sample-plugin',
        'disable:sample-plugin',
        'unload:sample-plugin',
        'record.unload',
    ]);
});
