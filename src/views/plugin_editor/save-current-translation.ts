import * as path from 'path';

import { PluginTranslationV1 } from 'src/types';
import { saveTranslationFile } from '@/src/manager/io-manager';
import { useGlobalStoreInstance } from '~/utils/store/global';
import { useRegexStore } from './store';

export async function saveCurrentPluginEditorTranslation(): Promise<boolean> {
    const { regexItems, astItems, metadata, currentFile, syncFileDictInfo } = useRegexStore.getState();
    syncFileDictInfo(currentFile, astItems, regexItems);

    const finalDictData = useRegexStore.getState().dictData;
    const globalState = useGlobalStoreInstance.getState();
    const pluginTranslation = globalState.editorPluginTranslation;
    const pluginTranslationPath = globalState.editorPluginTranslationPath;
    const i18n = globalState.i18n;

    if (!pluginTranslation || !pluginTranslationPath) return false;

    const nextTranslation = JSON.parse(JSON.stringify(pluginTranslation)) as PluginTranslationV1;
    nextTranslation.dict = JSON.parse(JSON.stringify(finalDictData));
    if (metadata) nextTranslation.metadata = { ...metadata };

    const ext = path.extname(pluginTranslationPath);
    const sourceId = path.basename(pluginTranslationPath, ext);
    const source = i18n?.sourceManager?.getSource(sourceId);

    if (source && i18n?.sourceManager) {
        i18n.sourceManager.saveSourceFile(source.id, nextTranslation);
        const updatedSource = i18n.sourceManager.getSource(source.id);
        if (updatedSource) {
            if (metadata?.title) updatedSource.title = metadata.title;
            if (updatedSource.origin === 'cloud') {
                updatedSource.origin = 'local';
                updatedSource.cloud = undefined;
            }
            i18n.sourceManager.saveSource(updatedSource, { skipFileIndex: true });
        }
    } else {
        saveTranslationFile(pluginTranslationPath, nextTranslation);
    }

    useGlobalStoreInstance.setState({ editorPluginTranslation: nextTranslation });
    return true;
}
