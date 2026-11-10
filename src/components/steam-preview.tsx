"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/client-api";
import type { SteamPreview } from "@/lib/steam-preview";

const pageSize = 12;
const playtime = (minutes: number | null) =>
  minutes === null ? "时长未知" : minutes < 60 ? minutes + " 分钟" : (minutes / 60).toFixed(1) + " 小时";

export function SteamLibraryPreview({ configured }: { configured: boolean }) {
  const [steamId, setSteamId] = useState("");
  const [result, setResult] = useState<SteamPreview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const list = result?.state === "listed" ? result : null;
  const pages = list ? Math.ceil(list.items.length / pageSize) : 1;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !configured) return;
    setBusy(true); setResult(null); setError(""); setPage(1);
    try { setResult(await api<SteamPreview>("steam/preview", "POST", { steamId })); }
    catch (e) { setError(e instanceof Error ? e.message : "Steam 预览失败，请稍后再试。"); }
    finally { setBusy(false); }
  }

  return <>
    <section className="page-heading"><div>
      <span className="eyebrow">READ-ONLY PREVIEW</span>
      <h1>Steam 游戏库预览</h1>
      <p>查看 Steam 返回的游戏名称、AppID 和累计游玩时长。</p>
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
        <ul className="steam-preview-results" aria-label="Steam 可见游戏">
          {list.items.slice((page - 1) * pageSize, page * pageSize).map(game =>
            <li key={game.appid}>
              <div><strong>{game.title}</strong><small>AppID {game.appid}</small></div>
              <span>{playtime(game.playtimeMinutes)}</span>
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
