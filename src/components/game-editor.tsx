"use client";

import { useState, type ReactNode } from "react";
import { statuses, statusLabels } from "@/lib/domain";
import { fieldLabels, lockedFields, metadataFields, metadataOf, type Metadata, type MetadataField, type Preview, type Selection } from "@/lib/metadata-domain";
import { MetadataLookup, SourceLink } from "./metadata-lookup";

type EditorProfile = { status: string; rating: number | null; favorite: boolean; memo: string; overridesJson: string };
type EditorGame = Metadata & { rawgAttributed: boolean; profiles: EditorProfile[] };
type Draft = { values: Metadata; dirty: Set<MetadataField>; staged: Partial<Record<MetadataField, Preview>> };
const emptyValues = Object.fromEntries(metadataFields.map(field => [field, ""])) as Metadata;

export function GameEditor({ game, ownership, error, busy, onClose, onSave }: {
  game: EditorGame | null; ownership: ReactNode; error: string; busy: boolean; onClose: () => void;
  onSave: (data: FormData, selected: Selection[], manual: MetadataField[]) => void;
}) {
  const personal = game?.profiles[0];
  const initial = game ? metadataOf(game) : emptyValues;
  const locks = lockedFields(personal?.overridesJson ?? "{}");
  const [draft, setDraft] = useState<Draft>(() => ({ values: initial, dirty: new Set(), staged: {} }));
  const stagedFields = metadataFields.filter(field => draft.staged[field]);
  const change = (field: MetadataField, value: string) => setDraft(d =>
    ({ ...d, values: { ...d.values, [field]: value }, dirty: new Set([...d.dirty, field]) }));
  const stage = (preview: Preview, fields: MetadataField[]) => setDraft(d => {
    const values = { ...d.values }, staged = { ...d.staged };
    for (const field of fields) {
      staged[field] = preview;
      if (!locks.has(field) && !d.dirty.has(field)) values[field] = preview.candidate.fields[field]!;
    }
    return { ...d, values, staged };
  });
  const clear = (field: MetadataField) => setDraft(d => {
    const staged = { ...d.staged };
    delete staged[field];
    return { ...d, staged, values: d.dirty.has(field) ? d.values : { ...d.values, [field]: initial[field] } };
  });

  return <div className="modal-backdrop" onClick={() => !busy && onClose()}>
    <section className="modal" role="dialog" aria-modal="true" aria-label={game ? "编辑游戏" : "登记游戏"} onClick={e => e.stopPropagation()}>
      <header><div><span className="eyebrow">BUILD YOUR ARCHIVE</span><h2>{game ? "编辑作品资料" : "登记一款游戏"}</h2></div>
        <button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></header>
      <form onSubmit={e => {
        e.preventDefault();
        const selected = new Map<string, Selection>();
        for (const field of stagedFields) {
          const token = draft.staged[field]!.token;
          const existing = selected.get(token);
          if (existing) existing.fields.push(field);
          else selected.set(token, { token, fields: [field] });
        }
        onSave(new FormData(e.currentTarget), [...selected.values()], [...draft.dirty]);
      }}>
        <MetadataLookup title={draft.values.title} draft={draft.values} protectedFields={new Set([...locks, ...draft.dirty])} disabled={busy} onStage={stage}/>
        {stagedFields.length > 0 && <ul className="metadata-staged" aria-label="已暂存的候选字段">
          {stagedFields.map(field => {
            const c = draft.staged[field]!.candidate;
            return <li key={field}>{fieldLabels[field]} · <SourceLink provider={c.provider} id={c.externalId}/>
              {(locks.has(field) || draft.dirty.has(field)) && "（仅候选）"}
              <button type="button" aria-label={"移除暂存：" + fieldLabels[field]} onClick={() => clear(field)} disabled={busy}>移除</button>
            </li>;
          })}
        </ul>}
        {game?.rawgAttributed && <p className="muted">资料来源记录包含 <SourceLink provider="rawg"/>。</p>}
        <div className="form-grid">
          {metadataFields.filter(f => f !== "description").map(field => <label key={field} className={field === "title" ? "wide" : undefined}>
            {field === "coverUrl" ? "封面 URL（http/https）" : fieldLabels[field]}
            <input name={field} required={field === "title"} maxLength={field === "coverUrl" ? 2000 : 500}
              value={draft.values[field]} onChange={e => change(field, e.target.value)}/>
          </label>)}
          <label>游玩状态<select name="status" defaultValue={personal?.status ?? "UNPLAYED"}>
            {statuses.map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}
          </select></label>
          <label>个人评分<select name="rating" defaultValue={personal?.rating ?? ""}>
            <option value="">未评分</option>{[1, 2, 3, 4, 5].map(n => <option value={n} key={n}>{"★".repeat(n)}</option>)}
          </select></label>
          <label className="wide">简介<textarea name="description" rows={3} maxLength={20000} value={draft.values.description} onChange={e => change("description", e.target.value)}/></label>
          <label className="wide">个人备注<textarea name="memo" rows={3} maxLength={20000} defaultValue={personal?.memo}/></label>
          <label className="check wide"><input name="favorite" type="checkbox" defaultChecked={personal?.favorite}/>加入我的收藏</label>
        </div>
        {!game && <><h3>我拥有的版本</h3>{ownership}</>}
        <p className="muted">手动修改（包括清空）会锁定字段。保存后可在游戏详情逐字段查看来源或解除锁定。</p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>
          <button className="primary" disabled={busy}>{busy ? "保存中…" : "保存游戏"}</button></div>
      </form>
    </section>
  </div>;
}
