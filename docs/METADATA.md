# 外部资料源、字段历史和备份 v3

从 0.1.7 开始提供。凭据按实例配置，可只启用任意一项；没有配置时手动登记、搜索本地库和备份照常使用。

## Docker / Unraid 配置

把需要的变量填入 Compose 项目的 `.env`（键名也列在 [`.env.example`](../.env.example)），或在 Unraid 容器里添加同名的 **Variable**。变量在容器启动时由服务端读取，不是构建参数，也不使用 `NEXT_PUBLIC_`。

| 服务 | 容器变量 | 获取及用途 |
| --- | --- | --- |
| IGDB | `IGDB_CLIENT_ID`、`IGDB_CLIENT_SECRET` | 在 [Twitch 开发者控制台](https://dev.twitch.tv/console/apps)创建机密应用；GameShelf 使用 [IGDB v4](https://api-docs.igdb.com/) 应用访问令牌，自动续期。 |
| RAWG | `RAWG_API_KEY` | 从 [RAWG API](https://rawg.io/apidocs) 申请；搜索作品和读取详情，使用资料时界面保留回链。 |
| TheGamesDB | `THEGAMESDB_API_KEY` | 使用获准的 [TheGamesDB API](https://api.thegamesdb.net/) 密钥；作品详情以及类型、开发商、发行商等名称。 |
| ScreenScraper | `SCREENSCRAPER_DEV_ID`、`SCREENSCRAPER_DEV_PASSWORD` | 使用 [API v2](https://www.screenscraper.fr/webapi2.php) 核发的开发者凭据。`SCREENSCRAPER_USERNAME` 与 `SCREENSCRAPER_PASSWORD` 可同时留空或成对填写；软件名默认 `GameShelf`，如凭据绑定了软件名则填写 `SCREENSCRAPER_SOFTNAME`。 |
| SteamGridDB | `STEAMGRIDDB_API_KEY` | 从 [SteamGridDB 账户设置](https://www.steamgriddb.com/profile/preferences/api)获取；[API v2](https://www.steamgriddb.com/api/v2) 只用于查找和选择竖版封面。 |

例如，只有 RAWG 和 SteamGridDB 密钥时，`.env` 可以增加以下配置（替换引号中的占位符；其余服务留空）：

```dotenv
RAWG_API_KEY='你的 RAWG 密钥'
STEAMGRIDDB_API_KEY='你的 SteamGridDB 密钥'
```

在仓库根目录执行：

```sh
docker compose pull gameshelf
docker compose up -d --no-build --wait gameshelf
```

只修改密钥时，重新创建容器即可生效，无需构建镜像。现有 Unraid 容器使用 `jyh9521/gameshelf:0.1.7`，保留 `/data` 映射、端口和原有设置，再添加选用服务的变量。升级前保留旧镜像、配置和一致性数据库快照；详见[升级与回退](releases/0.1.7.md)。

## 查找、保存和恢复来源值

1. 进入「登记游戏」或「编辑资料」→「查找外部资料或封面」。选择已配置的服务，输入名称并点击搜索。仅在主动搜索时发送标题，输入字符不触发外部查询。
2. 核对同名结果的来源 ID、平台、发行日期和精度（来源有提供时）。标题、原始标题、类型、公司和简介按供应商实际返回而定；发行日期等只供辨认，不自动修改你拥有的发行版本、地区、渠道或游玩资料。
3. 勾选需要的字段并暂存。SteamGridDB 切换为单张封面选择；只保存远程图片 URL。点「保存游戏」才写入。锁定的字段或此次手动改过的字段（含清空）保留当前值，选择的外部资料只成为候选。
4. 游戏详情 →「字段来源与历史」显示当前值、锁定、最新候选、外部 ID 和采集时间。点「恢复自动更新」并确认，才应用该候选；没有候选时只解除锁定并保留当前值。此处的「自动」表示字段以后可以接受你确认的新来源，不是后台定时同步。

## 工程与验证

- 游戏主体和拥有版本结构不变。`UserGameMetadata` 按个人档案保存有效值；列表标题、搜索、类型和关系标题使用本人资料。`ProfileFieldHistory` 按字段记录手动、选用来源、解除锁定，以及每步的候选和值。界面显示最近 40 条，JSON 保留全部。
- `20261109000000_metadata_history` 复制旧版实际显示值，不改旧游戏、拥有记录、账号、会话或关系，不补造来源和历史。JSON v3 包含 `fieldHistory`，v1/v2 可以预览并恢复到空库，识别旧恢复指纹。v3 文件供新版本恢复；降级到 0.1.6 使用升级前快照。
- 搜索和候选预览走已登录的 GameShelf 服务端。使用短时有界缓存、每用户/来源限流、请求超时，遵循来源的 `Retry-After`；候选仅能由发起用户在有效期内提交。进程重启后，尚未保存的候选需要重新预览。外部接口失败不会写入库，也不阻断手动保存。
- 服务实际额度和获准用途以供应商账户和条款为准。参见 [IGDB 使用条件](https://api-docs.igdb.com/)、[RAWG API 条款](https://rawg.io/tos_api)、[TheGamesDB API 定义](https://github.com/TheGamesDB/TheGamesDBv2/blob/master/API/spec.yaml)、[ScreenScraper API 条件](https://www.screenscraper.fr/webapi2.php) 和 [SteamGridDB API](https://www.steamgriddb.com/api/v2)。GameShelf 不打包外部数据集或封面文件；含外部字段的 JSON 用于私有恢复。

```sh
npm test
npm run typecheck
npm run build
npm run test:metadata
docker compose --env-file .env.example config --quiet
```

`test:metadata` 使用脱敏的合成供应商响应、隔离 SQLite、生产服务器和桌面 / 390px 浏览器；检查旧库、锁定、双账号隔离、v1/v2/v3 恢复、错误脱敏及浏览器构建。真实凭据和真实 Unraid 验收单独记录。
