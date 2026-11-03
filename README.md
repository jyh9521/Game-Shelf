# GameShelf / 游戏收藏架

个人游戏收藏管理 Web 应用，支持 Docker 自托管，优先面向 Unraid。电脑和手机访问同一服务器，数据保存在服务器本地 SQLite 中。

## 当前状态

当前已发布版本与部署模板为 **0.1.6**，包含作品关系、判定历史与备份 v2，继续开发里程碑 1；尚未完成全部 MVP。镜像摘要、验证结果与升级步骤见 [0.1.6 发布说明](docs/releases/0.1.6.md)。

已实现管理员初始化与登录、作品增删改、多平台拥有记录、单份发行版本编辑、载体 / 获取方式 / 访问状态筛选、排序分页、状态评分与备注、标题别名搜索，以及 JSON 备份预览与空库恢复。

本批提前完成**原作 / 重制 / 复刻关系**：双向展示、搜索库内原作、编辑 / 解除关系和判定历史；作品与评分保持独立。新增两张关系表，JSON 导出升级至 **v2**，仍兼容 v1 备份迁移和幂等恢复，详见[作品关系与备份 v2](docs/GAME_RELATIONS.md)。

保留 0.1.5 的类型、未分类、拥有版本年份与未知年份筛选，组合条件绑定同一份拥有记录，候选随编辑刷新。详见[中间报告演示流程](docs/DEMO.md)与[开发进度](docs/PROGRESS.md)。

生产构建、HTTP 接口、桌面 / 手机浏览器和 Docker Desktop Linux/amd64 容器已有验证记录；容器重建后的持久化与 UID/GID 99:100 写库已验证。**真实 Unraid 设备仍待验收。**

封面上传、外部元数据、Steam 等账号连接、后台同步、标签合集、CSV 与定时备份尚未实现。需求范围见[修订版需求书](GameShelf_开发要求书_修订版.md)。

## 下载 / 部署

公开镜像：[jyh9521/gameshelf](https://hub.docker.com/r/jyh9521/gameshelf)，固定版本 `jyh9521/gameshelf:0.1.6`，平台 **linux/amd64**。没有 GitHub Release 安装包。

### Docker Compose

下载或克隆仓库后，在包含 `compose.yaml` 的目录运行：

```sh
docker compose pull
docker compose up -d --no-build --wait
```

访问 `http://服务器IP:3000`。默认将宿主 `./.data/docker` 挂载到容器 `/data`；首次设置管理员时读取该数据目录的 `setup-token` 文件。也可自行配置至少 24 字符的 `SETUP_TOKEN`，不使用公开默认密码。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `GAMESHELF_PORT` | `3000` | 宿主端口，冲突时选择其他空闲端口 |
| `GAMESHELF_DATA_DIR` | `./.data/docker` | 持久化数据目录 |
| `PUID` / `PGID` | `1000` / `1000` | 应用运行身份 |
| `APP_URL` | 空 | 反向代理后的完整访问地址 |
| `SECURE_COOKIE` | `false` | HTTPS 代理时设置为 `true` |

配置见 [compose.yaml](compose.yaml)。本地源码构建另用 `docker build -t gameshelf:local .`，避免覆盖已发布的固定版本标签。

SQLite 应放在服务器本地文件系统，不直接使用 SMB / NFS / WebDAV 挂载。0.1.4 入口降权前只修正应用自有验证码、SQLite 主库和 sidecar 的属主及 600 权限，不递归调整其他内容、不重置数据库；删除容器时保留宿主数据目录。

### Unraid

使用 [unraid/gameshelf.xml](unraid/gameshelf.xml) 模板，镜像地址为 `jyh9521/gameshelf:0.1.6`，可直接从 Docker Hub 拉取，不需要手动导入镜像或额外部署 PostgreSQL / Redis。

默认映射 `/mnt/user/appdata/gameshelf` → `/data`，UID/GID 为 `99:100`；按实际存储池与端口调整。首次初始化凭据位于 `/mnt/user/appdata/gameshelf/setup-token`。模板未声称已收录 Unraid 应用商店，实机验收仍待完成。

0.1.4 启动权限修复和既有库升级说明见[0.1.4 发布记录](docs/releases/0.1.4.md)。真实 NAS 验收仍需单独记录。

## 备份与恢复

“备份与恢复”页面可导出 JSON，包含已实现实体、作品关系与完整判定历史、时长和手动覆盖标记，不包含密码、会话或初始化凭据；封面仅备份 URL。当前源码导出 v2，旧 v1 导入时关系初始为空，预览显示迁移提示。旧 0.1.5 仍使用 v1；回退时配套使用升级前数据库与配置快照，而不是导入 v2 备份。

恢复只允许空库：先预览，再确认导入；格式、版本、引用与重复身份校验通过后事务写入，失败不写入。当前上传上限为 10 MiB，没有自动合并或覆盖已有库的模式。

数据库文件备份应使用 SQLite 一致性备份接口，或停止应用写入后再复制。升级前保留旧镜像、匹配的数据库和配置；仅降级镜像不会撤销数据库迁移。

## 本地开发与测试

需要 Node.js 24 LTS 和 npm：

```powershell
npm ci
node scripts/init-local.mjs
npm run db:generate
npm run db:migrate
npm run dev
```

访问 `http://127.0.0.1:3000`，初始化凭据位于本机 `.env` 的 `SETUP_TOKEN`；不提交 `.env`。生产模式使用 `npm run build` 和 `npm start`。

```sh
npm run typecheck
npm test
npm run build
docker compose config --quiet
npm run test:weekly
npm run test:relations
npm run test:release
```

`npm run test:weekly` 自建独立数据库、随机端口和测试凭据，验证本周筛选、桌面 / 手机、分页、编辑刷新、双账号隔离以及 JSON 往返恢复；结束后关闭测试服务器。Windows 默认使用已安装的 Edge，输出目录由 `QA_ARTIFACTS` 给出，含截图和虚构演示备份。

`npm run test:relations` 从隔离的旧 schema 和会话开始，检查加法迁移、关系增改解除与历史、双账号隔离、旧 v1 导入、v2 完整往返、非法文件无写入，以及桌面 / 390px 手机实际操作；不访问个人 `.data`。

`npm run test:release` 使用独立 Docker QA 卷验证 0.1.5 → 0.1.6 升级、权限修复、旧数据与会话保留、关系与历史、v1/v2 备份恢复、删除重建和旧镜像快照回退，不访问个人容器。

`tests/api-integration.mjs` 与 `tests/ui-smoke.mjs` 需要独立空测试库和端口 3100，包含创建、删除与恢复测试数据的操作，不用于个人实例。UI 测试使用已安装 Chrome；截图和测试备份写入忽略提交的 `engineering/`。万条数据基准只代表测试主机与样本，不等同于 Unraid 性能。

## 文档与工程约定

- [原始需求书](GameShelf_开发要求书.md) / [修订版需求书](GameShelf_开发要求书_修订版.md)
- [中间报告演示流程](docs/DEMO.md) / [开发进度](docs/PROGRESS.md) / [工程需求](docs/requirements.md)
- 使用锁文件与版本化 Prisma migrations；部署执行 `migrate deploy`。
- 不存放游戏本体或原始资产，测试使用人为 QA 记录。
- 元数据与账号适配器仍属后续阶段，未验证的平台不标记为已连接。
