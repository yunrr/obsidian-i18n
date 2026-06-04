import assert from 'node:assert/strict';
import test from 'node:test';

import {
    getSlowestApplyPluginStage,
    runPluginApplyTranslationFlow,
} from '../src/views/manager/components/plugin-apply-flow.ts';

type DelayMap = Partial<Record<string, number>>;

function createApplyFlowHarness(delays: DelayMap = {}) {
    let clock = 0;
    const calls: string[] = [];
    const notices: string[] = [];
    const states: Array<{ id: string; state: any }> = [];
    const advance = (stage: string) => {
        calls.push(stage);
        clock += delays[stage] || 0;
    };

    const i18n = {
        settings: {
            applyAstTranslations: true,
            applyRegexTranslations: true,
        },
        app: {
            vault: {
                adapter: {
                    getBasePath: () => 'vault-root',
                },
            },
            plugins: {
                enabledPlugins: new Set<string>(['sample-plugin']),
                async disablePlugin(id: string) {
                    assert.equal(id, 'sample-plugin');
                    advance('disablePlugin');
                },
                async enablePlugin(id: string) {
                    assert.equal(id, 'sample-plugin');
                    advance('enablePlugin');
                },
            },
        },
        manifest: { dir: '.obsidian/plugins/i18n' },
        sourceManager: {
            getBasePath: () => 'vault-root/.obsidian/plugins/i18n/data',
        },
        companionWorkerManager: {
            async getCjsEndpoint() {
                advance('getCjsEndpoint');
                return 'http://127.0.0.1:18744';
            },
            async applyPluginTranslation(request: any) {
                advance('applyPluginTranslation');
                assert.equal(request.pluginId, 'sample-plugin');
                assert.equal(request.pluginDir, 'vault-root/.obsidian/plugins/sample-plugin');
                assert.equal(request.translationSourceId, 'source-1');
                assert.equal(request.cjsEndpoint, 'http://127.0.0.1:18744');
                assert.equal(request.applyAst, true);
                assert.equal(request.applyRegex, true);
                return {
                    state: true,
                    translationVersion: '2.0.0',
                    processedFiles: 1,
                    diagnostics: {
                        totalMs: 8400,
                        fileCount: 1,
                        totalCandidates: 2,
                        astCandidates: 1,
                        regexCandidates: 1,
                        stages: [
                            { name: 'rust.collectCandidates', durationMs: 25, detail: 'total=2 ast=1 regex=1 files=1' },
                            { name: 'rust.requestCjsRender', durationMs: 8300, detail: 'files=1 candidates=2' },
                        ],
                        cjs: {
                            totalMs: 8200,
                            files: [
                                {
                                    file: 'main.js',
                                    astCandidates: 1,
                                    regexCandidates: 1,
                                    astReplaceMs: 120,
                                    regexReplaceMs: 8000,
                                },
                            ],
                        },
                    },
                };
            },
        },
        stateManager: {
            setPluginState(id: string, state: any) {
                states.push({ id, state });
            },
        },
        notice: {
            warning(message: string) {
                notices.push(`warning:${message}`);
            },
            result(state: boolean, message?: string) {
                notices.push(`result:${state}:${message || ''}`);
            },
            successPrefix(title: string, message?: string) {
                notices.push(`success:${title}:${message || ''}`);
            },
        },
    };

    return {
        get clock() {
            return clock;
        },
        advance,
        calls,
        notices,
        states,
        i18n,
        now: () => clock,
        refreshParent: async () => {
            advance('refreshParent');
        },
    };
}

test('apply button flow records per-stage timings and restores loading after success', async () => {
    const harness = createApplyFlowHarness({
        getCjsEndpoint: 120,
        applyPluginTranslation: 8420,
        disablePlugin: 35,
        enablePlugin: 41,
        refreshParent: 3,
    });
    const loadingStates: boolean[] = [];
    const logs: Array<{ stage: string; status: string; durationMs?: number }> = [];

    loadingStates.push(true);
    const result = await runPluginApplyTranslationFlow({
        plugin: { id: 'sample-plugin', name: 'Sample Plugin', version: '1.2.3' },
        pluginDir: 'vault-root/.obsidian/plugins/sample-plugin',
        activeSourceId: 'source-1',
        isEnabled: true,
        translationVersion: '1.0.0',
        i18n: harness.i18n,
        refreshParent: harness.refreshParent,
        now: harness.now,
        onLog: event => logs.push({
            stage: event.stage,
            status: event.status,
            durationMs: event.durationMs,
        }),
        messages: {
            genericError: 'generic-error',
            noApplyTranslationKinds: 'no-kinds',
            reloadSuccessTitle: 'reload-success',
            loadFailedAfterApply: 'reload-failed',
        },
    });
    loadingStates.push(false);

    assert.equal(result.applied, true);
    assert.deepEqual(loadingStates, [true, false]);
    assert.deepEqual(harness.calls, [
        'getCjsEndpoint',
        'applyPluginTranslation',
        'disablePlugin',
        'enablePlugin',
        'refreshParent',
    ]);
    assert.deepEqual(
        result.timings.map(item => [item.stage, item.durationMs]),
        [
            ['getCjsEndpoint', 120],
            ['applyPluginTranslation', 8420],
            ['disablePlugin', 35],
            ['enablePlugin', 41],
            ['refreshParent', 3],
        ],
    );
    assert.deepEqual(
        logs.map(item => [item.stage, item.status, item.durationMs]),
        [
            ['flow', 'start', undefined],
            ['getCjsEndpoint', 'start', undefined],
            ['getCjsEndpoint', 'success', 120],
            ['applyPluginTranslation', 'start', undefined],
            ['applyPluginTranslation', 'success', 8420],
            ['backendDiagnostics', 'success', 8400],
            ['backendDiagnostics', 'success', 25],
            ['backendDiagnostics', 'success', 8300],
            ['backendDiagnostics', 'success', 8200],
            ['backendDiagnostics', 'success', 120],
            ['backendDiagnostics', 'success', 8000],
            ['disablePlugin', 'start', undefined],
            ['disablePlugin', 'success', 35],
            ['enablePlugin', 'start', undefined],
            ['enablePlugin', 'success', 41],
            ['refreshParent', 'start', undefined],
            ['refreshParent', 'success', 3],
            ['flow', 'success', 8619],
        ],
    );
    assert.equal(getSlowestApplyPluginStage(result.timings)?.stage, 'applyPluginTranslation');
    assert.deepEqual(harness.states, [{
        id: 'sample-plugin',
        state: {
            id: 'sample-plugin',
            isApplied: true,
            pluginVersion: '1.2.3',
            translationVersion: '2.0.0',
        },
    }]);
});

test('apply button flow records the failing stage and still lets loading clear', async () => {
    const harness = createApplyFlowHarness({
        getCjsEndpoint: 10,
        applyPluginTranslation: 3000,
    });
    harness.i18n.companionWorkerManager.applyPluginTranslation = async () => {
        harness.advance('applyPluginTranslation');
        throw new Error('apply timeout');
    };
    let replacing = false;
    const logs: Array<{ stage: string; status: string; durationMs?: number; error?: string }> = [];

    replacing = true;
    const result = await runPluginApplyTranslationFlow({
        plugin: { id: 'sample-plugin', name: 'Sample Plugin', version: '1.2.3' },
        pluginDir: 'vault-root/.obsidian/plugins/sample-plugin',
        activeSourceId: 'source-1',
        isEnabled: true,
        i18n: harness.i18n,
        refreshParent: harness.refreshParent,
        now: harness.now,
        onLog: event => logs.push({
            stage: event.stage,
            status: event.status,
            durationMs: event.durationMs,
            error: event.error,
        }),
        messages: {
            genericError: 'generic-error',
            noApplyTranslationKinds: 'no-kinds',
            reloadSuccessTitle: 'reload-success',
            loadFailedAfterApply: 'reload-failed',
        },
    });
    replacing = false;

    assert.equal(replacing, false);
    assert.equal(result.applied, false);
    assert.match(result.error || '', /apply timeout/);
    assert.deepEqual(
        result.timings.map(item => [item.stage, item.durationMs]),
        [
            ['getCjsEndpoint', 10],
            ['applyPluginTranslation', 3000],
        ],
    );
    assert.deepEqual(
        logs.map(item => [item.stage, item.status, item.durationMs, item.error]),
        [
            ['flow', 'start', undefined, undefined],
            ['getCjsEndpoint', 'start', undefined, undefined],
            ['getCjsEndpoint', 'success', 10, undefined],
            ['applyPluginTranslation', 'start', undefined, undefined],
            ['applyPluginTranslation', 'failure', 3000, 'Error: apply timeout'],
            ['flow', 'failure', 3010, 'Error: apply timeout'],
        ],
    );
    assert.equal(getSlowestApplyPluginStage(result.timings)?.stage, 'applyPluginTranslation');
    assert.deepEqual(harness.states, []);
});
