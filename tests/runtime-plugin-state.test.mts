import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getPluginRestorePlan,
    getPluginLoadState,
    isPluginRecordLoaded,
    normalizePluginSwitchCooldownMs,
} from '../src/views/plugin_editor/runtime-plugin-state';

test('uses getPlugin as the runtime-loaded source when the plugin table still has a stale instance', () => {
    const api = {
        enabledPlugins: new Set<string>(),
        plugins: {
            'iron-vault': { _loaded: true },
        },
        getPlugin: () => null,
    };

    assert.deepEqual(getPluginLoadState(api, 'iron-vault'), {
        enabled: false,
        loaded: false,
    });
});

test('treats a retained plugin record with _loaded=false as unloaded when getPlugin is unavailable', () => {
    assert.equal(isPluginRecordLoaded({ _loaded: false }), false);
});

test('keeps the legacy plugin-table fallback for Obsidian builds without getPlugin', () => {
    const api = {
        enabledPlugins: new Set<string>(['sample-plugin']),
        plugins: {
            'sample-plugin': {},
        },
    };

    assert.deepEqual(getPluginLoadState(api, 'sample-plugin'), {
        enabled: true,
        loaded: true,
    });
});

test('restores a runtime-loaded plugin even when Obsidian did not persist it as enabled', () => {
    assert.deepEqual(getPluginRestorePlan({ enabled: false, loaded: true }), {
        restoreLoaded: true,
        saveEnabledState: false,
        requireDisabledAfterStop: false,
    });
});

test('normalizes plugin switch cooldown settings to a safe millisecond range', () => {
    assert.equal(normalizePluginSwitchCooldownMs(undefined), 3000);
    assert.equal(normalizePluginSwitchCooldownMs(Number.NaN), 3000);
    assert.equal(normalizePluginSwitchCooldownMs(250), 500);
    assert.equal(normalizePluginSwitchCooldownMs(4500.8), 4500);
    assert.equal(normalizePluginSwitchCooldownMs(90000), 60000);
});
