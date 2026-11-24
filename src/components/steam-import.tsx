"use client";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client-api";
import type { SteamComparison } from "@/lib/steam-library-match";

type ImportPreview = Extract<SteamComparison, {state:"listed"}> & {
  token:string; steamId:string; expiresAt:string; links:{appid:number;gameId:string}[]
};
export function SteamImport({configured, libraryRevision, onImported, onOpen}: {
  configured:boolean; libraryRevision:number; onImported:()=>Promise<void>; onOpen:(id:string)=>void
}) {
  const [account,setAccount] = useState<{steamId:string;verifiedAt:string}|null>(null);
  const [preview,setPreview] = useState<ImportPreview|null>(null);
  const [selected,setSelected] = useState<Record<string,string>>({});
  const [busy,setBusy] = useState(false), [error,setError] = useState(""), [notice,setNotice] = useState("");
  const [page,setPage] = useState(1), [search,setSearch] = useState("");
  const [localQuery,setLocalQuery] = useState(""), [local,setLocal] = useState<{id:string;title:string}[]>([]);
  const epoch = useRef(0);
  useEffect(()=>{
    const current=++epoch.current;
    setPreview(null);setSelected({});setBusy(false);setLocal([]);
    void api<{account:typeof account}>("steam/account").then(r=>{if(current===epoch.current)setAccount(r.account);})
      .catch(e=>{if(current===epoch.current)setError(e.message);});
    return ()=>{epoch.current++;};
  },[libraryRevision]);
  async function run(work:()=>Promise<void>) {
    if(busy)return;setBusy(true);setError("");
    const current=epoch.current;
    try{await work();}catch(e){if(current===epoch.current)setError((e as Error).message);}
    finally{if(current===epoch.current)setBusy(false);}
  }
  async function loadPreview() {
    const current=epoch.current;setPreview(null);setSelected({});setNotice("");setPage(1);setSearch("");
    const result=await api<ImportPreview|{state:"no_visible_games"}>("steam/import/preview","POST",{});
    if(current!==epoch.current)return;
    if(result.state==="listed")setPreview(result);else setNotice("Steam 没有返回可见游戏，请检查游戏详情的可见性。");
  }
  const filtered=preview?.items.filter(g=>!search||`${g.appid} ${g.title}`.toLowerCase().includes(search.toLowerCase()))??[];
  const pages=Math.max(1,Math.ceil(filtered.length/12));
  const choices=Object.entries(selected).filter(([,value])=>value!=="").map(([appid,value])=>({appid:Number(appid),gameId:value==="new"?null:value}));
  return <section className="panel steam-preview" aria-label="Steam 确认导入">
    <h2>Steam 账号与确认导入</h2>
    <p>先在 Steam 官方页面验证账号，再选择导入项目。名称候选不会自动合并；每项会新增一份 Steam 拥有记录，不覆盖原记录、评分、备注或手动锁定。已关联 AppID 重复提交不更新时长。</p>
    <p>当前账号：{account?account.steamId+"（已验证）":"尚未连接"}</p>
    <div className="filter-choices">
      <button disabled={busy} onClick={()=>void run(async()=>{const r=await api<{url:string}>("steam/account/start","POST",{});window.location.assign(r.url);})}>
        {account?"重新验证 / 更换 Steam 账号":"通过 Steam 官方登录连接"}</button>
      {account&&<><button disabled={busy} onClick={()=>{
        if(confirm("解除 Steam 连接？已导入的作品和拥有记录将保留。"))void run(async()=>{await api("steam/account","DELETE");setAccount(null);setPreview(null);setSelected({});setNotice("已解除连接，导入资料已保留。");});
      }}>解除连接</button><button className="primary" disabled={busy||!configured} onClick={()=>void run(loadPreview)}>预览已验证账号的导入清单</button></>}
    </div>
    {!configured&&<p>导入预览需要服务器配置 STEAM_WEB_API_KEY。</p>}
    {error&&<p className="error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    {preview&&<>
      <p>账号 {preview.steamId} · 清单有效期 10 分钟 · 已选 {choices.length} 项（每批最多 100 项）。首次新增的 Steam 拥有记录采用本次来源时长，获取方式为「未确认」。</p>
      <label>搜索导入清单<input type="search" value={search} onChange={e=>{setSearch(e.target.value);setPage(1);}}/></label>
      <form className="steam-preview-form" onSubmit={e=>{e.preventDefault();void run(async()=>{
        const current=epoch.current;const r=await api<{items:{id:string;title:string}[]}>("games?q="+encodeURIComponent(localQuery));
        if(current===epoch.current)setLocal(previous=>[...new Map([
          ...previous.filter(game=>Object.values(selected).includes(game.id)),...r.items
        ].map(game=>[game.id,game])).values()]);
      });}}><label>查找其他已有作品<input value={localQuery} onChange={e=>setLocalQuery(e.target.value)} maxLength={500}/></label>
        <button disabled={busy||!localQuery.trim()}>查找本人作品</button></form>
      {!!local.length&&<p>可选 {local.length} 个作品（含此前已选目标）；每次搜索最多返回 24 项，请用更具体的名称缩小范围。选择后可查看目标详情。</p>}
      <ul className="steam-preview-results" aria-label="Steam 导入清单">
        {filtered.slice((page-1)*12,page*12).map(game=>{
          const link=preview.links.find(l=>l.appid===game.appid);
          const targets=new Map(game.match.candidates.map(c=>[c.gameId,`${c.localizedTitle||c.title} · ${c.platforms.join(" / ")||"无拥有版本"} · ${c.gameId}`]));
          local.forEach(g=>{if(!targets.has(g.id))targets.set(g.id,`${g.title} · ${g.id}`);});
          return <li key={game.appid}><strong>{game.title}</strong><small>AppID {game.appid} · {game.playtimeMinutes===null?"时长未知":game.playtimeMinutes+" 分钟"}</small>
            {link?<button disabled={busy} onClick={()=>onOpen(link.gameId)}>已关联 · 查看作品</button>:<>
              <label>导入方式 · {game.appid}<select disabled={busy} value={selected[game.appid]??""} onChange={e=>setSelected({...selected,[game.appid]:e.target.value})}>
                <option value="">不导入</option>{game.titleAvailable&&<option value="new">新建作品与 Steam 拥有记录</option>}
                {[...targets].map(([id,title])=><option key={id} value={id}>关联已有作品：{title}</option>)}
              </select></label>
              {selected[game.appid]&&selected[game.appid]!=="new"&&<button disabled={busy} onClick={()=>onOpen(selected[game.appid])}>查看所选本地作品</button>}
              {!game.titleAvailable&&<p>缺少标题，请查找并选择本人已有作品。</p>}
            </>}
          </li>;
        })}
      </ul>
      {!filtered.length&&<p>没有符合条件的项目。</p>}
      <nav className="pagination" aria-label="Steam 导入分页"><span>第 {page} / {pages} 页</span><div>
        <button disabled={busy||page<=1} onClick={()=>setPage(page-1)}>上一页</button><button disabled={busy||page>=pages} onClick={()=>setPage(page+1)}>下一页</button>
      </div></nav>
      <button className="primary" disabled={busy||!choices.length||choices.length>100} onClick={()=>{
        if(confirm(`确认导入所选 ${choices.length} 项？其中 ${choices.filter(c=>!c.gameId).length} 项新建作品，其余关联已有作品。每项新增独立 Steam 拥有记录；同名不保证同一作品，请确认选择。`))void run(async()=>{
          const r=await api<{created:number;duplicate:number}>("steam/import","POST",{token:preview.token,confirmed:true,choices});
          setPreview(null);setSelected({});setNotice(`导入完成：新增 ${r.created} 份 Steam 拥有记录，跳过 ${r.duplicate} 项已有关联。`);await onImported();
        });
      }}>确认导入所选项目（{choices.length}）</button>
    </>}
  </section>;
}
