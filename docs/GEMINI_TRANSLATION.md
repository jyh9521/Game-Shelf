# Gemini 游戏简介翻译

自 GameShelf 0.1.10 起可选启用。仅实例管理员可使用；与 IGDB、RAWG、TheGamesDB、ScreenScraper、SteamGridDB 及 Steam 预览分别配置。

## Docker / Unraid

- **Docker Compose**：在 Compose 项目的环境或本地 `.env` 设置 `GEMINI_API_KEY`，重新创建容器。Compose 会把该变量传给应用容器。
- **Unraid**：编辑容器，在 Variables 添加 **`GEMINI_API_KEY`**，或使用本仓库模板中的同名字段；保留其他变量与原 appdata 映射。
- `GEMINI_MODEL` 可留空（默认 `gemini-3.5-flash-lite`）。如账号需用其他可用的 Gemini 文本模型，填写其模型代码。密钥不作为镜像构建参数，也不写进数据库或备份。

## 操作

1. 登记或编辑游戏，输入简介，或从外部资料候选中暂存简介。
2. 在简介下展开「Gemini 翻译简介」，选简体中文（默认）、日本語或 English，再点「翻译当前简介」。仅这时将当前简介发往 Gemini，不发送游戏库、个人备注或账号凭据。
3. 核对译文后点「采用译文」。这只更新编辑草稿；点「保存游戏」才按手动编辑写库。已有外部资料来源仍按原字段规则保留。翻译失败、不采用或取消编辑时不会改变已保存的简介。

上游限额、超时与无可用译文会单独提示。没有密钥时，其他资料 API、Steam 预览和手动游戏库不受影响。

接口和模型依据：[Google Gemini Generate Content API](https://ai.google.dev/gemini-api/docs/generate-content/text-generation)、[Gemini 模型](https://ai.google.dev/gemini-api/docs/models)。
