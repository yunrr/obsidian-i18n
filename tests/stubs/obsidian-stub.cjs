/**
 * Node 端 obsidian 模块桩：仅供 kiss 核心集成冒烟测试使用。
 * requestUrl 用 Node 原生 fetch 真实发请求（Node 无 CORS 概念），
 * 其余 obsidian 导出用宽容的万能桩兜底（class extends / new / 属性访问均可）。
 */

function universalStub() {
    return universalStub;
}
universalStub.locale = () => "en";
universalStub.isMobile = false;
universalStub.defineLocale = () => {};

const realRequestUrl = async ({ url, method = "GET", headers = {}, body }) => {
    const res = await fetch(url, { method, headers, body, redirect: "follow" });
    const buffer = await res.arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        text,
        json: JSON.parse(text),
        arrayBuffer: async () => buffer,
    };
};

module.exports = new Proxy(
    { requestUrl: realRequestUrl },
    {
        get(target, prop) {
            if (prop in target) return target[prop];
            if (prop === "__esModule") return false;
            return universalStub;
        },
    }
);
