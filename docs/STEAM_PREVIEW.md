# Steam 游戏库只读预览

自 GameShelf 0.1.10 起可选启用；0.1.9 不含此功能。预览与导入、账号绑定、后台同步分开。没有 Prisma 迁移或 JSON 备份格式变更。

## 使用

1. 在 0.1.10 应用容器设置可选变量 `STEAM_WEB_API_KEY` 后重新创建容器。使用 Steam Web API 用户密钥，不是 Steam 密码、会话或 SteamGridDB 密钥。用 Compose 从源码构建时给 `GAMESHELF_IMAGE` 设置独立本地标签；不要覆盖已发布的标签。
2. 以 GameShelf 实例管理员登录，打开「Steam 预览」，输入自己的 17 位 SteamID64 并点击「预览可见游戏」。仅点击后请求 Steam。显示可见项目的名称、AppID、累计时长（零值与未知分开），包含 Steam 返回的玩过的免费游戏。列表按 AppID 排序、去重、每 12 项翻页。
3. 如果 Steam 没有返回可见项目，可能是库为空或「游戏详情」的可见性受限。预览不绕过 Steam 的可见性；无数据与限流、错误响应分开提示。未设置密钥时手动库继续正常运行。

SteamID64 和预览结果不写入数据库、备份或浏览器持久存储；请求响应禁用缓存。密钥只由服务端发送给 Steam，不出现在客户端、备份或上游错误内容中。本功能不证明 Steam 账号归属，也不新增或覆盖本地条目。

接口依据：[Steamworks GetOwnedGames](https://partner.steamgames.com/doc/webapi/IPlayerService?language=english#getownedgames)、[Web API 概要](https://partner.steamgames.com/doc/webapi_overview?l=english)、[Web API 密钥](https://partner.steamgames.com/doc/webapi_overview/auth)。

## 验收与后续

`npm run build` 后运行 `npm run test:steam-preview`：独立 SQLite、合成 Steam 响应、API 权限与异常、桌面和 390px 界面，预览前后比较备份。测试不访问真实 Steam；输出路径由 `QA_ARTIFACTS` 给出。

真实 Steam 账号与 Unraid 尚需单独验证。下一批先核对真实库的可见性与时长，再做账号归属确认、Steam AppID 匹配、待导入清单与确认后的幂等写入。自动同步、历史和重试在导入验证之后推进。
