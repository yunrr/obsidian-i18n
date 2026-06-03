import * as path from 'path';

import { ThemeTranslationSchemaVersion, ThemeTranslationV1 } from 'src/types';
import { saveTranslationFile } from '@/src/manager/io-manager';
import { useGlobalStoreInstance } from '~/utils/store/global';
import { useThemeEditorStore } from './store';

export async function saveCurrentThemeEditorTranslation(): Promise<boolean> {
    const { items, metadata, translationPath, themeName } = useThemeEditorStore.getState();
    const i18n = useGlobalStoreInstance.getState().i18n;

    if (!translationPath) return false;

    const themeJson: ThemeTranslationV1 = {
        schemaVersion: ThemeTranslationSchemaVersion.V1,
        metadata: metadata || {
            theme: themeName || '',
            language: 'zh-cn',
            version: i18n.settings.translationVersion || '1.0.1',
            supportedVersions: '0.0.0',
            title: themeName || '',
            description: '',
            author: i18n.settings.author || '',
        },
        dict: items.map(item => ({
            type: item.type || 'unknown',
            source: item.source,
            target: item.target,
        })),
    };

    const ext = path.extname(translationPath);
    const sourceId = path.basename(translationPath, ext);
    const source = i18n?.sourceManager?.getSource(sourceId);

    if (source && i18n?.sourceManager) {
        i18n.sourceManager.saveSourceFile(source.id, themeJson);
        const updatedSource = i18n.sourceManager.getSource(source.id);
        if (updatedSource) {
            if (updatedSource.origin === 'cloud') {
                updatedSource.origin = 'local';
                updatedSource.cloud = undefined;
            }
            i18n.sourceManager.saveSource(updatedSource, { skipFileIndex: true });
        }
    } else {
        saveTranslationFile(translationPath, themeJson);
    }

    useGlobalStoreInstance.setState({ editorThemeTranslation: themeJson });
    return true;
}
