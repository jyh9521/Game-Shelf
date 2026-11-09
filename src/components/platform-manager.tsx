"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/client-api";

export type PlatformEntry = { id: string; name: string };
export function PlatformManager({ platforms, canManage, busy, onBusyChange, onChanged }: {
  platforms: PlatformEntry[]; canManage: boolean; busy: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: (oldId: string | null, nextId: string | null, message: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<PlatformEntry | null>(null);
  const [removing, setRemoving] = useState<PlatformEntry | null>(null);
  const [error, setError] = useState("");
  const dismiss = () => { setEditing(null); setRemoving(null); setError(""); };
  async function change(action: () => Promise<void>) {
    if (busy) return;
    onBusyChange(true); setError("");
    try { await action(); }
    catch (e) { setError((e as Error).message); }
    finally { onBusyChange(false); }
  }
  function save(e: FormEvent<HTMLFormElement>, entry?: PlatformEntry) {
    e.preventDefault();
    const form = e.currentTarget, data = new FormData(form);
    const name = String(data.get("name") ?? ""), code = String(data.get("code") ?? "");
    void change(async () => {
      const payload = { name, ...(code && code !== entry?.id ? { code } : {}) };
      const updated = await api<PlatformEntry>(entry ? "platforms/" + encodeURIComponent(entry.id) : "platforms", entry ? "PUT" : "POST", payload);
      await onChanged(entry?.id ?? null, updated.id, entry ? "平台已更新，原有拥有记录保留。" : "平台已添加。");
      if (entry) dismiss();
      else form.reset();
    });
  }
  function remove(entry: PlatformEntry) {
    void change(async () => {
      await api("platforms/" + encodeURIComponent(entry.id), "DELETE");
      await onChanged(entry.id, null, "平台已删除。");
      dismiss();
    });
  }
  const handleEscape = (e: React.KeyboardEvent) => { if (e.key === "Escape" && !busy) dismiss(); };

  return <>
    <section className="page-heading"><div><span className="eyebrow">YOUR PLATFORMS</span>
      <h1>跨越平台的收藏<span>.</span></h1><p>平台对应发行版本，商店对应购买渠道。</p></div></section>
    <section className="panel">
      <h2>已登记平台</h2>
      <p>{canManage ? "可修改平台名称和代号。已有拥有记录的平台，先在游戏详情调整发行平台，再删除。" : "平台目录由实例管理员维护。"}</p>
      {!platforms.length && <p>暂无平台。</p>}
      <div className="platform-grid">
        {platforms.map(p => <article className="platform-card" key={p.id}>
          <div><strong>{p.name}</strong><small>代号 <code>{p.id}</code></small></div>
          {canManage && <div className="platform-actions">
            <button type="button" disabled={busy} aria-label={"编辑平台：" + p.name} onClick={() => { setError(""); setEditing(p); }}>编辑</button>
            <button type="button" disabled={busy} className="platform-delete" aria-label={"删除平台：" + p.name} onClick={() => { setError(""); setRemoving(p); }}>删除</button>
          </div>}
        </article>)}
      </div>
      {canManage && <form className="platform-add" onSubmit={save}>
        <label>新平台名称<input name="name" required maxLength={120} placeholder="例如：Nintendo 64"/></label>
        <label>新平台代号（可选）<input name="code" maxLength={40} placeholder="例如：N64"/></label>
        <button className="primary" disabled={busy}>添加平台</button>
      </form>}
      {error && !editing && !removing && <p className="error" role="alert">{error}</p>}
    </section>
    {editing && <div className="modal-backdrop" onClick={() => !busy && dismiss()}>
      <section className="modal platform-modal" role="dialog" aria-modal="true" aria-label="编辑平台" onClick={e => e.stopPropagation()} onKeyDown={handleEscape}>
        <header><h2>编辑平台</h2><button type="button" aria-label="关闭" disabled={busy} onClick={dismiss}>×</button></header>
        <form onSubmit={e => save(e, editing)}>
          <div className="form-grid">
            <label>平台名称<input name="name" defaultValue={editing.name} maxLength={120} required autoFocus/></label>
            <label>平台代号<input name="code" defaultValue={editing.id} maxLength={Math.max(40, editing.id.length)} required aria-describedby="platform-code-help"/></label>
          </div>
          <p className="muted" id="platform-code-help">代号用字母、数字、短横线或下划线，例如 N64。修改代号不会移除已有拥有记录。</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="modal-actions"><button type="button" disabled={busy} onClick={dismiss}>取消</button>
            <button className="primary" disabled={busy}>保存平台</button></div>
        </form>
      </section>
    </div>}
    {removing && <div className="modal-backdrop" onClick={() => !busy && dismiss()}>
      <section className="modal platform-modal" role="dialog" aria-modal="true" aria-label="删除平台" onClick={e => e.stopPropagation()} onKeyDown={handleEscape}>
        <header><h2>删除平台</h2><button type="button" aria-label="关闭" disabled={busy} onClick={dismiss}>×</button></header>
        <p>删除「{removing.name}」及该平台上未关联拥有记录的发行资料？已有游戏和拥有记录不会被删除。</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" disabled={busy} onClick={dismiss} autoFocus>取消</button>
          <button type="button" className="platform-delete" disabled={busy} onClick={() => remove(removing)}>确认删除</button></div>
      </section>
    </div>}
  </>;
}
