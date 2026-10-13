# GameShelf 开发要求书

## 1. 项目名称

**GameShelf**

副标题：**跨平台游戏库统一管理系统**

---

## 2. 项目目标

开发一个用于统一管理个人游戏收藏与游玩记录的 Web 应用。

系统需要能够整合 Nintendo、PlayStation、Xbox、Steam、GOG、Epic Games Store 等多个游戏平台的游戏库信息，并支持手动添加游戏。

对于能够通过官方接口、公开接口或合法授权方式获取数据的平台，应尽可能实现账号连接与游戏库自动同步。

对于无法直接获取完整游戏库的平台，应提供手动导入或手动登记作为补充方案。

---

## 3. 核心开发要求

### 3.1 跨平台账号接入

系统需要支持接入当前主流主机平台账号。

计划支持：

- Nintendo
- PlayStation
- Xbox

基本要求：

1. 用户可在 GameShelf 中添加对应平台账号。
2. 在平台允许的情况下，通过网页登录、OAuth 或其他官方授权方式完成认证。
3. 自动获取用户账号内可访问的游戏信息。
4. 将获取到的游戏导入 GameShelf 游戏库。
5. 保存外部平台的游戏 ID、账号 ID、同步时间等必要信息。
6. 支持手动重新同步。
7. 支持解除账号绑定。
8. 不保存用户的游戏平台密码。
9. 认证 Token 等敏感信息必须仅保存在服务端，并采用安全方式存储。

---

## 4. 主机平台识别

系统需要尽可能自动识别游戏所属平台。

### Nintendo

- Nintendo Switch
- Nintendo Switch 2

内部代号建议：

- NS1
- NS2

### PlayStation

- PlayStation
- PlayStation 2
- PlayStation 3
- PlayStation 4
- PlayStation 5

内部代号建议：

- PS1
- PS2
- PS3
- PS4
- PS5

### Xbox

- Xbox
- Xbox 360
- Xbox One
- Xbox Series X|S

内部代号建议：

- XBOX
- XBOX360
- XBOXONE
- XBOXSERIES

平台识别时需要区分：

- 游戏最初发行平台
- 用户实际拥有的版本
- 当前可运行的平台

避免将“原始平台”和“当前运行平台”混为一谈。

---

## 5. PC 游戏平台接入

系统需要支持以下 PC 游戏平台：

- Steam
- GOG
- Epic Games Store

基本要求：

1. 用户可以添加并管理多个 PC 平台账号。
2. 能够自动获取的数据应自动同步。
3. 保存平台提供的唯一游戏 ID。
4. 导入游戏标题、游玩时间、最后游玩时间等可获取信息。
5. 支持后续增加其他平台 Connector。

未来可扩展：

- Ubisoft Connect
- EA app
- Battle.net
- itch.io

---

## 6. Connector 架构

每个平台的接入逻辑必须彼此独立。

建议目录结构：

```text
/connectors
  /steam
  /xbox
  /playstation
  /nintendo
  /gog
  /epic
  /rawg
  /screenscraper
```

所有平台尽量遵循统一接口，例如：

```text
connect()
disconnect()
syncLibrary()
getProfile()
getGames()
getPlaytime()
```

目标是：

- 某个平台接口变化时，不影响整个系统。
- 后续能够方便增加新的游戏平台。
- 不把业务逻辑直接写死在主程序中。

---

## 7. 手动新建游戏

系统必须支持手动添加游戏。

即使某游戏无法从游戏平台账号读取，也应该可以进入 GameShelf。

手动添加时至少支持填写：

- 游戏标题
- 原始标题
- 本地化标题
- 平台
- 发售日期
- 开发商
- 发行商
- 游戏类型
- 封面
- 简介
- 所有形式
- 游玩状态
- 游玩时间
- 评分
- 备注
- 标签

---

## 8. RAWG 与 ScreenScraper 接入

系统需要接入：

- RAWG
- ScreenScraper

用途：

- 搜索游戏
- 自动补全游戏资料
- 获取封面
- 获取发售日期
- 获取平台
- 获取开发商
- 获取发行商
- 获取游戏类型
- 获取简介
- 获取截图或相关媒体信息

建议分工：

### RAWG

优先用于：

- PC 游戏
- 较新的主机游戏
- 主流现代游戏

### ScreenScraper

优先用于：

- 老游戏
- 主机游戏
- 街机游戏
- 复古游戏平台

---

## 9. 游戏信息自动补全

用户输入游戏标题后，可主动搜索外部数据库。

流程建议：

```text
输入游戏名
↓
搜索 RAWG / ScreenScraper
↓
显示候选结果
↓
用户选择正确游戏
↓
自动填充游戏信息
↓
用户确认
↓
保存
```

系统不能因为外部 API 数据错误而阻止用户修改。

所有自动补全字段必须允许手动覆盖。

---

## 10. 游戏数据结构

系统需要区分以下概念：

### Game

代表“游戏作品本身”。

例如：

```text
Resident Evil 4
```

### Release

代表某个具体平台发行版本。

例如：

```text
Resident Evil 4 - GameCube
Resident Evil 4 - PlayStation 2
Resident Evil 4 - PC
```

### Edition

代表同一个发行版本下的不同版本。

例如：

```text
Standard Edition
Deluxe Edition
Ultimate Edition
GOTY Edition
Remastered
Remake
```

### Library Item

代表“用户实际拥有的某一份游戏”。

例如：

```text
Resident Evil 4
Steam
Digital
Owned
```

不要把以上内容全部塞进同一张 games 表。

---

## 11. 重复游戏识别与合并

系统必须考虑同一款游戏存在多个平台版本的情况。

例如：

```text
The Witcher 3
- Steam
- GOG
- PS4
- Nintendo Switch
```

在游戏库中应尽量作为同一个游戏展示。

但每个拥有版本必须单独保存。

需要保留：

- 平台
- 商店
- 版本
- 所有形式
- 平台独立游玩时间
- 平台独立成就信息
- 平台独立同步状态

---

## 12. 外部 ID 管理

系统必须保存外部平台的唯一 ID。

建议建立：

```text
external_ids
```

例如：

```text
GameShelf ID
Steam AppID
RAWG ID
ScreenScraper ID
GOG Product ID
Epic Product ID
```

用途：

- 自动识别同一游戏
- 防止重复导入
- 更新已有游戏信息
- 进行多数据源匹配

---

## 13. 游戏自动匹配逻辑

从外部平台导入游戏时，按照以下优先级尝试匹配：

### 第一优先级

外部唯一 ID 完全一致。

结果：

- 自动匹配
- 自动更新

### 第二优先级

标题 + 平台 + 发售年份一致。

结果：

- 高概率自动匹配

### 第三优先级

标题高度相似。

结果：

- 提示用户确认

### 第四优先级

无匹配结果。

结果：

- 新建游戏记录

---

## 14. 所有形式

每个 Library Item 需要记录所有形式。

建议包括：

- 实体版
- 数字版
- 订阅服务
- 家庭共享
- 借用
- 其他

内部可使用：

```text
PHYSICAL
DIGITAL
SUBSCRIPTION
FAMILY_SHARED
BORROWED
OTHER
```

---

## 15. 订阅服务支持

订阅游戏不能与“永久拥有”完全等同。

需要支持：

- Xbox Game Pass
- PlayStation Plus
- Nintendo Switch Online

所有状态可区分：

```text
OWNED
SUBSCRIPTION
BORROWED
WISHLIST
```

---

## 16. 游玩状态

游戏应支持以下个人状态：

- 未游玩
- 游玩中
- 已通关
- 已完成
- 暂停
- 放弃
- 待游玩

建议内部枚举：

```text
UNPLAYED
PLAYING
CLEARED
COMPLETED
ON_HOLD
DROPPED
BACKLOG
```

---

## 17. 游玩时间

系统应支持：

- 从平台 API 自动读取游玩时间
- 手动修改游玩时间
- 分平台记录
- 合计显示

例如：

```text
The Witcher 3

Steam       85h
PS4         40h
Switch      20h
----------------
Total      145h
```

---

## 18. 评分系统

用户可以为游戏设置个人评分。

基础版本：

- 1～5 星评分
- 收藏标记
- 个人备注

未来可扩展：

- 剧情评分
- 游戏性评分
- 音乐评分
- 画面评分
- 综合评分

---

## 19. 搜索功能

需要支持按以下字段搜索：

- 游戏标题
- 原名
- 本地化名称
- 开发商
- 发行商

---

## 20. 筛选功能

至少支持：

- 平台
- 游戏商店
- 类型
- 发售年份
- 游玩状态
- 所有形式
- 评分
- 收藏状态

---

## 21. 排序功能

至少支持：

- 标题
- 发售日期
- 添加日期
- 最近游玩时间
- 游玩时间
- 个人评分

---

## 22. 游戏详情页面

游戏详情页至少显示：

- 封面
- 游戏标题
- 原始标题
- 平台
- 发售日期
- 开发商
- 发行商
- 类型
- 简介
- 所有版本
- 所有平台
- 游玩时间
- 游玩状态
- 用户评分
- 标签
- 用户备注
- 数据来源

---

## 23. Dashboard

首页需要提供游戏库概览。

建议显示：

- 游戏总数
- 永久拥有游戏数
- 订阅游戏数
- 正在游玩数量
- 已通关数量
- 未游玩数量
- 各平台游戏数量
- 各商店游戏数量
- 最近添加
- 最近游玩

---

## 24. Collections 收藏夹

用户可以建立自定义合集。

例如：

- 最喜欢的游戏
- JRPG
- 银河城
- 今年通关
- 待汉化
- 实体收藏
- 怀旧游戏

同一个游戏可以加入多个 Collection。

---

## 25. 标签系统

支持用户自定义标签。

例如：

```text
#日语
#中文
#汉化
#复古
#实体收藏
#待通关
#童年
```

---

## 26. 数据来源追踪

每个可编辑字段应尽量保存数据来源。

例如：

```text
title -> RAWG
cover -> ScreenScraper
playtime -> Steam
memo -> Manual
```

来源类型建议：

```text
MANUAL
PLATFORM
RAWG
SCREENSCRAPER
IMPORT
```

---

## 27. 手动覆盖保护

用户手动修改过的数据不能在下一次同步时被自动覆盖。

例如：

```text
title:
AUTO

cover:
MANUAL_OVERRIDE

description:
AUTO
```

同步程序必须识别哪些字段已经被用户手动锁定。

---

## 28. 同步功能

支持：

- 全部账号同步
- 单个平台同步
- 单个账号同步
- 手动重新同步
- 后续可加入自动定时同步

---

## 29. 同步历史

保存同步日志。

例如：

```text
2026-10-06 10:45
Steam
成功
新增 3
更新 12
跳过 2
```

失败时：

```text
PlayStation
认证失败
```

同步失败不能破坏现有游戏库。

---

## 30. 导入与导出

至少支持：

- JSON
- CSV

后续可以增加：

```text
.gameshelf
```

作为完整备份格式。

---

## 31. 数据备份

系统应允许用户导出完整游戏库。

备份内容至少包含：

- 游戏
- 平台
- 用户库
- 评分
- 游玩状态
- 备注
- 标签
- Collection
- 外部 ID

敏感认证 Token 不应包含在普通导出文件中。

---

## 32. 账号管理页面

页面建议：

```text
Accounts
```

每个平台显示：

- 平台名称
- 用户名
- 连接状态
- 最后同步时间
- 同步按钮
- 解除绑定按钮

---

## 33. UI 主导航

建议主菜单：

```text
Dashboard
Library
Platforms
Collections
Statistics
Accounts
Settings
```

---

## 34. 响应式设计

系统需要支持：

- PC
- 平板
- 手机

PC 为主要开发目标。

手机端至少应保证：

- 可以浏览游戏库
- 可以搜索
- 可以查看详情
- 可以修改状态

---

## 35. 技术栈

建议开发环境：

### 前端

- Next.js
- React
- TypeScript

### 后端

- Next.js Server
- REST API 或 Server Actions

### ORM

- Prisma

### 数据库

优先：

- PostgreSQL

开发初期也可使用：

- SQLite

### 样式

可选择：

- CSS Modules
- Tailwind CSS
- Material UI

---

## 36. 建议数据库表

初期建议包含：

```text
users
accounts
games
game_releases
game_editions
platforms
stores
library_items
genres
game_genres
developers
publishers
collections
collection_items
tags
game_tags
external_ids
sync_jobs
field_sources
```

后续视需要追加。

---

## 37. 安全要求

必须遵守以下原则：

1. 不保存游戏平台账号密码。
2. 优先使用 OAuth 或官方认证机制。
3. Token 仅保存在服务端。
4. Token 不发送给浏览器前端。
5. Token 不写入 Git 仓库。
6. API Key 使用环境变量。
7. `.env` 不提交 GitHub。
8. 支持解除账号绑定。
9. 解除绑定时删除相关认证信息。

---

## 38. API Key 管理

以下密钥必须使用环境变量管理：

- RAWG API Key
- ScreenScraper API Credentials
- Steam API Key
- 其他外部平台授权信息

示例：

```env
RAWG_API_KEY=
SCREENSCRAPER_USER=
SCREENSCRAPER_PASSWORD=
STEAM_API_KEY=
DATABASE_URL=
```

---

## 39. 开发阶段

### Phase 1：基本游戏库

首先完成：

- 数据库
- 游戏手动新建
- 游戏列表
- 游戏详情
- 编辑
- 删除
- 搜索
- 基础筛选

目标：

即使所有外部 API 都不可用，GameShelf 本身仍然可以正常使用。

---

### Phase 2：元数据补全

接入：

- RAWG
- ScreenScraper

实现：

- 游戏搜索
- 候选结果
- 自动填充信息
- 封面获取
- 手动确认

---

### Phase 3：Steam Connector

优先完成 Steam 接入。

实现：

- 账号关联
- 游戏库读取
- Steam AppID 保存
- 游戏导入
- 游玩时间同步
- 游戏自动匹配

---

### Phase 4：重复游戏合并

实现：

- 外部 ID 匹配
- 游戏标题匹配
- 多平台版本关联
- 重复项确认页面

---

### Phase 5：其他平台 Connector

按实际接口可行性逐步实现：

- Xbox
- GOG
- Epic Games Store
- PlayStation
- Nintendo

要求：

不能因为某个平台暂时无法接入而影响整个项目完成。

---

### Phase 6：完善功能

实现：

- Dashboard
- Collections
- Tags
- Statistics
- Import / Export
- Sync History
- Mobile UI

---

## 40. α 版最低完成目标

α 版至少必须完成：

- 游戏手动登记
- 游戏编辑
- 游戏删除
- 游戏列表
- 游戏详情
- 平台管理
- RAWG 搜索
- ScreenScraper 搜索
- Steam 同步
- 游玩状态
- 评分
- 搜索
- 筛选

---

## 41. β 版目标

β 版计划完成：

- 游戏自动匹配
- 重复游戏合并
- 多平台版本
- Collections
- Tags
- Dashboard
- 统计
- JSON / CSV 导出
- 同步历史

---

## 42. 正式版目标

根据实际 API 可用性，尽可能加入：

- Xbox
- GOG
- Epic
- PlayStation
- Nintendo

同时完善：

- UI
- 错误处理
- 数据备份
- 响应式布局
- 同步稳定性
- 性能优化

---

## 43. 项目设计原则

本项目开发过程中需要始终遵守以下原则：

### 1. 核心功能不能依赖外部 API

即使所有游戏平台接口暂时不可用，用户仍然能够手动管理完整游戏库。

### 2. 外部平台采用可插拔 Connector

避免平台接口变化导致整个系统无法运行。

### 3. Game、Release、Library Item 分离

正确处理同一游戏的多个版本和多个平台。

### 4. 用户修改优先

任何自动同步都不能无条件覆盖用户手动修改的数据。

### 5. 外部 ID 必须保存

避免重复导入，提高自动匹配准确率。

### 6. 所有数据都应允许人工修正

不能完全依赖第三方数据库。

### 7. 先完成最小可用版本，再增加平台接入

开发顺序必须优先保证学校项目能够按时完成。

---

## 44. 最终项目定位

GameShelf 不是单纯的游戏平台账号展示工具。

最终定位为：

> 一个能够统一管理数字版、实体版、订阅版以及多个游戏平台账号游戏库的个人游戏收藏管理系统。

其核心价值是：

- 多平台统一
- 多数据源整合
- 自动同步
- 手动补全
- 游戏版本识别
- 收藏管理
- 游玩记录管理
- 长期可扩展
