"use client";

import { useState } from "react";
import { api } from "@/lib/client-api";
import { translationLanguageLabels, translationLanguages, type TranslationLanguage } from "@/lib/translation-languages";

type Preview = { source: string; target: TranslationLanguage } & ({ text: string } | { error: string });

export function DescriptionTranslation({ description, configured, disabled, onApply }: {
  description: string; configured: boolean; disabled: boolean; onApply: (text: string) => void;
}) {
  const [target, setTarget] = useState<TranslationLanguage>("zh-CN");
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<Preview | null>(null);
  const preview = last?.source === description && last.target === target ? last : null;

  async function translate() {
    if (busy || disabled || !configured || !description.trim()) return;
    setLast(null); setBusy(true);
    try {
      const { text } = await api<{ text: string }>("translations/description", "POST", { text: description, target });
      setLast({ source: description, target, text });
    } catch (e) {
      setLast({ source: description, target, error: e instanceof Error ? e.message : "翻译失败，请稍后再试。" });
    } finally { setBusy(false); }
  }

  return <details className="description-translation wide">
    <summary>Gemini 翻译简介</summary>
    {!configured ? <p className="muted">在服务器设置 GEMINI_API_KEY 后启用。</p> : <>
      <p className="muted">点击翻译时仅发送当前简介。译文可先预览，采用后仍需保存游戏。</p>
      <div className="translation-tools">
        <label>译文语言<select value={target} disabled={disabled || busy}
          onChange={e => { setTarget(e.target.value as TranslationLanguage); setLast(null); }}>
          {translationLanguages.map(language => <option key={language} value={language}>{translationLanguageLabels[language]}</option>)}
        </select></label>
        <button type="button" disabled={disabled || busy || !description.trim()} onClick={() => void translate()}>
          {busy ? "翻译中…" : "翻译当前简介"}
        </button>
      </div>
      {!description.trim() && <p className="muted">请先填写简介，或从资料候选中选取简介。</p>}
      {preview && ("error" in preview ? <p className="error" role="alert">{preview.error}</p> :
        <div className="translation-result" aria-label="译文预览" role="region">
          <strong role="status">译文预览 · {translationLanguageLabels[target]}</strong>
          <p className="preserve">{preview.text}</p>
          <button type="button" className="primary" disabled={disabled || busy} onClick={() => {
            onApply(preview.text); setLast(null);
          }}>采用译文</button>
        </div>)}
    </>}
  </details>;
}
