import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('plugin page status filtering follows the selected translation version source', async () => {
    const pluginManager = await readFile('src/views/manager/plugin-manager.tsx', 'utf8');

    assert.match(
        pluginManager,
        /getSourceForPluginVersion\(plugin\.id,\s*'plugin',\s*batchTranslationVersion\)/,
        'plugin page status must resolve the source for the selected translation version',
    );
    assert.match(
        pluginManager,
        /const displaySource = batchTranslationVersion \? selectedVersionSource : activeSource;/,
        'plugin page status must prefer the selected version source over the active source',
    );
    assert.match(
        pluginManager,
        /activeSourceId:\s*displaySourceId/,
        'plugin item actions must receive the selected version source id',
    );
    assert.match(
        pluginManager,
        /isLangDoc:\s*hasDisplaySourceFile/,
        'untranslated filtering must only match plugins that have a source for the selected version',
    );
});

test('plugin source selector displays translation versions instead of source titles', async () => {
    const pluginItem = await readFile('src/views/manager/components/plugin-item.tsx', 'utf8');

    assert.match(
        pluginItem,
        /const getSourceVersionLabel = \(source: any\) =>/,
        'plugin source selector must format labels through a version-aware helper',
    );
    assert.match(
        pluginItem,
        /return `v\$\{version\}`;/,
        'plugin source selector must prefer translationVersion labels',
    );
    assert.doesNotMatch(
        pluginItem,
        /<SelectItem key=\{source\.id\} value=\{source\.id\} className="text-\[11px\]">\s*\{source\.title\}\s*<\/SelectItem>/,
        'plugin source selector should not render raw source titles as the option label',
    );
});

test('plugin editor reloads metadata when switching translation source paths', async () => {
    const editor = await readFile('src/views/plugin_editor/editor.tsx', 'utf8');

    assert.match(
        editor,
        /const pluginTranslationPath = useGlobalStoreInstance\(\(state\) => state\.editorPluginTranslationPath\);/,
        'plugin editor must subscribe to translation source path changes',
    );
    assert.match(
        editor,
        /loadedTranslationPathRef\.current === pluginTranslationPath/,
        'plugin editor must guard reloads by source path instead of one-time initialization',
    );
    assert.match(
        editor,
        /setMetadata\(pluginTranslation\.metadata\)/,
        'plugin editor must load metadata directly from the opened translation file',
    );
    assert.doesNotMatch(
        editor,
        /initializedRef/,
        'plugin editor should not keep stale metadata after the first opened source',
    );
});

test('cloud downloads save local sources through indexed cloud helper', async () => {
    const files = await Promise.all([
        readFile('src/views/cloud/components/manage-tab.tsx', 'utf8'),
        readFile('src/views/cloud/components/history-dialog.tsx', 'utf8'),
        readFile('src/views/manager/components/plugin-item.tsx', 'utf8'),
        readFile('src/views/manager/components/theme-item.tsx', 'utf8'),
        readFile('src/manager/auto-manager.ts', 'utf8'),
    ]);

    for (const source of files) {
        assert.match(
            source,
            /saveCloudSourceFile\(/,
            'cloud local sync paths must rebuild local TranslationSource indexes from downloaded JSON',
        );
        assert.doesNotMatch(
            source,
            /saveSourceFile\([^;\n]+content\)[\s\S]{0,900}saveSource\(/,
            'cloud local sync must not overwrite indexed metadata with a hand-built source record',
        );
    }
});

test('cloud manifest keeps legacy field names with translation JSON version semantics', async () => {
    const rustWorker = await readFile('rust-worker/src/main.rs', 'utf8');

    assert.match(
        rustWorker,
        /let translation_version = content\s*\.pointer\("\/metadata\/version"\)/,
        'cloud publish should write manifest.version from translation metadata.version',
    );
    assert.match(
        rustWorker,
        /let supported_versions = content\s*\.pointer\("\/metadata\/supportedVersions"\)/,
        'cloud publish should write manifest.supported_versions from translation metadata.supportedVersions',
    );
    assert.doesNotMatch(
        rustWorker,
        /"supported_versions": version/,
        'cloud publish must not reuse the same form version for both manifest fields',
    );
});
