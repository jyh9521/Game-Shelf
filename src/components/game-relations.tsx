"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/client-api";
import { relationTypes, relationLabels, inverseRelationLabels, type RelationType } from "@/lib/relation-domain";

type Title = { id: string; title: string; localizedTitle: string };
type Relation = {
  id: string; sourceGameId: string; targetGameId: string; type: RelationType; note: string;
  source: Title; target: Title;
};
type History = Relation & { action: "CREATE" | "UPDATE" | "DELETE"; revision: number; createdAt: string };
type Data = { relations: Relation[]; history: History[] };
type Candidate = Title & { originalTitle: string; releases: { releaseDate: string; platform: { name: string }; contents: unknown[] }[] };
const title = (game: Title) => game.localizedTitle || game.title;
const actions = { CREATE: "建立", UPDATE: "修改", DELETE: "解除" };

export function GameRelations({ game, disabled, onBusyChange, onOpen }: {
  game: Title; disabled: boolean; onBusyChange: (busy: boolean) => void; onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<Data | null>(null), [error, setError] = useState("");
  const [editing, setEditing] = useState<Relation | "new" | null>(null);
  const [type, setType] = useState<RelationType>("REMAKE_OF"), [note, setNote] = useState("");
  const [q, setQ] = useState(""), [page, setPage] = useState(1), [pages, setPages] = useState(1);
  const [candidates, setCandidates] = useState<Candidate[]>([]), [selected, setSelected] = useState<Candidate | null>(null);
  const [searching, setSearching] = useState(false);
  const reload = useCallback(async () => setData(await api<Data>(`games/${game.id}/relations`)), [game.id]);
  useEffect(() => {
    let active = true;
    api<Data>(`games/${game.id}/relations`).then(value => { if (active) setData(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [game.id]);
  useEffect(() => {
    if (editing !== "new") return;
    let active = true; setSearching(true);
    const timer = setTimeout(() => {
      api<{ items: Candidate[]; pages: number }>(`games?${new URLSearchParams({ q, page: String(page), sort: "title_asc" })}`)
        .then(value => { if (active) { setCandidates(value.items.filter(item => item.id !== game.id)); setPages(value.pages); } })
        .catch(e => { if (active) setError(e.message); })
        .finally(() => { if (active) setSearching(false); });
    }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [editing, game.id, q, page]);
  async function run(action: () => Promise<void>) {
    onBusyChange(true); setError("");
    try { await action(); await reload(); } catch (e) { setError((e as Error).message); }
    finally { onBusyChange(false); }
  }
  function edit(relation: Relation | "new") {
    setEditing(relation); setError(""); setSelected(null); setQ(""); setPage(1);
    setType(relation === "new" ? "REMAKE_OF" : relation.type); setNote(relation === "new" ? "" : relation.note);
  }
  return <section className="game-relations" aria-label="作品关系">
    <h3>作品关系</h3>
    <p className="muted">原作、重制与复刻分别建档。关系只记录你的判断，不合并作品、拥有记录或评分。</p>
    {!data && !error && <p role="status">正在读取作品关系…</p>}
    {data && !data.relations.length && <p>尚未关联其他作品。</p>}
    {data?.relations.map(relation => {
      const outgoing = relation.sourceGameId === game.id, other = outgoing ? relation.target : relation.source;
      return <div className="relation-row" key={relation.id}>
        <div><span className="pill">{outgoing ? relationLabels[relation.type] : inverseRelationLabels[relation.type]}</span>
          <button className="relation-title" disabled={disabled} onClick={() => onOpen(other.id)}>{title(other)}</button>
          <p className="preserve">判定依据：{relation.note}</p></div>
        <div className="relation-actions"><button disabled={disabled} onClick={() => edit(relation)}>编辑关系</button>
          <button disabled={disabled} onClick={() => {
            if (confirm(`解除「${title(relation.source)} → ${title(relation.target)}」的关系？两款作品和拥有记录保留，解除操作记入历史。`)) {
              void run(async () => { await api(`relations/${relation.id}`, "DELETE"); setEditing(null); });
            }
          }}>解除关系</button></div>
      </div>;
    })}
    {!editing && <button disabled={disabled || !data} onClick={() => edit("new")}>关联原作</button>}
    {editing && <form className="relation-editor" aria-label="编辑作品关系" onSubmit={e => {
      e.preventDefault(); if (editing === "new" && !selected) return;
      void run(async () => {
        await api(editing === "new" ? `games/${game.id}/relations` : `relations/${editing.id}`, editing === "new" ? "POST" : "PUT",
          { type, note, ...(editing === "new" ? { targetGameId: selected!.id } : {}) });
        setEditing(null);
      });
    }}>
      <p><strong>{title(editing === "new" ? game : editing.source)}</strong> → {editing === "new" ? selected ? title(selected) : "选择原作" : title(editing.target)}</p>
      {editing === "new" && <>
        <label>搜索库内原作<input value={q} maxLength={500} disabled={disabled} onChange={e => { setQ(e.target.value); setPage(1); setSelected(null); }}/></label>
        <div className="relation-candidates" role="group" aria-label="选择原作">
          {searching ? <p role="status">正在搜索…</p> : candidates.length ? candidates.map(candidate =>
            <button type="button" key={candidate.id} disabled={disabled} aria-pressed={selected?.id === candidate.id} className={selected?.id === candidate.id ? "selected" : ""} onClick={() => setSelected(candidate)}>
              <strong>{title(candidate)}</strong><small>{candidate.originalTitle || candidate.title} · ID {candidate.id.slice(0, 8)}</small>
              <small>{candidate.releases.filter(r => r.contents.length).map(r => `${r.platform.name} / ${r.releaseDate || "日期未知"}`).join(" · ") || "暂无拥有版本"}</small>
            </button>) : <p>这一页没有其他匹配作品，请调整搜索或先登记原作。</p>}
        </div>
        <div className="relation-pagination"><span>第 {page} / {pages} 页</span>
          <button type="button" disabled={disabled || searching || page <= 1} onClick={() => setPage(page - 1)}>候选上一页</button>
          <button type="button" disabled={disabled || searching || page >= pages} onClick={() => setPage(page + 1)}>候选下一页</button></div>
      </>}
      <fieldset className="choice-filter" disabled={disabled}><legend>关系类型（当前作品 → 原作）</legend><div className="filter-choices">
        {relationTypes.map(value => <button type="button" key={value} aria-pressed={type === value} className={type === value ? "selected" : ""} onClick={() => setType(value)}>{relationLabels[value]}</button>)}
      </div></fieldset>
      <label>判定依据<textarea required value={note} maxLength={2000} rows={3} disabled={disabled} placeholder="记录重制 / 复刻的判断依据，修改和解除会保留历史。" onChange={e => setNote(e.target.value)}/></label>
      <div className="relation-actions"><button type="button" disabled={disabled} onClick={() => setEditing(null)}>取消关联编辑</button>
        <button className="primary" disabled={disabled || !note.trim() || (editing === "new" && !selected)}>保存关系</button></div>
    </form>}
    {error && <p role="alert" className="error">{error}</p>}
    {!!data?.history.length && <details className="relation-history"><summary>判定历史（最近 {data.history.length} 条）</summary>
      <ol>{data.history.map(event => <li key={event.id}>
        <strong>{actions[event.action]} · {title(event.source)} {relationLabels[event.type]} {title(event.target)}</strong>
        <p className="preserve">{event.note}</p><small>第 {event.revision} 次 · {new Date(event.createdAt).toLocaleString()}</small>
      </li>)}</ol><p className="muted">完整历史随 JSON 备份保存。删除作品时，其关系和判定历史也会删除。</p>
    </details>}
  </section>;
}
