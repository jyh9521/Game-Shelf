# 作品关系与备份 v2

2026-11-02 完成本批本地核心功能，2026-11-03 纳入 0.1.6。镜像发布状态、摘要与升级回退步骤见 [0.1.6 发布说明](releases/0.1.6.md)。

## 使用与语义

- 在**重制 / 复刻作品**详情选择「关联原作」，搜索本人库内的另一款作品，直接选择「重制自」或「复刻自」，填写判定依据并保存。
- `REMAKE_OF` / `REMASTER_OF` 始终表示 **source（派生作品）→ target（原作）**。原作详情反向显示「重制作品 / 复刻作品」，点击名称可进入另一作品详情。
- 候选按稳定标题排序分页，可以搜索标题、原名、别名、开发商；候选显示拥有平台、日期和 ID 片段，名称相同不自动关联。
- 可编辑类型和依据；端点固定，改原作时先解除旧关系再建立新关系。解除只删除链接，不合并 / 删除作品、拥有记录、时长、评分和备注。
- 每次建立、实际修改和解除均保留类型、依据、时间和递增 revision。原值保留；重复保存相同值不追加历史。界面显示最近 100 条，JSON 包含全部历史。
- 自身关联、重复有向边、反向和间接循环均被拒绝。关系不表示续作、Edition、DLC、合集内容或作品合并。

## 数据与接口

- `GameRelation` 保存当前链接；`GameRelationEvent` 保存判定快照及 CREATE / UPDATE / DELETE 事件。事件不外键指向当前链接，因此解除后仍可追溯。
- 手工判断按 `userId` 隔离，不直接更改共享 Game 元数据；读写均要求本人有两端的 UserGameProfile。创建和修改在同一事务内完成关系与历史写入。
- 删除本人作品时，同时清理本人涉及该作品的关系和历史；其他用户保留的作品、关系与历史不变。删除对话框明确提示，删除前应保留备份。
- `GET /api/games/:id/relations` 返回双向关系和最近判定历史。
- `POST /api/games/:id/relations` 输入 `{targetGameId,type,note}`。
- `PUT /api/relations/:id` 输入 `{type,note}`；`DELETE /api/relations/:id` 解除关系。
- 写入沿用登录、请求头和同源校验。枚举和字段严格验证，缺少目标 / 越权返回 404，非法关系返回 400。

## 迁移与备份

- 新增 `20261102000000_game_relations` 加法迁移，只创建两张关系表及索引，不重写旧实体或凭据。
- 新导出使用 `schema_version=2`，新增 `relations` 与 `relationHistory`。包含独立 ID、两端 Game ID、类型、依据、revision 与 UTC 时间，不包含 userId、密码、会话或 setup token。
- 继续读取严格 v1 文件，在内存中迁移为 v2：原有实体原样保留，两个新集合为空，不按标题猜测关联。预览显示迁移提示和关系 / 历史数量。
- 恢复前校验所有引用、本人档案、重复 ID、有向无环关系、连续事件序号、删除快照及最新事件与当前链接的一致性。失败不写库；恢复仍仅支持空实例。
- 旧版本已导入的 v1 内容指纹仍被识别；v2 备份调整实体 / 历史排列顺序也可幂等重试。
- **旧 0.1.5 不能读取 v2 JSON。** 回退到旧应用应使用升级前一致性数据库快照及匹配配置；不能只把新 JSON 的版本号改为 1，否则会丢失关系和历史。
- 本次没有对个人 `.data` 执行迁移。源码回滚脚本仅还原源文件，不对任何运行中数据库执行降级。

## 自动验收

```powershell
npm run db:generate
npm test
npm run typecheck
npm run build
npm run test:relations
npm run test:weekly
```

`test:relations` 自建旧 schema SQLite、测试管理员和会话，迁移后逐项比较旧数据，验证完整关系操作、权限、桌面 / 390px 交互、候选分页、JSON v1 迁移 / v2 往返及失败无写入。所有操作只访问隔离 QA 库，结束关闭服务器。浏览器阻止外部请求。

末尾 `QA_ARTIFACTS` 提供 `relations-desktop.png`、`relations-mobile.png`、`demo-backup-v2.json` 与迁移 / 服务日志。测试备份只含虚构样本。旧版基线使用 `node tests/relations-smoke.mjs --baseline`，应观察关系接口 404、备份 v1 和旧会话正常。

当前批次不包含字段来源历史 / 解除手动覆盖、外部元数据或 Steam。关系判定历史与未来字段来源历史是不同概念。真实 Unraid 升级与学校演示仍单独验收。
