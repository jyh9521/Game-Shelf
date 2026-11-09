"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { fieldLabels, metadataFields, providerLabels, providerLink, type CoverPagination, type Metadata, type MetadataField, type Preview, type PreviewResult, type Provider, type ProviderStatus, type SearchHit } from "@/lib/metadata-domain";

export function SourceLink({ provider, id }: { provider: Provider; id?: string }) {
  return <a href={providerLink(provider, id)} target="_blank" rel="noreferrer">{providerLabels[provider]}</a>;
}

function CoverPager({ pagination, disabled, bottom = false, onChange }: {
  pagination: CoverPagination; disabled: boolean; bottom?: boolean; onChange: (page: number) => void;
}) {
  const { page, totalPages, hasNext } = pagination;
  return <nav className="metadata-cover-pagination" aria-label={bottom ? "封面分页（底部）" : "封面分页（顶部）"}>
    <button type="button" disabled={disabled || page === 0} onClick={() => onChange(page - 1)}>上一页</button>
    <span aria-live={bottom ? undefined : "polite"}>第 {page + 1}{totalPages !== null && totalPages > page ? " / " + totalPages : ""} 页</span>
    <button type="button" disabled={disabled || !hasNext} onClick={() => onChange(page + 1)}>下一页</button>
  </nav>;
}

export function MetadataLookup({ title, draft, protectedFields, disabled, onStage }: {
  title: string; draft: Metadata; protectedFields: Set<MetadataField>; disabled: boolean;
  onStage: (preview: Preview, fields: MetadataField[], replaceCover?: boolean) => void;
}) {
  const [services, setServices] = useState<ProviderStatus[] | null>(null);
  const [provider, setProvider] = useState<Provider | "">("");
  const [query, setQuery] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [active, setActive] = useState<SearchHit | null>(null);
  const [checked, setChecked] = useState<MetadataField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const panel = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  const gallery = useRef<HTMLElement>(null);
  const coverHeading = useRef<HTMLHeadingElement>(null);
  const previews = preview?.items ?? null;
  const pagination = preview?.pagination;
  const pager = pagination && (pagination.page > 0 || pagination.hasNext) ? pagination : null;
  const showingCovers = previews !== null && active !== null && provider === "steamgriddb";
  const loading = disabled || busy;
  useEffect(() => {
    if (provider === "steamgriddb" && preview && panel.current?.open) {
      coverHeading.current?.focus({ preventScroll: true });
      gallery.current?.scrollIntoView({ block: "start" });
    }
  }, [provider, preview, error]);

  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  const load = () => work(async () => {
    const { providers } = await api<{ providers: ProviderStatus[] }>("metadata/providers");
    setServices(providers);
    setProvider(providers.find(p => p.enabled)?.id ?? "");
  });
  function resetResults() { setHits(null); setActive(null); setPreview(null); setChecked([]); setNotice(""); setError(""); }
  const search = () => {
    const value = (query ?? title.slice(0, 150)).trim();
    if (loading || !provider || !value) return;
    resetResults();
    void work(async () => setHits((await api<{ items: SearchHit[] }>("metadata/search", "POST", { provider, query: value })).items));
  };
  const select = (hit: SearchHit) => {
    if (loading || !provider) return;
    setActive(hit);
    setPreview(null);
    void work(async () => {
      const result = await api<PreviewResult>("metadata/preview", "POST", { provider, id: hit.id });
      setPreview(result);
      setChecked(metadataFields.filter(field => !!result.items[0]?.candidate.fields[field]));
    });
  };
  const goToCoverPage = (page: number) => {
    if (loading || !active || provider !== "steamgriddb") return;
    void work(async () => setPreview(await api<PreviewResult>("metadata/preview", "POST", { provider, id: active.id, page })));
  };
  const stage = (p: Preview, fields: MetadataField[]) => {
    onStage(p, fields);
    setNotice("已暂存 " + fields.length + " 个字段，保存游戏后生效。");
  };
  const pickCover = (p: Preview) => {
    const replacingProtected = protectedFields.has("coverUrl");
    if (replacingProtected && !confirm("当前封面已锁定或在本次编辑中手动修改。用选中的图片替换它？保存后生效。")) return;
    onStage(p, ["coverUrl"], replacingProtected);
    if (panel.current) panel.current.open = false;
    summary.current?.focus();
  };

  return <details ref={panel} className="metadata-panel" onToggle={e => {
    if (e.currentTarget.open && services === null && !busy) void load();
  }}>
    <summary ref={summary}>查找外部资料或封面</summary>
    {error && !showingCovers && <p className="error" role="alert">{error}</p>}
    {services === null && <p className="muted">{busy ? "正在读取资料源…" : <button type="button" onClick={() => void load()}>重新读取资料源</button>}</p>}
    {services && !provider && <p className="muted">容器未配置外部资料源，仍可手动填写。配置方式见部署文档。</p>}
    {services && !!provider && <>
      <p className="muted">{provider === "steamgriddb" ? "先选作品，再选竖版封面。替换已锁定的封面时需要确认；保存游戏后生效。" :
        "资料候选不会自动覆盖已锁定或本次手动改过的字段。"}</p>
      <div className="metadata-search">
        <label>资料源<select value={provider} disabled={loading} onChange={e => { setProvider(e.target.value as Provider); resetResults(); }}>
          {services.map(s => <option key={s.id} value={s.id} disabled={!s.enabled}>{providerLabels[s.id]}{s.enabled ? "" : "（未配置）"}</option>)}
        </select></label>
        <label>外部搜索标题<input value={query ?? title.slice(0, 150)} maxLength={150} disabled={loading}
          onChange={e => { setQuery(e.target.value); resetResults(); }}
          onKeyDown={e => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); search(); } }}/></label>
        <button type="button" onClick={search} disabled={loading || !(query ?? title).trim()}>搜索外部资料</button>
      </div>
      {busy && <p className="muted" role="status">正在查询 {providerLabels[provider]}…</p>}
      {hits && !hits.length && <p className="muted">没有找到匹配作品，可换用原名、调整关键词或改用其他已配置来源。</p>}
      {!!hits?.length && <div className="metadata-hits" aria-label="候选作品">
        {hits.map(hit => <button key={hit.id} type="button" aria-pressed={active?.id === hit.id} disabled={loading} onClick={() => select(hit)}>
          <strong>{hit.title}</strong>
          <small>{[...hit.platforms, hit.date, hit.region, hit.kind, "ID " + hit.id].filter(Boolean).join(" · ")}</small>
        </button>)}
      </div>}
      {previews && !previews.length && provider !== "steamgriddb" && <p className="muted">该条目暂无可导入的字段。</p>}
      {showingCovers && <section ref={gallery} className="metadata-cover-panel" aria-label="SteamGridDB 封面候选" aria-busy={busy}>
        <div className="metadata-cover-heading"><h3 ref={coverHeading} tabIndex={-1}>选择封面</h3><small>本页 {previews.length} 张竖版封面</small></div>
        {pager && <CoverPager pagination={pager} disabled={loading} onChange={goToCoverPage}/>}
        {error && <p className="error" role="alert">{error}</p>}
        {!previews.length && <p className="muted">{pager ? "本页暂无可导入的竖版封面，可以切换到其他页。" : "该条目暂无可导入的竖版封面，可以尝试同名的其他版本。"}</p>}
        {!!previews.length && <div className="metadata-covers">
          {previews.map((p, i) => {
            const number = i + 1 + (pagination ? pagination.page * pagination.pageSize : 0);
            return <figure key={p.candidate.externalId}>
              <img src={p.image?.thumbnail} alt={active.title + " 候选封面 " + number} loading="lazy" referrerPolicy="no-referrer"
                onError={e => {
                  const full = p.candidate.fields.coverUrl;
                  if (full && e.currentTarget.src !== full) e.currentTarget.src = full;
                }}/>
              <figcaption><SourceLink provider={provider} id={p.candidate.externalId}/>{p.image?.width && p.image.height ? " · " + p.image.width + "×" + p.image.height : " · 竖版"}</figcaption>
              <button type="button" disabled={loading} onClick={() => pickCover(p)}>选择封面 {number}</button>
            </figure>;
          })}
        </div>}
        {pager && !!previews.length && <CoverPager pagination={pager} disabled={loading} onChange={goToCoverPage} bottom/>}
        <a href={"https://www.steamgriddb.com/game/" + encodeURIComponent(active.id) + "/grids"} target="_blank" rel="noreferrer">在 SteamGridDB 查看该条目</a>
      </section>}
      {!!previews?.length && provider !== "steamgriddb" && <div className="metadata-preview">
        <p>来自 <SourceLink provider={provider} id={previews[0].candidate.externalId}/> 的候选字段</p>
        {active?.date && <p className="muted">来源发行日期：{active.date}（仅供辨认作品，拥有版本仍由你确认）</p>}
        {metadataFields.filter(field => !!previews[0].candidate.fields[field]).map(field => <div key={field} className="metadata-option">
          <label className="check"><input type="checkbox" disabled={loading} checked={checked.includes(field)}
            onChange={e => setChecked(current => e.target.checked ? [...current, field] : current.filter(f => f !== field))}/>
            {fieldLabels[field]}{protectedFields.has(field) ? "（仅保存候选）" : ""}
          </label>
          <div className="metadata-value">{previews[0].candidate.fields[field]}</div>
          {!!draft[field] && draft[field] !== previews[0].candidate.fields[field] && <small className="muted">当前：{draft[field].slice(0, 90)}{draft[field].length > 90 ? "…" : ""}</small>}
        </div>)}
        <button type="button" disabled={loading || !checked.length} onClick={() => stage(previews[0], checked)}>暂存所选字段</button>
      </div>}
      {hits?.length ? <p className="muted">作品搜索结果来自 <SourceLink provider={provider}/>，最多显示 12 个作品。请核对同名游戏与不同版本。</p> : null}
      {notice && <p className="muted" role="status">{notice}</p>}
    </>}
  </details>;
}
