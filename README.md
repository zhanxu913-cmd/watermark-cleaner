# 水印清理 · 零后台版微信小程序

**图片去水印全部在手机本地完成，不需要服务器、不需要数据库、不需要域名备案。**
视频去水印交给一个可选的极简 FFmpeg 服务 —— 不想要视频功能，就一行都不用配。

> ⚠️ 合规定位：本工具面向「清理自有素材上的水印」。小程序的「关于」与隐私政策已按此表述，请不要改成「去除他人作品水印」类文案。

---

## 一、和上一版（MySQL 后台）的区别

| | 旧版 | 本版 |
|---|---|---|
| 图片处理 | 本地 Canvas 处理后上传成品 | **纯本地，零请求** |
| 图片记录 | MySQL `wc_jobs` | 手机本地 `records.json` |
| 登录 | wx.login → JWT | **无登录** |
| 用户/配额/封禁 | 后台可配 | **已移除** |
| 管理后台 | Web + 小程序内分包 | **已移除** |
| 视频处理 | Node + MySQL + 队列 | 极简单文件服务（Express + FFmpeg，无数据库） |
| 部署 | MySQL + 服务 + 备案域名 | 图片零部署；视频一个容器 |

旧版代码完整保留在 Git 历史中（`eef111b` 及更早提交）。

---

## 二、架构

```
┌─────────────────────────────────────┐
│  微信小程序                          │
│                                     │
│  图片：选图 → Canvas 处理 → 存本机   │  ← 全程不联网
│                                     │
│  视频：选区间 → 上传 ─┐              │
└──────────────────────┼──────────────┘
                       │ HTTPS
              ┌────────▼──────────┐
              │ video-service-lite │  ← 可选，不配也能用图片
              │ Express + FFmpeg   │
              │ 无数据库 / 无登录   │
              └────────┬──────────┘
                       │ 处理完立刻删源文件
                       ▼
                  产物 mp4（保留 24h）
```

---

## 三、目录结构

```
watermark-cleaner/
├── miniprogram/                    # 小程序（图片功能开箱即用）
│   ├── utils/constants.js          #   ★ 唯一需要改的文件：VIDEO_API_BASE_URL
│   ├── utils/localdb.js            #   本地记录仓库（记录 + 缩略图 + 成品）
│   ├── services/job.js             #   记录 CRUD（全部落本地）
│   ├── services/video.js           #   视频服务客户端
│   ├── pages/                      #   首页 / 图片编辑 / 视频编辑 / 结果 / 记录 / 我的
│   └── packageCommon/              #   关于 / 隐私 / 使用须知
├── video-service-lite/             # ★ 极简视频服务（可选）
│   ├── server.js                   #   Express + 队列 + 定时清理
│   ├── lib/graph.js                #   FFmpeg 滤镜图（fill/blur/mosaic/crop/delogo）
│   ├── lib/ffmpeg.js               #   转码 / 探测 / 抽帧
│   ├── Dockerfile                  #   node:20-alpine + ffmpeg
│   └── .env.example
├── tools/
│   ├── doctor.js                   #   环境自检
│   ├── check-miniprogram.js        #   小程序静态自检（require / 页面 / 事件）
│   ├── test-video.js               #   视频链路测试（29 项）
│   ├── get-ffmpeg.js               #   下载内置 ffmpeg
│   └── lan-ip.js                   #   打印局域网地址
└── project.config.json
```

---

## 四、快速开始

### 4.1 只做图片（零配置）

1. 微信开发者工具导入项目根目录
2. 直接编译运行

不需要服务器、不需要填任何地址。图片处理、记录、保存相册全部可用。

### 4.2 加上视频去水印

#### 本地跑（开发和真机调试）

```bash
cd video-service-lite
npm install
cp .env.example .env      # 可选，改端口/令牌/时长上限
npm start
```

启动后终端会打印：

```
  极简视频去水印服务已启动
  监听      http://0.0.0.0:3100
  FFmpeg    .../tools/bin/ffmpeg.exe  (项目内置 tools/bin)
```

然后把地址填进 `miniprogram/utils/constants.js`：

```js
// 模拟器调试
const VIDEO_API_BASE_URL = 'http://127.0.0.1:3100';

// 真机调试：换成电脑的局域网 IP（先跑 node tools/lan-ip.js 查看）
// 手机和电脑必须在同一个 WiFi，电脑防火墙放行 3100
const VIDEO_API_BASE_URL = 'http://192.168.1.23:3100';
```

开发者工具「详情 → 本地设置」勾选 **不校验合法域名**。

#### 部署成公网服务（Docker / 云托管）

```bash
cd video-service-lite
docker build -t wc-video .
docker run -d -p 3100:3100 -e CLIENT_TOKEN=你的令牌 wc-video
```

云托管（腾讯云 / 任何容器平台）：

1. 新建服务，代码目录选 `video-service-lite`
2. 端口填 **3100**（或让平台注入 `PORT`）
3. 环境变量：`CLIENT_TOKEN=你的令牌`、`KEEP_HOURS=24`
4. 部署后拿到 https 地址，填进 `VIDEO_API_BASE_URL`

> 云托管不需要域名备案，平台会给一个默认 https 域名；自定义域名才需要备案。

---

## 五、小程序端配置

只有一处要改：`miniprogram/utils/constants.js`

```js
const VIDEO_API_BASE_URL = 'https://xxxx.sh.run.tcloudbase.com';
const VIDEO_CLIENT_TOKEN = '与服务端 CLIENT_TOKEN 保持一致';
```

上线前在微信公众平台 → 开发管理 → 服务器域名，把视频服务域名同时加入：

| 类型 | 是否必需 | 用途 |
|---|---|---|
| `uploadFile` 合法域名 | 视频必需 | 上传视频 |
| `request` 合法域名 | 视频必需 | 轮询状态、探测服务 |

图片功能不产生任何请求，**一个域名都不用配**。

---

## 六、数据存在哪

| 内容 | 位置 | 生命周期 |
|---|---|---|
| 图片成品 | 本机 `USER_DATA_PATH/wc/outputs/` | 删记录/清缓存/卸载即删 |
| 缩略图 | 本机 `USER_DATA_PATH/wc/thumbs/` | 同上 |
| 处理记录 | 本机 `USER_DATA_PATH/wc/data/records.json` | 同上 |
| 视频源文件 | 视频服务临时目录 | 处理完**立即删除** |
| 视频结果 | 视频服务 `output/` | 默认 24 小时，到期自动删 |

本机数据上限：**150MB 或 300 条记录**，先到者生效。
超出时按时间从旧到新删除成品文件（保留记录与缩略图），旧记录点开会提示「文件已过期」。

**换手机、清缓存、卸载微信都会丢记录**，重要结果请保存到相册。

---

## 七、视频服务接口

```
POST /api/video/submit    multipart：file + mode/region/timeRange/duration/fileName
GET  /api/video/status    ?id=xxx
GET  /api/video/service   探测 FFmpeg 是否就绪
GET  /files/:name         产物下载（mp4 / jpg）
GET  /healthz             健康检查
```

`region` 为归一化坐标 `{x,y,w,h}`（0–1），语义是**水印所在的框**；
`crop` 模式会裁掉该框、保留剩余面积最大的一侧。

`mode` 支持：`fill` / `blur` / `mosaic` / `crop` / `delogo`。

状态值：`pending` → `processing` → `done` / `failed`。

---

## 八、常见问题

**Q：视频为什么不能也做成纯本地？**
小程序开放了 `wx.createVideoDecoder`（逐帧解码），但**没有开放视频编码器**，无法把处理后的帧重新封装成 mp4；`ffmpeg` 二进制约 140MB，也远超小程序包与云函数（20MB）限制。这是平台硬约束，不是实现选择。

**Q：不配视频服务会怎样？**
首页的视频入口会提示「视频服务未配置」，图片功能完全不受影响。

**Q：接口会不会被人盗用？**
服务端 `CLIENT_TOKEN` 与小程序端 `VIDEO_CLIENT_TOKEN` 一致即可挡掉随意调用。要更严就得回到账号+配额体系（旧版方案）。

**Q：能多人同时用吗？**
可以，`CONCURRENCY` 默认 1（串行转码）。机器配置好可调到 2–4。

**Q：审核会被拒吗？**
去水印类工具审核偏严。建议：类目选「工具」，描述写「清理自有素材上的水印」，不要在名称/简介里出现「破解」「去他人水印」。隐私政策已写明不收集个人信息，可作辅助材料。

**Q：怎么换回有数据库的版本？**
`git log` 找到 `eef111b`，`git checkout eef111b -- .` 即可恢复。旧版的部署说明在对应提交的 README 里。

---

## 九、自检与测试

```bash
node tools/doctor.js            # 环境：Node / FFmpeg / 依赖 / 服务 / 配置
node tools/check-miniprogram.js ./miniprogram   # 静态：require / 页面 / 事件绑定
node tools/test-video.js        # 视频链路：29 项断言
```

`doctor.js` 输出示例：

```
  ✓ Node 版本   22.22.2
  ✓ ffmpeg   tools/bin  .../tools/bin/ffmpeg.exe
  ✓ 视频服务依赖   已安装
  ✓ 小程序视频地址   http://192.168.31.74:3100
  ✗ 视频服务运行中   未启动 —— cd video-service-lite && npm start
```

---

## 十、上线前检查

- [ ] `VIDEO_API_BASE_URL` 已改为 https 正式地址
- [ ] 公众平台已添加 `uploadFile` / `request` 合法域名
- [ ] 服务端 `CLIENT_TOKEN` 已设置且与小程序一致
- [ ] 隐私政策中的「联系我们」方式真实可用
- [ ] 真机跑一遍：图片处理 → 保存相册 → 记录 → 删除
- [ ] 真机跑一遍：视频上传 → 进度 → 下载到相册
- [ ] 小程序类目、名称、简介不含侵权导向表述
