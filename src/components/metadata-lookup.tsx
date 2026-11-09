"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import { fieldLabels, metadataFields, providerLabels, providerLink, type Metadata, type MetadataField, type Preview, type Provider, type ProviderStatus, type SearchHit } from "@/lib/metadata-domain";

export function SourceLink({ provider, id }: { provider: Provider; id?: string }) {
  return <a href={providerLink(provider, id)} target="_blank" rel="noreferrer">{providerLabels[provider]}</a>;
}

export function MetadataLookup({ title, draft, protectedFields, disabled, onStage }: {
  title: string; draft: Metadata; protectedFields: Set<MetadataField>; disabled: boolean;
  onStage: (preview: Preview, fields: MetadataField[], replaceCover?: boolean) => void;
}) {
  const [services, setServices] = useState<ProviderStatus[] | null>(null);
  const [provider, setProvider] = useState<Provider | "">("");
  const [query, setQuery] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [active, setActive] = useState<SearchHit | null>(null);
  const [checked, setChecked] = useState<MetadataField[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const gallery = useRef<HTMLElement>(null);
  const loading = disabled || busy;
  useEffect(() => {
    if (provider === "steamgriddb" && previews !== null) gallery.current?.scrollIntoView({ block: "nearest" });
  }, [provider, previews]);

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
  function resetResults() { setHits(null); setActive(null); setPreviews(null); setChecked([]); setNotice(""); setError(""); }
  const search = () => {
    const value = (query ?? title.slice(0, 150)).trim();
    if (loading || !provider || !value) return;
    resetResults();
    void work(async () => setHits((await api<{ items: SearchHit[] }>("metadata/search", "POST", { provider, query: value })).items));
  };
  const select = (hit: SearchHit) => {
    setActive(hit);
    setPreviews(null);
    void work(async () => {
      const { items } = await api<{ items: Preview[] }>("metadata/preview", "POST", { provider, id: hit.id });
      setPreviews(items);
      setChecked(metadataFields.filter(field => !!items[0]?.candidate.fields[field]));
    });
  };
  const stage = (p: Preview, fields: MetadataField[], replaceCover = false) => {
    onStage(p, fields, replaceCover);
    setNotice(provider === "steamgriddb" ? "已选封面，保存游戏后生效。" : "已暂存 " + fields.length + " 个字段，保存游戏后生效。");
  };
  const pickCover = (p: Preview) => {
    const replacingProtected = protectedFields.has("coverUrl");
    if (replacingProtected && !confirm("当前封面已锁定或在本次编辑中手动修改。用选中的图片替换它？保存后生效。")) return;
    stage(p, ["coverUrl"], replacingProtected);
  };

  return <details className="metadata-panel" onToggle={e => {
    if (e.currentTarget.open && services === null && !busy) void load();
  }}>
    <summary>查找外部资料或封面</summary>
    {error && <p className="error" role="alert">{error}</p>}
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
      {previews !== null && active && provider === "steamgriddb" && <section ref={gallery} className="metadata-cover-panel" aria-label="SteamGridDB 封面候选">
        <div className="metadata-cover-heading"><h3>选择封面</h3><small>{previews.length} 张竖版封面</small></div>
        {!previews.length && <p className="muted">该条目暂无可导入的竖版封面，可以尝试同名的其他版本。</p>}
        {!!previews.length && <div className="metadata-covers">
          {previews.map((p, i) => <figure key={p.candidate.externalId}>
            <img src={p.image?.thumbnail} alt={active.title + " 候选封面 " + (i + 1)} loading="lazy" referrerPolicy="no-referrer"
              onError={e => {
                const full = p.candidate.fields.coverUrl;
                if (full && e.currentTarget.src !== full) e.currentTarget.src = full;
              }}/>
            <figcaption><SourceLink provider={provider} id={p.candidate.externalId}/>{p.image?.width && p.image.height ? " · " + p.image.width + "×" + p.image.height : " · 竖版"}</figcaption>
            <button type="button" disabled={loading} onClick={() => pickCover(p)}>选择封面 {i + 1}</button>
          </figure>)}
        </div>}
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
      {hits?.length ? <p className="muted">结果来自 <SourceLink provider={provider}/>，最多显示 12 项。请核对同名游戏与不同版本。</p> : null}
      {notice && <p className="muted" role="status">{notice}</p>}
    </>}
  </details>;
}
