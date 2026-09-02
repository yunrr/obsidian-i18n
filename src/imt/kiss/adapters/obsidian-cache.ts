/**
 * 文件名称: obsidian-cache.ts
 * 模块描述: kiss 核心翻译缓存层的 Obsidian 适配器
 * 核心功能:
 *   - 以内存 Map 模拟 kiss 使用的 CacheStorage（Obsidian app:// 源下不可靠）
 *   - 键 = 请求 URL + init 序列化，值 = 已解析的响应数据 + 过期时间
 *
 * 注意事项:
 *   - 会话级缓存，插件重载后清空；kiss 的 apiTranslate 上层会自动命中
 *   - 后续如需持久化，可把该表挂到插件数据上
 */

interface CacheEntry {
    data: any;
    expires: number;
}

const memoryCache = new Map<string, CacheEntry>();

/** 由请求 URL 与 init 生成确定性缓存键 */
const toCacheKey = (input: string, init?: any): string =>
    `${input}|${init ? JSON.stringify(init) : ""}`;

export const obsidianCacheGet = async (
    input: string,
    init?: any
): Promise<any | null> => {
    const key = toCacheKey(input, init);
    const entry = memoryCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires) {
        memoryCache.delete(key);
        return null;
    }
    return entry.data;
};

export const obsidianCachePut = async (
    input: string,
    init: any,
    data: any,
    maxAgeSeconds: number
): Promise<void> => {
    memoryCache.set(toCacheKey(input, init), {
        data,
        expires: Date.now() + maxAgeSeconds * 1000,
    });
};

export const obsidianCacheClear = (): void => {
    memoryCache.clear();
};
