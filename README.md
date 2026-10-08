# 水印清理 · 微信小程序（MySQL 后端版）

一个**只处理自有素材水印**的工具类小程序。图片全本地处理（不上传原图），视频由自建后端的 FFmpeg 处理。数据全部存 **MySQL**，后台支持对小程序的**完整权限管理**（用户封禁 / 角色分配 / 独享配额 / 管理员白名单）。

> ⚠️ 合规定位：本工具面向「清理自有素材上的水印」。请在「关于」与隐私政策中保持这一表述，不要使用「去除他人作品水印」类文案。上传他人作品去水印可能构成侵权。

---

## 一、架构总览

```
┌──────────────┐   wx.request / wx.uploadFile    ┌──────────────────────────────┐
│  微信小程序   │ ───────────────────────────────▶ │  Node.js 后端 (server/)       │
│  miniprogram │ ◀──────────────── JSON + 文件 ── │  Express + JWT + FFmpeg 队列  │
└──────────────┘                                  └───────────┬──────────────────┘
                                                              │ mysql2
┌──────────────┐   fetch + Bearer Token           ┌───────────▼──────────────────┐
│ Web 管理后台  │ ───────────────────────────────▶ │  MySQL (5 张表)               │
│ admin-web    │ ◀─────────────────────────────── │  wc_users / wc_jobs / ...     │
└──────────────┘                                  └──────────────────────────────┘
```

- **图片线**：小程序本地 Canvas 处理 → 只上传成品 + 缩略图 → 后端落盘 + MySQL 记账
- **视频线**：上传源视频 → 后端入队 → FFmpeg 转码（进度实时回写）→ 轮询取结果
- **管理后台**：小程序内（`packageAdmin` 分包）+ 独立 Web（`admin-web/index.html`，零依赖单文件）

> 说明：`cloudfunctions/` 与 `video-service/` 是旧「微信云开发版」的遗留实现，**MySQL 版不再需要**，可整目录删除。

## 二、目录结构

```
watermark-cleaner/
├── miniprogram/            # 小程序（改 1 个文件即可对接后端）
│   ├── utils/constants.js  #   ★ API_BASE_URL 在这里
│   ├── utils/cloud.js      #   HTTP 封装（接口签名与旧版一致）
│   ├── app.js              #   wx.login → /api/login/signIn
│   ├── pages/              #   首页 / 图片编辑 / 视频编辑 / 结果 / 记录 / 我的
│   ├── packageAdmin/       #   小程序内管理后台（6 页）
│   └── packageCommon/      #   关于 / 隐私 / 公告
├── server/                 # ★ 后端服务（MySQL 版）
│   ├── db/schema.sql       #   建库建表脚本
│   ├── lib/                #   JWT / 配额 / 文件 / FFmpeg / 滤镜图
│   ├── routes/             #   login / job / videoProc / admin / upload
│   ├── services/videoQueue.js  # 视频处理队列（并发 1）
│   └── server.js           #   入口（含定时清理）
├── admin-web/index.html    # Web 管理后台（单文件，双击即用）
├── design/ui-design.html   # 界面设计稿
├── cloudfunctions/         # （旧版遗留，可删）
└── video-service/          # （旧版遗留，可删）
```

## 三、五步部署

### 1. 建库

```bash
mysql -u root -p < server/db/schema.sql
```

自动创建 `wc_watermark` 库与 5 张表：`wc_users`（用户与配额）、`wc_jobs`（任务）、`wc_admins`（管理员白名单）、`wc_logs`（操作日志）、`wc_settings`（单行全局配置）。

### 2. 配置后端

```bash
cd server
npm install
cp .env.example .env    # 填写：DB_PASSWORD / JWT_SECRET / WX_APPID / WX_SECRET
```

`.env` 关键项：

| 变量 | 说明 |
|---|---|
| `DB_*` | MySQL 连接（对应 schema.sql 建的库） |
| `JWT_SECRET` | 改成随机长字符串 |
| `WX_APPID` / `WX_SECRET` | 小程序凭证；**不填则走开发模式**（openid 用 code 哈希模拟，仅限本地调试） |
| `UPLOAD_DIR` | 文件存储目录，默认 `server/uploads` |
| `INIT_ADMIN_KEY` | 可选：指定初始后台密钥（不填自动随机生成） |

### 3. 启动

```bash
node server.js
```

启动日志会打印：

```
★ 已生成后台访问密钥（请立即保存）：xxxxxxxxxxxxxxxx
✓ 服务已启动: http://localhost:3000
```

> FFmpeg：视频功能需要 `ffmpeg` / `ffprobe`。**本项目已内置**（`tools/bin/ffmpeg.exe`，v6.1.1），并在 `server/.env` 中通过 `FFMPEG_PATH` 指向它，无需额外安装。
> 换机器或丢失时用 `node tools/get-ffmpeg.js` 自动补装；仅影响视频线，图片线不受影响。

### 4. 对接小程序

**本地开发用 `node tools/doctor.js` 一键自检环境**（Node / MySQL / 数据表 / FFmpeg / 端口 / 小程序地址 / AppID 共 8 项）。

编辑 `miniprogram/utils/constants.js`：

```js
const API_BASE_URL = 'https://your-domain.com';   // 换成你的后端地址
```

- 本地调试：开发者工具 → 详情 → 本地设置 → 勾选「不校验合法域名」，用 `http://localhost:3000`
- 正式上线：必须是 **https + 备案域名**，并在「小程序后台 → 开发设置 → 服务器域名」把域名加入 **request 与 uploadFile 合法域名**

### 5. 登录后台

双击打开 `admin-web/index.html`（或托管到任意静态服务器）：

1. 填后端地址 + 启动日志里的密钥 → 登录
2. 第一次进小程序产生真实用户后，到「用户权限」→ 管理 → 「设为管理员」把对方加入白名单，对方即可用小程序端后台

## 四、权限管理（核心能力）

| 维度 | 说明 |
|---|---|
| **用户封禁 / 解封** | 封禁后该 openid 所有请求立即被拒（403），可填封禁原因 |
| **角色分配** | `operator`（只读）与 `super`（可写），写入 `wc_admins` 白名单，小程序端后台按此降权 |
| **独享配额** | 按用户覆盖每日图片/视频次数，填 0 = 跟随全局配置 |
| **删除用户** | 连同其全部任务与磁盘文件 |
| **管理员白名单** | 新增 / 移除小程序端管理员（Web 后台不受白名单限制，凭密钥即 super） |
| **全局配置** | 配额、视频开关、注册开关、公告、版权提示、密钥轮换 |

**鉴权模型**（服务端 `lib/auth.js`，三选一）：

1. 密钥令牌 —— Web 后台用密钥换 JWT，`role = super`
2. 用户令牌 + 白名单 —— 小程序管理员，角色按 `wc_admins` 记录
3. 请求体 `__key` —— 小程序端旧流程兼容，等于 `adminKey` 即 super

所有写操作要求 `super`；`operator` 只能读。全部动作记入 `wc_logs`。

## 五、接口一览（POST，信封 `{code, data, msg}`）

| 模块 | 动作 | 鉴权 |
|---|---|---|
| `/api/login` | signIn / profile / updateProfile / quota / stats / consume | signIn 免鉴权，其余用户令牌 |
| `/api/job` | create / list / detail / remove / removeAll / retry / stats / markSaved | 用户令牌（只能操作自己） |
| `/api/videoProc` | submit / status / service | 用户令牌 |
| `/api/admin` | login / check / overview / users / userDetail / userUpdate / jobs / jobUpdate / settings / settingsUpdate / logs / admins / adminAdd / adminRemove / cleanData | 管理鉴权（见上） |
| `/api/upload` | multipart 上传（`file` + `dir` 字段） | 用户令牌 |
| `/api/file/remove` | 删除文件 | 用户令牌 |
| `/files/*` | 成品文件静态访问 | 公开（建议生产加防盗链） |
| `/healthz` | 健康检查 | 公开 |

业务码：`0` 成功 / `401` 未登录 / `403` 无权限或封禁 / `404` 不存在 / `429` 配额用完 / `500` 服务异常。

## 六、数据表

| 表 | 用途 | 关键字段 |
|---|---|---|
| `wc_users` | 用户与配额 | `openid`(唯一)、`banned`/`ban_reason`、`limit_image`/`limit_video`(0=跟随全局)、`used_*`/`used_*_date`(跨天重置) |
| `wc_jobs` | 处理任务 | `id`、`openid`、`type`(image/video)、`status`、`progress`、`src_file`/`out_file`/`thumb_file`、`expires_at` |
| `wc_admins` | 管理员白名单 | `openid`(唯一)、`role`(operator/super) |
| `wc_logs` | 操作日志 | `action`、`detail`、`operator` |
| `wc_settings` | 全局配置（单行） | 配额 / 开关 / 文案 / `admin_key` |

配额扣减是**单条原子 UPDATE**（跨天重置 + 上限 + 封禁校验合一），并发不会超扣。

## 七、视频处理原理

1. 小程序上传源视频 → `/api/upload`（`formData.dir = 'src/videos'`）
2. `/api/videoProc/submit`：校验开关与时长上限 → 原子扣视频配额 → 任务落库 `pending` → 入队
3. 队列（并发 1）：`ffprobe` 探测 → 构建滤镜图 → `ffmpeg -filter_complex ... -progress pipe:1` 转码，进度节流回写 MySQL（映射到 10%–95% 区间）
4. 完成：产物落 `output/videos/<id>.mp4`、设 `expires_at`、删源文件；音轨直拷失败自动退回 aac 重编码
5. 小程序 3 秒轮询 `/api/videoProc/status`；服务端每 30 分钟清理过期任务 / 回收卡死任务 / 清 90 天前日志

滤镜图统一走「带内边距裁剪 → 局部处理（boxblur / delogo / 马赛克）→ overlay 原位叠加」，时间区间只在 `overlay` 的 `enable` 上控制，规避 `boxblur`/`delogo` 对时间轴支持不稳定的坑。

## 八、排查表

| 现象 | 原因 / 处理 |
|---|---|
| 小程序提示「尚未配置后端地址」 | `constants.js` 里 `API_BASE_URL` 还是占位值 |
| 「域名未加入合法域名」 | 小程序后台加 request/uploadFile 域名，或开发时勾选「不校验合法域名」 |
| 「无法连接后端服务」 | server 没启动 / 端口不对 / 防火墙 |
| 登录返回「微信登录失败 40029」 | code 无效（AppID 与密钥不匹配，或 code 已被用） |
| openid 是 `dev_xxx` | 未配置 `WX_APPID/WX_SECRET`（开发模式） |
| 提示「无管理权限」 | 密钥错误，或用户不在白名单；先在 Web 后台核对 |
| 视频提交报「功能未开启」 | 配置页打开「启用视频处理」开关 |
| 视频一直排队 | 服务器没装 FFmpeg；用 `/api/videoProc/service` 探测 |
| 图片任务成功但列表图挂了 | `/files/` 路径被 Nginx 拦截；确认静态目录映射到 `server/uploads` |
| 429 频繁 | 全局配额太紧，或给该用户配独享配额 |

## 九、上线检查清单

- [ ] `.env`：`JWT_SECRET` 已改、`WX_APPID/SECRET` 已填（退出开发模式）
- [ ] MySQL 定期备份已配置（`node tools/backup.js`，见 §十一）
- [ ] https 证书 + 域名备案完成，域名已加入小程序 request/uploadFile 白名单
- [ ] FFmpeg 已安装且 `/api/videoProc/service` 返回 `available: true`
- [ ] 启动日志打印的后台密钥已妥善保存（或用 `INIT_ADMIN_KEY` 指定）
- [ ] 磁盘监控：上传目录会随使用增长，靠 `cloudKeepHours` + 定时清理兜底
- [ ] Nginx 反向代理时把 `client_max_body_size` 调到 ≥ 200m（视频上传）
- [ ] `admin-web` 不要公网裸放，建议加 IP 白名单或basic auth

## 十、合规提示（审核相关）

- 类目建议：工具 → 图片/视频处理
- 全部文案保持「清理自有素材水印」表述
- 隐私政策已内置（`packageCommon/pages/privacy`），需在小程序后台填写《用户隐私保护指引》并声明相册写入用途
- 后台 6 个页面已在 `sitemap.json` 中 disallow，不会被搜一搜收录

## 十一、备份与换电脑迁移

项目的数据分散在 **四处**，其中三处 Git 管不到，换电脑时正是这三处最容易丢：

| 资产 | 位置 | Git 是否收录 | 怎么搬 |
|---|---|---|---|
| 代码 / 文档 / 脚本 | 项目目录 | ✅ 已收录 | `git clone` |
| **数据库** | 本机 MySQL（不在项目目录内！） | ❌ | `tools/backup.js` 导出 SQL |
| **上传与产物** | `server/uploads/` | ❌ 体积会涨，已 ignore | `tools/backup.js` 复制 |
| **运行时配置** | `server/.env` | ❌ 含密钥，已 ignore | `tools/backup.js` 复制 |

### 日常备份

```bash
node tools/backup.js                 # → backup/<时间戳>/
node tools/backup.js --out D:/备份    # 直接写到别处（如云盘同步目录）
node tools/backup.js --keep-dumps 5  # 只保留最近 5 份
```

产出结构与恢复步骤会自动生成在备份目录里的 `恢复说明.md`。导出方式优先用 `mysqldump`，
系统里没有它时自动切到内置导出器（纯 Node 读表生成 SQL），所以新电脑没装 MySQL Client 也能备份。

> ⚠️ 备份目录含 `server.env.txt`（数据库密码 + 密钥），**不要提交到仓库、不要公开分享**。
> `backup/` 已在 `.gitignore` 中。

### 换电脑五步

```bash
# 1. 装环境：Node 18+、MySQL 8、Git
# 2. 取代码
git clone <仓库地址> watermark-cleaner && cd watermark-cleaner/server && npm install
# 3. 还原配置：把备份里的 server.env.txt 复制成 server/.env（按需改 DB 密码 / 端口）
# 4. 还原数据库与文件
mysql -u root -p < <备份>/db/wc_watermark.sql
cp -r <备份>/uploads/* uploads/
# 5. 下载 FFmpeg 并自检
cd .. && node tools/get-ffmpeg.js && node tools/doctor.js
```

### 已为可移植性做的处理

- **FFmpeg 路径自动探测**（`server/lib/binpath.js`）：按 `.env` 配置 → 项目内置 `tools/bin` → 系统 PATH 依次查找。
  原来的 `.env` 里写死了本机绝对路径，换机后视频功能会直接失效；现在换成任何一个可用的即可，
  `/api/videoProc/service` 会回报实际用的是哪一个。
- **换行符统一**（`.gitattributes`）：避免在 Windows 与其它系统之间来回 diff。
- **存储路径限定项目内**：后台「配置 → 存储路径」只允许选项目文件夹内的目录，避免指到别的盘后
  文件与数据库对不上（详见 `server/lib/storage.js`）。
- **权限探针自动清扫**：写权限检测若被异常中断，残留的探针文件会在下次检查时自动清掉，不会污染上传目录与备份。
