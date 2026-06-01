/**
 * 核心提取配置聚合文件
 * 统一管理 AST 和 Regex 提取所需的白名单、过滤规则及默认正则
 */

// ============================================================================
// 1. AST 提取相关配置
// ============================================================================

export const AST_DEFAULT_CONFIG = {
    // 变量赋值白名单 (例如: const title = "...")
    assignments: [
        'overwriteName', 'innerHTML', 'outerHTML', 'title', 'alt', 'placeholder',
        'textContent', 'innerText', 'ariaLabel', 'nodeValue', 'buttonText',
        'confirmText', 'cancelText', 'labelText'
    ],
    // 函数调用白名单
    functions: [
        'Notice', 'setTitle', 'setContent', 'setName', 'setDesc', 'setButtonText',
        'setPlaceholder', 'setTooltip', 'addOption', 'addOptions', 'addHeading', 'addText',
        'setHint', 'setWarning', 'setText', 'appendText', 'createEl', 'createDiv',
        'createSpan', 'addCommand', 'insertText', 'replaceRange', 'replaceSelection',
        'log', 'error', 'warn', 'info', 'alert', 'confirm', 'prompt',
        'renderMarkdown', 'setLabel', 'setConfirmText', 'setCancelText'
    ],
    // 对象键名白名单
    keys: [
        'name', 'description', 'text', 'placeholder', 'label', 'tooltip', 'title',
        'header', 'desc', 'message', 'buttontext', 'aria-label', 'heading', 'content',
        'tab', 'caption', 'subtitle', 'summary', 'info', 'warning', 'error', 'success',
        'hint', 'instructions', 'link', 'selection', 'annotation', 'search', 'speech',
        'page', 'empty', 'detail', 'body', 'option', 'notice', 'confirmText',
        'cancelText', 'ariaLabel', 'buttonText'
    ]
};

export const AST_CLASSIC_CONFIG = {
    assignments: [
        'overwriteName', 'innerHTML', 'outerHTML', 'title', 'alt', 'placeholder',
        'textContent', 'innerText', 'ariaLabel', 'nodeValue'
    ],
    functions: [
        'Notice', 'setTitle', 'setContent', 'setName', 'setDesc', 'setButtonText',
        'setPlaceholder', 'setTooltip', 'addOption', 'addHeading', 'addText',
        'setHint', 'setWarning', 'setText', 'appendText', 'createEl', 'createDiv',
        'createSpan', 'addCommand', 'insertText', 'replaceRange', 'replaceSelection',
        'log', 'error', 'warn', 'info', 'alert', 'confirm', 'prompt'
    ],
    keys: [
        'name', 'description', 'text', 'placeholder', 'label', 'tooltip', 'title',
        'header', 'desc', 'message', 'buttontext', 'aria-label', 'heading', 'content',
        'tab', 'caption', 'subtitle', 'summary', 'info', 'warning', 'error', 'success',
        'hint', 'instructions', 'link', 'selection', 'annotation', 'search', 'speech',
        'page', 'empty', 'detail', 'body', 'option', 'notice'
    ]
};

export const AST_CLASSIC_REJECT_PATTERNS = [
    "^\\s*$", "^\\d+$", "^[\\w-]+\\.[\\w-]+\\.\\w+$", "^https?:\\/\\/",
    "^data:image\\/", "^#([0-9a-f]{3}|[0-9a-f]{6})$", "^[a-z0-9-]+$",
    "^[a-z]+[A-Z][a-zA-Z0-9]*$", "^[A-Z_][A-Z0-9_]*$", "^px|em|rem|vh|vw|auto$",
    "^rgba?\\(", "^\\.", "\\.(png|jpg|gif|svg|css|js|ts|md|json)$"
];

export const AST_ENHANCED_PROFILE_ID = 'default';
export const AST_CLASSIC_PROFILE_ID = 'classic';
export const AST_ENHANCED_PROFILE_NAME = 'Default (Enhanced)';
export const AST_CLASSIC_PROFILE_NAME = 'Default (Classic)';
export const AST_BUILT_IN_PROFILE_IDS = [AST_ENHANCED_PROFILE_ID, AST_CLASSIC_PROFILE_ID];

/** AST 提取的内容过滤规则 (正则表达式对象) */
export const AST_DEFAULT_RULES = {
    REJECT_PATTERNS: [
        /^\s*$/,                                      // 空白
        /^\d+$/,                                      // 纯数字
        /^[\w-]+\.[\w-]+\.\w+$/,                       // 三段式 ID (如 a.b.c)
        /^https?:\/\//i,                               // URL
        /^data:image\//i,                             // Base64 图片
        /^#([0-9a-f]{3}|[0-9a-f]{6})$/i,               // 十六进制颜色
        /^[a-z0-9]+-[a-z0-9-]+$/,                      // 包含连字符的 kebab-case (通常是 ID)
        /^[a-z]+[A-Z][a-zA-Z0-9]*$/,                   // camelCase (变量名)
        /^[A-Z_][A-Z0-9_]{3,}$/,                       // 长大写常量 (屏蔽如 SETTINGS_MODE，但保留 OK)
        /^(px|em|rem|vh|vw|auto)$/i,                   // CSS 单位
        /^rgba?\(/i,                                   // RGBA 颜色
        /^\./,                                         // 以点开头 (选择器)
        /\.(png|jpg|gif|svg|css|js|ts|md|json)$/i,     // 文件扩展名
        /^[\w.\/\\-]+\/[\w.\/\\-]+$/                   // 文件路径
    ],
    VALID_PATTERNS: [
        /\s/,                                          // 包含空格 (通常是人类语言句子)
        /[^\x00-\x7F]/,                                // 包含非 ASCII 字符 (如中文)
        /[!?,;:。！？，；：]\s*$/                        // 以标点符号结尾
    ]
};

// ============================================================================
// 2. Regex 提取相关配置
// ============================================================================

export const REGEX_DEFAULT_CONFIG = {
    /** 核心匹配正则表达式字符串 (支持转义引号) */
    patterns: [
        "(Notice|log|error|setText|setButtonText|setName|setDesc|setPlaceholder|setTooltip|appendText|setTitle|addHeading|renderMarkdown)\\(\\s*(['\"`])((?:[^\\\\2\\\\\\\\]|\\\\\\\\.)*?)\\2\\s*\\)",
        "(textContent|innerText|name|description|selection|annotation|link|text|search|speech|page|settings)\\s*[:=]\\s*(['\"`])((?:[^\\\\2\\\\\\\\]|\\\\\\\\.)*?)\\2"
    ],
    /** 默认排除正则字符串列表 */
    rejectPatterns: [
        "^\\s*$", "^\\d+$", "^[\\w-]+\\.[\\w-]+\\.\\w+$", "^https?:\\/\\/",
        "^data:image\\/", "^#([0-9a-f]{3}|[0-9a-f]{6})$", "^[a-z0-9]+-[a-z0-9-]+$",
        "^[a-z]+[A-Z][a-zA-Z0-9]*$", "^[A-Z_][A-Z0-9_]{3,}$", "^(px|em|rem|vh|vw|auto)$",
        "^rgba?\\(", "^\\.", "\\.(png|jpg|gif|svg|css|js|ts|md|json)$",
        "^[\\w.\\/\\\\-]+\\/[\\w.\\/\\\\-]+$"
    ],
    /** 默认有效正则字符串列表 */
    validPatterns: [
        "\\s", "[^\\x00-\\x7F]", "[!?,;:。！？，；：]\\s*$"
    ]
};

function makeAstProfile(
    id: string,
    name: string,
    config: typeof AST_DEFAULT_CONFIG,
    maxLength = 300,
    rejectPatterns = REGEX_DEFAULT_CONFIG.rejectPatterns,
) {
    return {
        id,
        name,
        astAssignments: [...config.assignments],
        astFunctions: [...config.functions],
        astKeys: [...config.keys],
        astMaxLength: maxLength,
        astRejectRe: [...rejectPatterns],
        astValidRe: [...REGEX_DEFAULT_CONFIG.validPatterns],
    };
}

export function getBuiltInAstProfiles(maxLength = 300) {
    return [
        makeAstProfile(AST_ENHANCED_PROFILE_ID, AST_ENHANCED_PROFILE_NAME, AST_DEFAULT_CONFIG, maxLength),
        makeAstProfile(AST_CLASSIC_PROFILE_ID, AST_CLASSIC_PROFILE_NAME, AST_CLASSIC_CONFIG, maxLength, AST_CLASSIC_REJECT_PATTERNS),
    ];
}

export interface EffectiveExtractionSettings {
    author: string;
    translationVersion: string;
    reFlags: string;
    reLength: number;
    reDatas: string[];
    reRejectRe: string[];
    reValidRe: string[];
    reExtractionEnabled: boolean;
    chineseSkipMode: 'none' | 'source' | 'extracted';
    astAssignments: string[];
    astFunctions: string[];
    astKeys: string[];
    astMaxLength: number;
    astRejectRe: string[];
    astValidRe: string[];
    astExtractionEnabled: boolean;
}

function pickActiveProfile<T extends { id: string }>(profiles: T[] | undefined, activeId: string | undefined): T | undefined {
    if (!profiles || profiles.length === 0) return undefined;
    return profiles.find(profile => profile.id === activeId) || profiles[0];
}

export function getEffectiveExtractionSettings(settings: any): EffectiveExtractionSettings {
    const reProfile = pickActiveProfile<any>(settings?.reProfiles, settings?.activeReProfileId);
    const astProfile = pickActiveProfile<any>(settings?.astProfiles, settings?.activeAstProfileId);

    return {
        author: settings?.author || '',
        translationVersion: settings?.translationVersion || '1.0.1',
        reFlags: reProfile?.reFlags ?? settings?.reFlags ?? 'gs',
        reLength: reProfile?.reLength ?? settings?.reLength ?? 300,
        reDatas: reProfile?.reDatas ?? settings?.reDatas ?? REGEX_DEFAULT_CONFIG.patterns,
        reRejectRe: reProfile?.reRejectRe ?? settings?.reRejectRe ?? REGEX_DEFAULT_CONFIG.rejectPatterns,
        reValidRe: reProfile?.reValidRe ?? settings?.reValidRe ?? REGEX_DEFAULT_CONFIG.validPatterns,
        reExtractionEnabled: settings?.reExtractionEnabled !== false,
        chineseSkipMode: settings?.chineseSkipMode || 'source',
        astAssignments: astProfile?.astAssignments ?? settings?.astAssignments ?? AST_DEFAULT_CONFIG.assignments,
        astFunctions: astProfile?.astFunctions ?? settings?.astFunctions ?? AST_DEFAULT_CONFIG.functions,
        astKeys: astProfile?.astKeys ?? settings?.astKeys ?? AST_DEFAULT_CONFIG.keys,
        astMaxLength: astProfile?.astMaxLength ?? settings?.astMaxLength ?? 300,
        astRejectRe: astProfile?.astRejectRe ?? settings?.astRejectRe ?? REGEX_DEFAULT_CONFIG.rejectPatterns,
        astValidRe: astProfile?.astValidRe ?? settings?.astValidRe ?? REGEX_DEFAULT_CONFIG.validPatterns,
        astExtractionEnabled: settings?.astExtractionEnabled !== false,
    };
}

export function syncExtractionProfileFields(settings: any): boolean {
    let modified = false;

    if (!settings.translationVersion) {
        settings.translationVersion = '1.0.1';
        modified = true;
    }

    if (!Array.isArray(settings.reProfiles) || settings.reProfiles.length === 0) {
        settings.reProfiles = [{
            id: 'default',
            name: 'Default',
            reFlags: settings.reFlags || 'gs',
            reLength: settings.reLength ?? 300,
            reDatas: settings.reDatas || REGEX_DEFAULT_CONFIG.patterns,
            reRejectRe: settings.reRejectRe || REGEX_DEFAULT_CONFIG.rejectPatterns,
            reValidRe: settings.reValidRe || REGEX_DEFAULT_CONFIG.validPatterns,
        }];
        settings.activeReProfileId = 'default';
        modified = true;
    }
    if (!settings.activeReProfileId || !settings.reProfiles.some((profile: any) => profile.id === settings.activeReProfileId)) {
        settings.activeReProfileId = settings.reProfiles[0].id;
        modified = true;
    }
    if (settings.reExtractionEnabled === undefined) {
        settings.reExtractionEnabled = true;
        modified = true;
    }

    if (!Array.isArray(settings.astProfiles) || settings.astProfiles.length === 0) {
        settings.astProfiles = getBuiltInAstProfiles(settings.astMaxLength ?? 300);
        settings.activeAstProfileId = AST_ENHANCED_PROFILE_ID;
        modified = true;
    }
    const builtInAstProfiles = getBuiltInAstProfiles(settings.astMaxLength ?? 300);
    for (const builtInProfile of builtInAstProfiles) {
        const existing = settings.astProfiles.find((profile: any) => profile.id === builtInProfile.id);
        if (!existing) {
            settings.astProfiles.push(builtInProfile);
            modified = true;
            continue;
        }
        if (existing.name === 'Default' || !existing.name) {
            existing.name = builtInProfile.name;
            modified = true;
        }
    }
    if (!settings.activeAstProfileId || !settings.astProfiles.some((profile: any) => profile.id === settings.activeAstProfileId)) {
        settings.activeAstProfileId = settings.astProfiles[0].id;
        modified = true;
    }
    if (settings.astExtractionEnabled === undefined) {
        settings.astExtractionEnabled = true;
        modified = true;
    }

    const effective = getEffectiveExtractionSettings(settings);
    const legacyFields: Record<string, any> = {
        reFlags: effective.reFlags,
        reLength: effective.reLength,
        reDatas: effective.reDatas,
        reRejectRe: effective.reRejectRe,
        reValidRe: effective.reValidRe,
        astAssignments: effective.astAssignments,
        astFunctions: effective.astFunctions,
        astKeys: effective.astKeys,
        astMaxLength: effective.astMaxLength,
        astRejectRe: effective.astRejectRe,
        astValidRe: effective.astValidRe,
    };

    for (const [key, value] of Object.entries(legacyFields)) {
        if (settings[key] !== value) {
            settings[key] = value;
            modified = true;
        }
    }

    return modified;
}
