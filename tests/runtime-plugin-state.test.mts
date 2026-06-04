import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getPluginFailureMessage,
    getPluginRestorePlan,
    getPluginLoadState,
    isPluginRecordLoaded,
    pluginLoadTimeoutFromBaseline,
    pluginSwitchTimeoutFromBaseline,
    normalizePluginSwitchCooldownMs,
    normalizePluginTimeoutGraceMs,
    getRuntimeProbeSwitchError,
    forceUnloadPluginRuntime,
} from '../src/views/plugin_editor/runtime-plugin-state.ts';

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

test('normalizes plugin timeout grace settings to a safe millisecond range', () => {
    assert.equal(normalizePluginTimeoutGraceMs(undefined), 2000);
    assert.equal(normalizePluginTimeoutGraceMs(Number.NaN), 2000);
    assert.equal(normalizePluginTimeoutGraceMs(-1), 0);
    assert.equal(normalizePluginTimeoutGraceMs(4500.8), 4500);
    assert.equal(normalizePluginTimeoutGraceMs(90000), 60000);
});

test('uses baseline switch duration plus configured grace for later probe timeouts', () => {
    assert.equal(pluginSwitchTimeoutFromBaseline(undefined, 2000, 15000), 15000);
    assert.equal(pluginSwitchTimeoutFromBaseline(600, 2000, 15000), 2600);
    assert.equal(pluginSwitchTimeoutFromBaseline(50, 2000, 15000), 2050);
    assert.equal(pluginSwitchTimeoutFromBaseline(90000, 2000, 15000), 92000);
    assert.equal(pluginSwitchTimeoutFromBaseline(600, 4500, 15000), 5100);
});

test('keeps plugin load timeout compatible with the default timeout grace', () => {
    assert.equal(pluginLoadTimeoutFromBaseline(undefined), 15000);
    assert.equal(pluginLoadTimeoutFromBaseline(600), 2600);
    assert.equal(pluginLoadTimeoutFromBaseline(50), 2050);
    assert.equal(pluginLoadTimeoutFromBaseline(90000), 92000);
});

test('detects plugin load failures from runtime records and notice text', () => {
    assert.equal(
        getPluginFailureMessage(
            {
                plugins: {
                    'sample-plugin': { loadError: new Error('boom') },
                },
            },
            'sample-plugin',
        ),
        'boom',
    );
    assert.equal(
        getPluginFailureMessage(
            {},
            'sample-plugin',
            ['无法加载插件 sample-plugin', 'other notice'],
        ),
        '无法加载插件 sample-plugin',
    );
    assert.equal(getPluginFailureMessage({}, 'sample-plugin', ['unrelated failure']), '');
});

test('treats forced unload after a probe as a runtime probe failure', () => {
    assert.equal(
        getRuntimeProbeSwitchError({ enabled: false, loaded: true }, false),
        '',
    );
    assert.match(
        getRuntimeProbeSwitchError({ enabled: false, loaded: false }, true, '插件关闭超时'),
        /无法正常关闭/,
    );
    assert.match(
        getRuntimeProbeSwitchError({ enabled: true, loaded: false }, false),
        /enabled=true, loaded=false/,
    );
});

test('force unloads a retained runtime plugin record after disable leaves it loaded', async () => {
    const record = {
        _loaded: true,
        unloadCalled: 0,
        unload() {
            this.unloadCalled++;
            this._loaded = false;
        },
    };
    const api = {
        enabledPlugins: new Set<string>(['sample-plugin']),
        plugins: { 'sample-plugin': record },
        getPlugin: () => record,
    };

    const result = await forceUnloadPluginRuntime(api, 'sample-plugin');

    assert.equal(result.loaded, false);
    assert.equal(record.unloadCalled, 1);
    assert.equal(api.enabledPlugins.has('sample-plugin'), false);
    assert.deepEqual(getPluginLoadState(api, 'sample-plugin'), {
        enabled: false,
        loaded: false,
    });
});

test('uses Obsidian unloadPlugin before direct record unload when forcing plugin shutdown', async () => {
    const calls: string[] = [];
    const record = {
        _loaded: true,
        unload() {
            calls.push('record');
            this._loaded = false;
        },
    };
    const api = {
        enabledPlugins: new Set<string>(),
        plugins: { 'sample-plugin': record },
        getPlugin: () => record,
        async unloadPlugin(id: string) {
            calls.push(`api:${id}`);
        },
    };

    const result = await forceUnloadPluginRuntime(api, 'sample-plugin');

    assert.equal(result.loaded, false);
    assert.deepEqual(calls, ['api:sample-plugin', 'record']);
});

test('does not hang when Obsidian unloadPlugin and direct plugin unload never resolve', async () => {
    const record = {
        _loaded: true,
        unloadCalled: 0,
        unload() {
            this.unloadCalled++;
            return new Promise(() => undefined);
        },
    };
    const api = {
        enabledPlugins: new Set<string>(['sample-plugin']),
        plugins: { 'sample-plugin': record },
        getPlugin: () => record,
        async unloadPlugin() {
            return new Promise<void>(() => undefined);
        },
    };

    const startedAt = Date.now();
    const result = await forceUnloadPluginRuntime(api, 'sample-plugin', {
        timeoutMs: 10,
    });

    assert.equal(result.loaded, false);
    assert.equal(record.unloadCalled, 1);
    assert.ok(Date.now() - startedAt < 200);
});
