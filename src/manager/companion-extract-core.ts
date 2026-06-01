import * as fs from 'fs-extra';
import * as path from 'path';
import { generatePlugin, generateTheme, getPluginTranslationSources, getThemeTranslationSources, hasBoundedChineseRuns, hasChineseText, hasExtractedTranslationContent } from '../utils/translator/translation';
import type { OBThemeManifest } from '../types';
import type {
    CompanionPluginExtractPayload,
    CompanionPluginExtractResult,
    CompanionThemeExtractPayload,
    CompanionThemeExtractResult,
} from './companion-worker-types';

function isChineseSkipMode(settings: { chineseSkipMode?: string } | undefined, mode: 'source' | 'extracted') {
    return (settings?.chineseSkipMode || 'source') === mode;
}

function shouldSkipBySource(settings: { chineseSkipMode?: string } | undefined, metadataText: string, sourceText: string) {
    return isChineseSkipMode(settings, 'source') && (hasChineseText(metadataText) || hasBoundedChineseRuns(sourceText));
}

function shouldSkipByExtracted(settings: { chineseSkipMode?: string } | undefined, metadataText: string, sources: string[]) {
    return isChineseSkipMode(settings, 'extracted') && (hasChineseText(metadataText) || sources.some(source => hasChineseText(source)));
}

export async function handlePluginExtractCore(payload: CompanionPluginExtractPayload): Promise<CompanionPluginExtractResult> {
    try {
        if (!await fs.pathExists(payload.mainDoc)) {
            throw new Error('main.js 不存在');
        }

        const [mainStr, manifestJSON] = await Promise.all([
            fs.readFile(payload.mainDoc, 'utf8'),
            fs.readJson(payload.manifestDoc),
        ]);

        const metadataText = `${manifestJSON.name || payload.pluginName}\n${manifestJSON.description || ''}`;
        if (shouldSkipBySource(payload.settings, metadataText, mainStr)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'chinese' };
        }

        const translationJson = generatePlugin(payload.pluginVersion, manifestJSON, mainStr, payload.language, payload.settings);
        const extractedSources = getPluginTranslationSources(translationJson);
        if (shouldSkipByExtracted(payload.settings, metadataText, extractedSources)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'chinese' };
        }
        const extractionEnabled = payload.settings?.astExtractionEnabled !== false || payload.settings?.reExtractionEnabled !== false;
        if (extractionEnabled && !hasExtractedTranslationContent(extractedSources)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'empty' };
        }

        return {
            status: 'success',
            resourceId: payload.resourceId,
            label: payload.label,
            pluginId: payload.resourceId,
            content: translationJson,
            options: { title: payload.pluginName },
        };
    } catch (error) {
        return {
            status: 'failed',
            resourceId: payload.resourceId,
            label: payload.label,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export async function handleThemeExtractCore(payload: CompanionThemeExtractPayload): Promise<CompanionThemeExtractResult> {
    try {
        if (!await fs.pathExists(payload.themeCssPath)) {
            throw new Error('theme.css 不存在');
        }

        const cssStr = await fs.readFile(payload.themeCssPath, 'utf8');
        const manifestPath = path.join(payload.themeDir, 'manifest.json');
        let manifest: OBThemeManifest = { name: payload.themeName, version: '0.0.0', minAppVersion: '', author: '', authorUrl: '' };
        if (await fs.pathExists(manifestPath)) {
            try {
                manifest = await fs.readJson(manifestPath);
            } catch { }
        }

        const metadataText = manifest.name || payload.themeName;
        if (shouldSkipBySource(payload.settings, metadataText, cssStr)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'chinese' };
        }

        const translationJson = generateTheme(manifest, cssStr, payload.settings);
        const extractedSources = getThemeTranslationSources(translationJson);
        if (shouldSkipByExtracted(payload.settings, metadataText, extractedSources)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'chinese' };
        }
        if (!hasExtractedTranslationContent(extractedSources)) {
            return { status: 'skipped', resourceId: payload.resourceId, label: payload.label, reason: 'empty' };
        }

        return {
            status: 'success',
            resourceId: payload.resourceId,
            label: payload.label,
            pluginId: payload.themeName,
            content: translationJson,
            options: { title: payload.themeName, type: 'theme' },
        };
    } catch (error) {
        return {
            status: 'failed',
            resourceId: payload.resourceId,
            label: payload.label,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}
