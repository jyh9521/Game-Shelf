# 开发进度

## 已确定

Docker 自托管 Web 应用，Unraid 优先，个人管理员，SQLite；Next.js/React/TypeScript/Prisma。SQLite 和接口验证均使用隔离 QA 数据库，正式库的初始化由用户完成，测试不写入个人库。

## 里程碑 1

实现核心手动库与 JSON 空库恢复；基础实体为 Game、Release、Edition、Library Item、Library Item Content、User Game Profile。目录中保留原稿和要求书修订工具，构建上下文排除这些历史工具。

运行测试及截图见 engineering/；它们不进入镜像或版本库。尚未完成整个 MVP。Docker Desktop Linux/amd64 的构建、运行、58 项接口检查、桌面/手机操作、数据持久化及 UID/GID 99/100 迁移写库均通过；真实 Unraid 验收待执行。QA 使用独立卷；0.1.2 更新时正式容器已由用户初始化，升级保留个人库和会话。

## 下一步

1. 本机 Docker 部署已完成：镜像 gameshelf:0.1.2；预览 http://127.0.0.1:3000；导出的镜像及 SHA256 位于 artifacts/。下一步在 Unraid 导入镜像并实测模板。
2. 补齐作品关系、来源历史/解除覆盖、发行版本编辑与更多筛选，扩充备份格式并升级版本号。
3. 在核心验收通过后接入首个元数据源和 Steam，保持失败不破坏本地库。

不会在当前阶段自动连接外部平台或将应用推送到未指定的 GitHub 仓库。

## 0.1.1 管理员初始化改进
密码取消 12 字符门槛（非空、上限 128）；创建时前后端校验重复密码；凭据右侧随机按钮通过当前凭据认证后轮换服务器密钥并持久保存。测试与部署证据见 engineering/auth-update/VERIFICATION.txt。

## 0.1.2 核心库补齐
本轮：单份拥有内容版本关联编辑、载体/获取/访问筛选、五种稳定排序、筛选重置；删除随机凭据入口，改称首次设置验证码。未新增数据库结构；备份仍为 schema_version=1。作品关系、来源历史/解除覆盖、更多类型/年份/评分筛选与外部资料源留待后续。验证见 engineering/core-update/VERIFICATION.txt。
