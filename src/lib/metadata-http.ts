import { providerLabels, type Provider } from "./metadata-domain";

export class MetadataError extends Error {
  constructor(public status: number, message: string, public retryAt?: number, public upstreamStatus?: number) { super(message); }
}

const maxBytes = 4 * 1024 * 1024;
type HttpProvider = Provider | "steam" | "gemini";
const labelOf = (provider: HttpProvider) =>
  provider === "steam" ? "Steam" : provider === "gemini" ? "Gemini" : providerLabels[provider];

export class ProviderHttp {
  private lastIgdbRequest = 0;
  constructor(private fetcher: typeof fetch) {}

  async json(provider: HttpProvider, url: string | URL, init: RequestInit = {}, notFound = false): Promise<unknown> {
    const label = labelOf(provider);
    if (provider === "igdb" && new URL(url).hostname === "api.igdb.com") {
      const delay = this.lastIgdbRequest + 275 - Date.now();
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
      this.lastIgdbRequest = Date.now();
    }
    try {
      const response = await this.fetcher(url, {
        ...init, cache: "no-store", redirect: "error",
        signal: AbortSignal.timeout(provider === "gemini" ? 30_000 : 6500)
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (notFound && response.status === 404) return null;
        throw upstreamError(provider, response.status, response.headers.get("Retry-After"));
      }
      const reader = response.body?.getReader();
      if (!reader || Number(response.headers.get("Content-Length")) > maxBytes) {
        if (reader) await reader.cancel();
        throw invalidResponse(provider);
      }
      const decoder = new TextDecoder();
      let total = 0, data = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw invalidResponse(provider);
        }
        data += decoder.decode(value, { stream: true });
      }
      try { return JSON.parse(data + decoder.decode()); }
      catch { throw invalidResponse(provider); }
    } catch (error) {
      if (error instanceof MetadataError) throw error;
      // Never expose the upstream URL, headers, or body. Several providers
      // require credentials in query parameters and may echo them on errors.
      if (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name)) {
        throw new MetadataError(504, label + " 响应超时，请稍后再试。");
      }
      throw new MetadataError(502, label + " 暂时无法连接，请稍后再试。");
    }
  }
}

export const invalidResponse = (provider: HttpProvider) =>
  new MetadataError(502, labelOf(provider) + " 返回了无法识别的资料。");

export function upstreamError(provider: HttpProvider, status: number, retryAfter?: string | null) {
  const label = labelOf(provider);
  if (provider === "gemini" && status === 404)
    return new MetadataError(502, "Gemini 模型不可用，请检查 GEMINI_MODEL 与账号可用模型。");
  if (status === 429 || (provider === "screenscraper" && status === 430)) {
    const now = Date.now();
    const parsed = retryAfter?.trim() && (/^\d+$/.test(retryAfter.trim()) ? now + Number(retryAfter) * 1000 : Date.parse(retryAfter));
    const retryAt = parsed && Number.isFinite(parsed) && parsed > now ? parsed : now + (status === 430 ? 900000 : 30000);
    return new MetadataError(429, label + " 已达到调用额度，请稍后再试。", retryAt);
  }
  if (status === 401 || status === 403) {
    return new MetadataError(502, label + " 拒绝了请求，请检查容器凭据或服务额度。", undefined, status);
  }
  return new MetadataError(502, label + " 暂时不可用，请稍后再试。");
}
