# GameShelf

个人游戏收藏管理 Web 应用，Docker 自托管，优先面向 Unraid。电脑与手机访问同一服务器，本地 SQLite 保存数据。

## 当前阶段：开发里程碑 1（0.1.2）

已实现：管理员安全初始化与登录、手动登记/编辑/删除作品、多平台拥有记录、条目及单份发行版本编辑、载体/获取/访问筛选、列表排序、状态/评分/收藏/备注、标题与别名搜索、平台/商店/状态筛选、分页、平台新增、JSON 校验预览与空库恢复、手动资料覆盖标记。

已测试 Windows 上的生产构建、真实 HTTP 接口、备份恢复与桌面/手机浏览器。Docker 镜像已在 Docker Desktop 的 Linux/amd64 引擎构建并运行，健康检查、接口、桌面/手机界面、容器删除重建后的数据持久化均已验证。Unraid 模板已交付，并验证 UID/GID 99/100 可以完成迁移及写库；真实 Unraid 尚未验收，镜像已发布至 Docker Hub：jyh9521/gameshelf:0.1.2。不要将当前阶段称为 MVP 全部完成。

首版暂未实现：封面上传（目前仅保存远程引用）、RAWG/ScreenScraper、Steam 等账号连接、后台同步、字段来源历史/恢复自动更新、标签与合集、商品与合集关系、作品重制关系、CSV、定时备份。详情与编辑字段仍需逐步补齐第 45 节验收要求。

## 本地开发

需要 Node.js 24 LTS 和 npm（部署容器的用户无需安装开发工具）。

```powershell
npm ci
node scripts/init-local.mjs
npm run db:generate
npm run db:migrate
npm run dev
```

打开 http://127.0.0.1:3000。首次设置管理员时读取 `.env` 中的 `SETUP_TOKEN`，不会使用公开默认密码。密码仅要求非空，创建管理员需要两次输入一致；初始化凭据不在聊天、日志或普通备份中展示。不要提交 `.env`。

生产运行：`npm run build` 后 `npm start`。退出登录会使当前会话失效。

## Docker（已在 Docker Desktop 验证）

```sh
docker compose up -d --build --wait
```

本地镜像为 `gameshelf:0.1.2`，尚无远程发布镜像；已构建或导入镜像后可运行 `docker compose up -d --no-build --wait`。默认端口 3000，宿主 `./.data/docker` 挂载到 `/data`。首次初始化凭据在挂载目录 `setup-token`；也可配置至少 24 字符的 `SETUP_TOKEN`。

通过环境变量 `GAMESHELF_DATA_DIR`、`GAMESHELF_PORT`、`PUID`、`PGID` 调整目录、端口和运行身份。入口以 root 进行挂载根目录权限初始化，再使用 gosu 切换到指定 UID/GID；应用本身不以 root 运行。不递归调整现有数据库文件的权限，迁入数据时须先设置正确所有者。

SQLite 数据库必须置于服务器本地文件系统，不直接使用 SMB/NFS/WebDAV 挂载。删除容器不应删除 `/data` 的宿主目录。Compose 的环境与 `.env` 配置须避免把宿主开发数据库路径替换成容器路径。

HTTPS 代理：配置 `APP_URL=https://实际域名`、`SECURE_COOKIE=true`。局域网 HTTP 则保持 false。不要把未配置 HTTPS 的服务直接作为公开互联网服务；所有写操作都要求认证与来源校验。

## Unraid（待真实设备验收）

提供 `unraid/gameshelf.xml` 模板。Repository `gameshelf:0.1.2` 指向本地镜像，不是公共仓库地址。将 `artifacts/gameshelf-0.1.2-linux-amd64.tar` 与旁边的 SHA256 校验文件复制到目标 Unraid，核对校验和后执行 `docker load -i 实际镜像文件路径`，再使用模板。已在本机执行 save→load 验证镜像身份不变；不要求安装额外 PostgreSQL 或 Redis。

默认挂载 `/mnt/user/appdata/gameshelf` → `/data`，UID/GID 99/100。根据实际 appdata 存储池、端口、权限配置调整。不要假设模板会自动构建镜像或已收录应用商店。首次设置读取 `/mnt/user/appdata/gameshelf/setup-token`。

## 备份与恢复

“备份与恢复”页面导出 JSON，包含已实现的数据实体与关系、原始时长、手动替代值和字段锁定标记。密码、会话与初始化凭据不包含在文件中。封面只备份 URL，远程资源可能失效。

恢复仅允许空库，先选择文件查看预览，再确认导入。服务器执行格式/版本/引用/重复身份校验，随后事务写入；失败零写入。同一内容重复导入不重复建档。当前上传限额 10 MiB，更大备份需要后续分流导入实现；没有隐含的自动合并/覆盖模式。

服务器备份须使用 SQLite 一致性备份接口，或先停止所有应用写入再复制数据库及相关文件；运行中的主数据库文件不可当作单文件完整备份。升级前保留旧镜像标签、匹配旧库和配置；降级镜像不等于撤销数据库迁移。WebDAV 为后续增强。

## 测试

```sh
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

`tests/api-integration.mjs` 必须连接独立空测试库和端口 3100；它会初始化管理员、创建、删除、恢复测试数据，不能对个人使用实例执行。先创建空 SQLite 文件、设置绝对 `DATABASE_URL`、执行 migrate deploy，再 `npm start -- --port 3100`。测试读取本地 `.env` 的初始化凭据；测试密码仅用于隔离的 QA 数据库。

`tests/ui-smoke.mjs` 在同一隔离 QA 服务上调用已安装 Chrome 的无头模式，验证实际表单保存、时长编辑、手机布局和备份下载。截图与测试备份存于忽略提交的 `engineering/`。

`tests/benchmark.ts` 使用单独的 SQLite 库，测试 10,000 个作品及拥有记录。其结果只代表该主机与样本，不是 Unraid 实机或外部接口性能承诺。

## 工程约定

- 使用锁文件和版本化 Prisma migrations；部署只执行 migrate deploy，不运行破坏性 db push。
- 不存放或再分发原始游戏文件；测试样本均为人为 QA 记录。
- 元数据与账号适配器在下一阶段单独实现，未验证平台不标记已连接。
- SQLite 的关键是写事务与索引；未来多实例部署再独立评估 PostgreSQL 迁移。
- 当前无 GitHub 远程仓库、提交、推送或发布记录，发布地址由用户指定后设置。


## 0.1.2 核心库改进
- 首次设置验证码由服务器生成，删除随机按钮；读取数据目录 setup-token，既有凭据继续有效。
- 详情中的“修改版本”编辑该份内容的发行平台、地区、日期与 Edition，不改写其他拷贝共享的发行记录；“修改条目”仍负责商店、载体、访问状态与时长。
- 新增载体、获取方式、访问状态筛选与重置按钮；组合条件命中同一拥有记录。
- 排序支持标题升/降序、添加时间升/降序、资料更新时间；稳定 ID 保证分页。同名标题按 SQLite 标题顺序，不承诺拼音排序。
- 没有新增数据库字段，沿用 JSON schema_version=1；编辑后的内容/发行/Edition 关系包含在备份与空库恢复中。

## Docker Hub 发布（2026-10-13）
公开地址：https://hub.docker.com/r/jyh9521/gameshelf
镜像：`jyh9521/gameshelf:0.1.2`；另提供 `latest`，当前与 0.1.2 相同。
平台：linux/amd64。版本摘要：`sha256:92f0ed75008a31b6cd33c289730287a5181fd2d338e2065b6915defe47676344`。
拉取：`docker pull jyh9521/gameshelf:0.1.2`。Compose 与 Unraid 模板已更新，原数据挂载保持不变。
暂停开发状态不变，本次仅发布已有测试镜像。
