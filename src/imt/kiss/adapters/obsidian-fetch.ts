/**
 * 文件名称: obsidian-fetch.ts
 * 模块描述: kiss 核心网络层的 Obsidian 适配器
 * 核心功能:
 *   - 用 Obsidian requestUrl 绕过渲染进程的 CORS 限制
 *   - 返回标准 Response 对象，kiss 的 parseResponse 无需改动即可消费
 *   - 以竞态方式响应 AbortSignal（requestUrl 本身不支持取消）
 */

import { requestUrl } from "obsidian";

/** 将各类 headers 形态归一化为普通对象 */
const normalizeHeaders = (raw: any): Record<string, string> => {
    const headers: Record<string, string> = {};
    if (!raw) return headers;
    if (raw instanceof Headers) {
        raw.forEach((value, key) => { headers[key] = value; });
    } else if (Array.isArray(raw)) {
        raw.forEach(([key, value]) => { headers[key] = String(value); });
    } else {
        Object.entries(raw).forEach(([key, value]) => { headers[key] = String(value); });
    }
    return headers;
};

/**
 * 发起请求并包装为标准 Response
 * @param input 请求 URL（string 或 Request）
 * @param init 标准 fetch init（method/headers/body/signal）
 */
export const obsidianFetch = async (input: any, init: any = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input?.url ?? String(input);
    const method = (init.method || "GET").toUpperCase();
    const headers = normalizeHeaders(init.headers);

    let body: string | undefined;
    if (init.body != null && method !== "GET" && method !== "HEAD") {
        if (typeof init.body === "string") {
            body = init.body;
        } else if (init.body instanceof URLSearchParams) {
            body = init.body.toString();
            headers["Content-Type"] = headers["Content-Type"] || "application/x-www-form-urlencoded;charset=UTF-8";
        } else if (init.body instanceof ArrayBuffer) {
            body = new TextDecoder().decode(new Uint8Array(init.body));
        } else if (ArrayBuffer.isView(init.body)) {
            body = new TextDecoder().decode(new Uint8Array((init.body as any).buffer, (init.body as any).byteOffset, (init.body as any).byteLength));
        } else {
            body = String(init.body);
        }
    }

    const signal: AbortSignal | undefined = init.signal;
    if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
    }

    const request = requestUrl({
        url,
        method,
        headers,
        body,
        throw: false,
    });

    // requestUrl 不支持外部取消；用竞态让上层能及时拿到中止错误
    if (signal) {
        let onAbort: (() => void) | null = null;
        const abortPromise = new Promise<never>((_, reject) => {
            onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
            signal.addEventListener("abort", onAbort, { once: true });
        });
        try {
            const res = await Promise.race([request, abortPromise]);
            return new Response(res.text, { status: res.status, headers: res.headers });
        } finally {
            if (onAbort) signal.removeEventListener("abort", onAbort);
        }
    }

    const res = await request;
    return new Response(res.text, { status: res.status, headers: res.headers });
};
