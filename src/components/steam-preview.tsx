"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/client-api";
import { filterSteamComparisons, matchLabels, matchStates, titleFieldLabels,
  type MatchState, type SteamComparison } from "@/lib/steam-library-match";

const pageSize = 12;
const playtime = (minutes: number | null) =>
  minutes === null ? "时长未知" : minutes < 60 ? minutes + " 分钟" : (minutes / 60).toFixed(1) + " 小时";

export function SteamLibraryPreview({ configured, disabled, libraryRevision, onOpen }: {
  configured: boolean; disabled: boolean; libraryRevision: number; onOpen: (id: string) => void
}) {
  const [steamId, setSteamId] = useState("");
  const [result, setResult] = useState<SteamComparison | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MatchState | "all">("all");
  const requestId = useRef(0);
  const list = result?.state === "listed" ? result : null;
  const filtered = useMemo(() => filterSteamComparisons(list?.items ?? [], query, filter), [list, query, filter]);
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  // Invalidate edited/deleted candidates and in-flight responses after edits/unmount.
  useEffect(() => {
    requestId.current++; setResult(null); setPage(1); setBusy(false);
    return () => { requestId.current++; };
  }, [libraryRevision]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !configured) return;
    const current = ++requestId.current;
    setBusy(true); setResult(null); setError(""); setPage(1); setQuery(""); setFilter("all");
    try {
      const response = await api<SteamComparison>("steam/preview", "POST", { steamId });
      if (current === requestId.current) setResult(response);
    } catch (e) {
      if (current === requestId.current) setError(e instanceof Error ? e.message : "Steam 预览失败，请稍后再试。");
    } finally { if (current === requestId.current) setBusy(false); }
  }

  return <>
    <section className="page-heading"><div>
      <span className="eyebrow">READ-ONLY PREVIEW</span>
      <h1>Steam 游戏库预览</h1>
      <p>查看 Steam 可见游戏，与自己的本地库进行只读候选对照。</p>
    </div></section>
    <section className="panel steam-preview" aria-label="查询可见游戏">
      <h2>查询可见游戏</h2>
      <p>仅在提交时向 Steam 查询。预览不会绑定账号、导入游戏或更改本地库。</p>
      {!configured && <p>预览未启用：请在服务器设置 STEAM_WEB_API_KEY。手动游戏库可继续使用。</p>}
      <form className="steam-preview-form" onSubmit={submit}>
        <label>SteamID64
          <input value={steamId} inputMode="numeric" autoComplete="off" placeholder="17 位数字"
            pattern="[1-9][0-9]{16}" maxLength={17} required disabled={busy || !configured}
            onChange={e => { setSteamId(e.target.value); setResult(null); setError(""); }}/>
        </label>
        <button className="primary" disabled={busy || !configured}>{busy ? "查询中…" : "预览可见游戏"}</button>
      </form>
      {error && <div className="error" role="alert">{error}</div>}
      {result?.state === "no_visible_games" &&
        <p role="status">Steam 没有返回可见游戏。游戏库可能为空，也可能是「游戏详情」的可见性受限。</p>}
      {list && <>
        <p role="status">{list.items.length} 款可见游戏（含玩过的免费游戏）。{list.skipped > 0 && `已跳过 ${list.skipped} 条重复或无效记录。`}</p>
        <p className="steam-match-notice">仅按标题、原名和本地化标题寻找候选，不代表 AppID 匹配或已拥有 Steam 版本。同名原作、重制版与不同发行版本仍需人工确认；未找到候选也不代表尚未入库。修改本地库后请重新预览。</p>
        <fieldset className="choice-filter steam-match-filters">
          <legend>本地库对照</legend>
          <div className="filter-choices">
            <button type="button" aria-pressed={filter === "all"} className={filter === "all" ? "selected" : ""}
              onClick={() => { setFilter("all"); setPage(1); }}>全部（{list.items.length}）</button>
            {matchStates.map(state => <button type="button" key={state} aria-pressed={filter === state}
              className={filter === state ? "selected" : ""} onClick={() => { setFilter(state); setPage(1); }}>
              {matchLabels[state]}（{list.summary[state]}）</button>)}
          </div>
        </fieldset>
        <div className="steam-match-search">
          <label>搜索预览结果<input type="search" value={query} maxLength={500} placeholder="Steam 名称、AppID 或已展示的本地候选标题"
            onChange={e => { setQuery(e.target.value); setPage(1); }}/></label>
          <button type="button" disabled={!query && filter === "all"} onClick={() => { setQuery(""); setFilter("all"); setPage(1); }}>重置对照筛选</button>
        </div>
        <p role="status">显示 {filtered.length} / {list.items.length} 款。筛选与翻页不会再次请求 Steam。</p>
        {!filtered.length && <p>没有符合当前对照条件的游戏，请调整搜索或筛选。</p>}
        <ul className="steam-preview-results" aria-label="Steam 可见游戏">
          {filtered.slice((page - 1) * pageSize, page * pageSize).map(game =>
            <li key={game.appid}>
              <div className="steam-game-heading"><div><strong>{game.title}</strong><small>AppID {game.appid}</small></div>
                <span>{playtime(game.playtimeMinutes)}</span></div>
              <div className="steam-match"><strong className="steam-match-state">{matchLabels[game.match.state]}</strong>
                {game.match.candidates.map(candidate => <div className="steam-candidate" key={candidate.gameId}>
                  <button type="button" disabled={disabled} onClick={() => onOpen(candidate.gameId)}
                    aria-label={`查看本地候选：${candidate.localizedTitle || candidate.title}`}>
                    {candidate.localizedTitle || candidate.title}</button>
                  <small>命中{candidate.matchedFields.map(f => titleFieldLabels[f]).join(" / ")} · {candidate.platforms.join(" / ") || "无拥有版本"}</small>
                  <small>{[candidate.title, candidate.originalTitle, candidate.localizedTitle].filter((v, i, a) => v && a.indexOf(v) === i).join(" / ")}</small>
                </div>)}
                {game.match.candidateCount > game.match.candidates.length &&
                  <small>共 {game.match.candidateCount} 个候选，仅展示前 {game.match.candidates.length} 个；其余请到游戏库查找。</small>}
              </div>
            </li>)}
        </ul>
        {pages > 1 && <nav className="pagination" aria-label="Steam 预览分页">
          <span>第 {page} / {pages} 页</span>
          <div><button disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>
        </nav>}
      </>}
    </section>
  </>;
}
