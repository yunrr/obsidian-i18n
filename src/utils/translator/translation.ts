/**
 * 文件名称: translation.ts
 * 模块描述: 翻译数据生成核心模块，负责从插件和主题文件中提取可翻译字符串并构建标准化翻译结构
 * 核心功能:
 *   - 解析插件manifest与源码字符串，生成包含版本信息和翻译字典的插件翻译JSON
 *   - 提取主题manifest与设置注释中的可翻译文本，构建主题翻译数据结构
 *   - 通过正则表达式匹配关键字符串，自动生成初始翻译字典
 *
 * 开发人员: zero
 * 维护人员: zero
 * 创建日期: 2025-08-15
 *
 * 修改日期:
 *   - 2025-08-15 [v1.0.0] zero: 初始版本，实现基础功能;
 *
 * 注意事项: 
 *   - 依赖 <mcsymbol name="PluginManifest" filename="types.ts" path="src/data/types.ts" startline="1" type="interface"></mcsymbol> 和 <mcsymbol name="OBThemeManifest" filename="types.ts" path="src/data/types.ts" startline="10" type="interface"></mcsymbol> 类型定义
 *   - 正则表达式匹配规则需根据实际字符串模式调整，避免过度匹配
 *   - 处理大型文件时可能存在性能瓶颈，建议增加分批处理机制
 *   - 生成的翻译字典需人工校对，自动提取可能包含无效字符串
 */

import type { PluginManifest } from 'obsidian';
import { OBThemeManifest, ThemeTranslationV1, ThemeTranslationSchemaVersion, PluginTranslationV1, PluginTranslationSchemaVersion } from '../../types';
import { AstTranslator } from './core-ast-translator';
import { RegexTranslator } from './core-regex-translator';
import { getEffectiveExtractionSettings } from './config';
export {
    calculateChecksum,
    countChineseTranslationSources,
    getPluginTranslationSources,
    getThemeTranslationSources,
    hasBoundedChineseRuns,
    hasChineseText,
    hasChineseTextAtLeast,
    hasExtractedTranslationContent,
    mergeAstItems,
    mergeRegexItems,
    shouldSkipExtractionForChineseContent,
} from './light';

/**
 * 生成插件的翻译 JSON 对象。
 * @param pluginVersion - 插件的版本号。
 * @param manifestJSON - 插件的manifest.json对象。 
 * @param mainStr - 插件的主要字符串内容。
 * @param reLength - 正则表达式匹配的最大长度。
 * @param regexps - 用于匹配字符串的正则表达式数组。
 * @returns 一个包含翻译信息的 Translation 对象。
 */
export function generatePlugin(pluginVersion: string, manifestJSON: PluginManifest, mainStr: string, language: string, settings: any): PluginTranslationV1 {
    const effectiveSettings = getEffectiveExtractionSettings(settings);
    const translationJson: PluginTranslationV1 = {
        schemaVersion: PluginTranslationSchemaVersion.V1,
        metadata: {
            plugin: manifestJSON.id,
            version: effectiveSettings.translationVersion,
            title: manifestJSON.name,
            description: `${manifestJSON.name} Localization & Tweaks`,
            language: language,
            supportedVersions: pluginVersion,
            author: effectiveSettings.author,
        },
        dict: {
            'main.js': {
                ast: [],
                regex: []
            }
        }
    };
    if (effectiveSettings.astExtractionEnabled !== false) {
        const astTranslator = new AstTranslator(effectiveSettings as any);
        const ast = astTranslator.loadCode(mainStr);
        if (ast) translationJson.dict['main.js'].ast = astTranslator.extract(ast);
    }

    if (effectiveSettings.reExtractionEnabled !== false) {
        const regexTranslator = new RegexTranslator(effectiveSettings as any);
        const regex = regexTranslator.loadCode(mainStr);
        if (regex) translationJson.dict['main.js'].regex = regex;
    }

    return translationJson;
}

/**
 * 生成主题的翻译 JSON 对象。
 * @param themeManifest - 主题的manifest.json对象。
 * @param themeStr - 主题的主要字符串内容。
 * @returns 一个包含翻译信息的 Theme 对象。
 */
export function generateTheme(themeManifest: OBThemeManifest, themeStr: string, settings: any): ThemeTranslationV1 {
    const effectiveSettings = getEffectiveExtractionSettings(settings);
    const themeJson: ThemeTranslationV1 = {
        schemaVersion: ThemeTranslationSchemaVersion.V1,
        metadata: {
            theme: themeManifest.name,
            language: 'zh-cn', // 默认语言
            version: effectiveSettings.translationVersion,
            supportedVersions: themeManifest.version,
            title: themeManifest.name,
            description: `${themeManifest.name} Localization & Tweaks`,
            author: effectiveSettings.author,
        },
        dict: []
    };
    // 使用全局匹配找到所有 /* @settings ... */ 注释块
    const settingsBlockRegex = /\/\* @settings([\s\S]*?)\*\//g;
    let blockMatch;
    const seenSources = new Set<string>();

    while ((blockMatch = settingsBlockRegex.exec(themeStr)) !== null) {
        const blockContent = blockMatch[1];

        // 匹配 YAML 字段：name, title, description, label, markdown
        // 捕获前缀、可能的引号、实际内容、可能的后引号
        const fieldRegex = /^(?:[ \t]*)(name|title|description|label|markdown):\s*(["']?)(.*?)\2[ \t]*(?:\r?\n|$)/gm;
        let fieldMatch;

        while ((fieldMatch = fieldRegex.exec(blockContent)) !== null) {
            const fieldType = fieldMatch[1];
            const pureText = fieldMatch[3];

            // 过滤空字符串并且排重
            if (pureText.trim() !== '' && !seenSources.has(pureText)) {
                seenSources.add(pureText);
                themeJson.dict.push({
                    type: fieldType,
                    source: pureText,
                    target: pureText
                });
            }
        }
    }

    return themeJson;
}
