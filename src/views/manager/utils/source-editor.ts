import I18N from 'src/main';
import { PluginTranslationV1, ThemeTranslationV1 } from 'src/types';
import { useGlobalStoreInstance } from '~/utils/store/global';
import { EDITOR_VIEW_TYPE, THEME_EDITOR_VIEW_TYPE } from '../../../views';

export async function readTranslationSource<T>(i18n: I18N, sourceId: string): Promise<T> {
    const result = await i18n.companionWorkerManager.readSource({
        persistence: { basePath: i18n.sourceManager.getBasePath() },
        sourceId,
    });
    if (!result.state || !result.source) {
        throw new Error(result.error || '翻译文件不存在');
    }
    return result.source as T;
}

export async function openPluginSourceEditor(i18n: I18N, sourceId: string, filePath: string) {
    const translation = await readTranslationSource<PluginTranslationV1>(i18n, sourceId);
    useGlobalStoreInstance.getState().setEditorPluginTranslation(translation);
    useGlobalStoreInstance.getState().setEditorPluginTranslationPath(filePath);
    await i18n.view.activateView(EDITOR_VIEW_TYPE);
}

export async function openThemeSourceEditor(
    i18n: I18N,
    sourceId: string,
    filePath: string,
    themeName: string,
    themeDir: string,
    themeCssPath: string,
) {
    const translation = await readTranslationSource<ThemeTranslationV1>(i18n, sourceId);
    useGlobalStoreInstance.getState().setEditorTheme(translation, themeName, themeDir, filePath, themeCssPath);
    await i18n.view.activateView(THEME_EDITOR_VIEW_TYPE);
}
