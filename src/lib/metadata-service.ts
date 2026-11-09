import { randomUUID } from "node:crypto";
import { MetadataError, ProviderHttp } from "./metadata-http";
import { makeAdapters, type Detail } from "./metadata-providers";
import { providers, providerLabels, type Provider, type Candidate, type FieldSources, type Preview, type SearchHit, type Selection } from "./metadata-domain";

type Cached<T> = { data: T; collectedAt: string };
class ExpiringMap<T> {
  private entries = new Map<string, { value: T; until: number }>();
  constructor(private max: number, private ttl: number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.until <= Date.now()) { this.entries.delete(key); return; }
    return entry.value;
  }
  set(key: string, value: T, ttl = this.ttl) {
    this.entries.delete(key);
    this.entries.set(key, { value, until: Date.now() + ttl });
    if (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}

type Bucket = { count: number; until: number };
export class MetadataService {
  private adapters;
  private searchCache = new ExpiringMap<Cached<SearchHit[]>>(128, 180000);
  private previewCache = new ExpiringMap<Cached<Detail[]>>(128, 180000);
  private tokens = new ExpiringMap<{ userId: string; candidate: Candidate }>(600, 1200000);
  private userRates = new ExpiringMap<Bucket>(500, 60000);
  private providerRates = new ExpiringMap<Bucket>(providers.length, 60000);
  private cooldowns = new Map<Provider, number>();
  private pending = new Map<Provider, { key: string; result: Promise<Cached<unknown[]>> }>();

  constructor(env: Readonly<Record<string, string | undefined>>, fetcher: typeof fetch) {
    this.adapters = makeAdapters(env, new ProviderHttp(fetcher));
  }
  status() { return providers.map(id => ({ id, enabled: !!this.adapters[id] })); }

  private charge(rates: ExpiringMap<Bucket>, key: string, limit: number) {
    const now = Date.now();
    const rate = rates.get(key);
    if (rate && rate.until > now) {
      if (rate.count >= limit) throw new MetadataError(429, "查询过于频繁，请稍后再试。", rate.until);
      rate.count++;
    } else rates.set(key, { count: 1, until: now + 60000 });
  }
  private adapter(id: Provider) {
    const adapter = this.adapters[id];
    if (!adapter) throw new MetadataError(409, providerLabels[id] + " 尚未在容器中配置。");
    return adapter;
  }
  private async query<T>(id: Provider, key: string, cache: ExpiringMap<Cached<T[]>>, work: () => Promise<T[]>): Promise<Cached<T[]>> {
    const cached = cache.get(key);
    if (cached) return cached;
    const retryAt = this.cooldowns.get(id);
    if (retryAt && retryAt > Date.now()) throw new MetadataError(429, providerLabels[id] + " 正在等待调用额度恢复。", retryAt);
    const active = this.pending.get(id);
    if (active?.key === key) return active.result as Promise<Cached<T[]>>;
    if (active) throw new MetadataError(429, providerLabels[id] + " 正在处理另一条查询，请稍后再试。", Date.now() + 1000);
    this.charge(this.providerRates, id, 20);
    const result = (async () => {
      try {
        const data = await work();
        const value = { data, collectedAt: new Date().toISOString() };
        cache.set(key, value, data.length ? undefined : 30000);
        return value;
      } catch (error) {
        if (error instanceof MetadataError && error.retryAt) this.cooldowns.set(id, error.retryAt);
        throw error;
      } finally { this.pending.delete(id); }
    })();
    this.pending.set(id, { key, result });
    return result;
  }

  async search(userId: string, provider: Provider, query: string) {
    const adapter = this.adapter(provider);
    this.charge(this.userRates, userId, 40);
    if (/^\.+$/.test(query)) return [];
    return (await this.query(provider, "search:" + provider + ":" + query, this.searchCache, () => adapter.search(query))).data;
  }
  async preview(userId: string, provider: Provider, id: string): Promise<Preview[]> {
    const adapter = this.adapter(provider);
    this.charge(this.userRates, userId, 40);
    const { data, collectedAt } = await this.query(provider, "preview:" + provider + ":" + id, this.previewCache, () => adapter.preview(id));
    return data.map(detail => {
      const candidate = { provider, externalId: detail.id, fields: detail.fields, collectedAt };
      const token = randomUUID();
      this.tokens.set(token, { userId, candidate });
      return { candidate, token, image: detail.image };
    });
  }
  resolve(userId: string, selections: Selection[]): FieldSources {
    const selected: FieldSources = {};
    for (const selection of selections) {
      const entry = this.tokens.get(selection.token);
      if (!entry || entry.userId !== userId) throw new MetadataError(409, "候选已失效，请重新预览外部资料。");
      const { provider, externalId, fields, collectedAt } = entry.candidate;
      for (const field of selection.fields) {
        if (!fields[field] || selected[field]) throw new MetadataError(400, "候选不包含该字段，或重复选择了同一个字段。");
        selected[field] = { provider, externalId, value: fields[field], collectedAt };
      }
    }
    return selected;
  }
}

let service: MetadataService | undefined;
export function metadataService() {
  // Runtime env only: credentials never enter a client module or build args.
  return service ??= new MetadataService(process.env, (...args) => fetch(...args));
}
