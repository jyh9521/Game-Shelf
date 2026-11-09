"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import { fieldLabels, type FieldReport, type FieldState } from "@/lib/metadata-domain";
import { SourceLink } from "./metadata-lookup";

const actions = { MANUAL: "手动锁定 / 修改", SOURCE: "接受来源候选", UNLOCK: "解除手动锁定" };
const formatTime = (value: string) => new Date(value).toLocaleString();
const display = (value: string | null) => value === null ? "未登记" : value || "（空值）";
export function FieldHistory({ id, disabled, onBusyChange, onUpdated }: {
  id: string; disabled: boolean; onBusyChange: (busy: boolean) => void; onUpdated: () => Promise<void>;
}) {
  const [report, setReport] = useState<FieldReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const path = "games/" + id + "/fields";
  const read = async () => setReport(await api<FieldReport>(path));
  async function load() {
    setBusy(true); setError("");
    try { await read(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function unlock(field: FieldState) {
    if (!report || disabled || busy) return;
    const message = field.source ? "将使用下方显示的候选值。" : "没有来源候选，当前值会保留。";
    if (!confirm("解除「" + fieldLabels[field.field] + "」的手动锁定？" + message)) return;
    setBusy(true); onBusyChange(true); setError("");
    try {
      await api(path + "/unlock", "POST", { field: field.field, revision: report.revision });
      await read();
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
      await read().catch(() => {});
    } finally { setBusy(false); onBusyChange(false); }
  }
  return <details className="metadata-panel" onToggle={e => { if (e.currentTarget.open && !report && !busy) void load(); }}>
    <summary>字段来源与历史</summary>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <p role="status" className="muted">正在读取字段资料…</p>}
    {!report && !busy && <button type="button" onClick={() => void load()}>重新读取</button>}
    {report && <>
      <div className="field-state-list">
        {report.fields.map(f => <section key={f.field} className="field-state">
          <strong>{fieldLabels[f.field]}</strong> <small className="pill">{f.locked ? "手动锁定" : f.source ? "来源值" : "未锁定"}</small>
          <p className="metadata-value">当前：{display(f.value)}</p>
          {f.source ? <>
            <p className="metadata-value">候选：{f.source.value}</p>
            <p className="muted"><SourceLink provider={f.source.provider} id={f.source.externalId}/> · ID {f.source.externalId} · {formatTime(f.source.collectedAt)}</p>
          </> : <p className="muted">没有来源候选</p>}
          {f.locked && <button type="button" disabled={disabled || busy} onClick={() => void unlock(f)}
            aria-label={(f.source ? "恢复自动更新：" : "解除锁定：") + fieldLabels[f.field]}>
            {f.source ? "恢复自动更新" : "解除锁定并保留当前值"}</button>}
        </section>)}
      </div>
      <details className="relation-history">
        <summary>最近字段变更（最多 40 条）</summary>
        {!report.history.length && <p className="muted">尚无历史。旧库迁移不补造历史或候选。</p>}
        <ol>{report.history.map(e => <li key={e.id}>
          <strong>{fieldLabels[e.field]} · {actions[e.action]}</strong>
          <div className="metadata-value">{display(e.previousValue)} → {display(e.value)}</div>
          <small>{formatTime(e.createdAt)}{e.source && <> · <SourceLink provider={e.source.provider} id={e.source.externalId}/> · ID {e.source.externalId}</>}</small>
          {e.source && <div className="metadata-value">候选：{e.source.value}</div>}
        </li>)}</ol>
      </details>
    </>}
  </details>;
}
