/**
 * 文件名称: kiss-core-smoke.ts
 * 模块描述: kiss 翻译核心的 Node 端集成冒烟测试
 * 验证链路: KissTranslationService -> kiss apiTranslate (Microsoft 免费接口)
 *          -> fetchPatcher(Obsidian 分支) -> obsidianFetch -> requestUrl 桩(Node fetch)
 * 运行方式: 先用 esbuild 打包（alias:obsidian -> tests/stubs/obsidian-stub.cjs），再 node 执行
 */

import { useGlobalStoreInstance } from "../src/utils/store/global";
import { KissTranslationService } from "../src/imt/kiss/kiss-translation-service";

const STOKEY_SETTING = "KISS-Translator_setting_v2";

async function main(): Promise<void> {
    // 1. 注入假插件实例，kiss 存储适配器读写 settings.kissStorage
    const fakeI18n: any = {
        settings: { kissStorage: {} },
        saveSettings: async () => {},
    };
    useGlobalStoreInstance.getState().setI18n(fakeI18n);

    // 2. 预置 kiss 设置：选中 Microsoft 免费接口（无需 Key），目标中文
    fakeI18n.settings.kissStorage[STOKEY_SETTING] = JSON.stringify({
        selectedApiSlug: "Microsoft",
        selectedToLang: "zh-CN",
    });

    // 3. 执行翻译
    const service = new KissTranslationService();
    const texts = [
        "Settings",
        "Enable plugin",
        "The quick brown fox jumps over the lazy dog.",
    ];
    const map = await service.translate(texts, (done, total) => {
        console.log(`progress: ${done}/${total}`);
    });

    let ok = 0;
    for (const text of texts) {
        const translated = map.get(text) ?? "";
        const changed = translated !== text;
        if (changed) ok++;
        console.log(`${JSON.stringify(text)} => ${JSON.stringify(translated)}${changed ? "" : "  (回退原文)"}`);
    }

    if (ok === 0) {
        throw new Error("所有条目均未获得译文，冒烟测试失败");
    }
    console.log(`SMOKE OK: ${ok}/${texts.length} 条翻译成功`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error("SMOKE FAILED:", error);
        process.exit(1);
    });
