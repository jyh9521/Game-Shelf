export const translationLanguages = ["zh-CN", "ja", "en"] as const;
export type TranslationLanguage = typeof translationLanguages[number];
export const translationLanguageLabels: Record<TranslationLanguage, string> = {
  "zh-CN": "简体中文", ja: "日本語", en: "English"
};
