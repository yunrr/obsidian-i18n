/**
 * 翻译源类型定义 (扁平化结构 v2)
 */

export interface TranslationSource {
    // 主键
    id: string;                    // 唯一标识 (8位随机字符串)

    // 核心识别信息
    plugin: string;                // 所属插件ID

    // UI 展示信息
    title: string;                 // 译文标题

    // 来源与状态
    type: 'plugin' | 'theme';      // 翻译目标类型
    origin: 'cloud' | 'local';     // 来源类型
    isActive: boolean;             // 是否为当前激活的翻译源（UI选中）
    checksum: string;              // 翻译内容的校验值 (本地和云端都有)
    translationVersion?: string;   // 本地索引：译文版本 metadata.version
    supportedVersions?: string;    // 本地索引：兼容版本 metadata.supportedVersions
    language?: string;             // 本地索引：语言 metadata.language
    metadataIndexedAt?: number;    // 本地索引更新时间

    // 云端元数据
    cloud?: {
        owner: string;             // 仓库所有者
        repo: string;              // 仓库名称
        hash: string;              // 下载时的远端 hash (用于更新检测)
    };

    // 时间戳
    createdAt: number;
    updatedAt: number;
}

/**
 * 翻译源元数据 (扁平化结构)
 * - sources: 以 sourceId 为键的扁平映射
 */
export interface TranslationSourceMeta {
    schemaVersion: number;
    sources: Record<string, TranslationSource>;
}

export type BatchTaskScope = 'plugin' | 'theme';
export type BatchTaskMode = 'extract' | 'translate';
export type BatchTaskFailureKind = 'ast' | 'regex' | 'theme';

export interface BatchTaskCheckpointResource {
    resourceId: string;
    label: string;
    sourceId?: string | null;
}

export interface BatchTaskCheckpoint {
    scope: BatchTaskScope;
    mode: BatchTaskMode;
    resources: BatchTaskCheckpointResource[];
    totalResources: number;
    completedResources: number;
    totalItems: number;
    processedItems: number;
    stoppedAt: number;
}

export interface BatchTaskFailureItemDescriptor {
    source: string;
    target: string;
    dictIndex: number;
    file?: string;
    type?: string;
    name?: string;
}

export interface BatchTaskFailureRecord {
    id: string;
    scope: BatchTaskScope;
    resourceId: string;
    resourceLabel: string;
    sourceId: string;
    batchType: BatchTaskFailureKind;
    errorMessage: string;
    items: BatchTaskFailureItemDescriptor[];
    failedAt: number;
}

export interface BatchTaskRecordMeta {
    schemaVersion: number;
    checkpoints: Record<string, BatchTaskCheckpoint>;
    failures: BatchTaskFailureRecord[];
    updatedAt: number;
}

export const EMPTY_META: TranslationSourceMeta = {
    schemaVersion: 2,
    sources: {}
};

export const EMPTY_BATCH_TASK_RECORD: BatchTaskRecordMeta = {
    schemaVersion: 1,
    checkpoints: {},
    failures: [],
    updatedAt: 0
};
