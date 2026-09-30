# AyanBall Chat · 服务端（Netlify 动态部署版）

服务端已升级为 **Netlify Functions + Pusher 实时通道** 架构（无常驻进程、支持免费部署）：

- 业务 API：`netlify/functions/api.js`（注册/登录/好友/拉黑/群聊/消息/通话信令/心跳）
- 管理面板 API：`netlify/functions/admin.js`（图形化操作后端）
- Pusher 鉴权：`netlify/functions/pusher.js`（private- 频道订阅签名，密钥不进客户端）
- 文件传输：`netlify/functions/upload.js` + `file.js`（**Netlify Blobs 预签名直传，支持 50MB**）
- 数据持久化：Netlify Blobs（`@netlify/blobs`）
- 在线状态：HTTP 心跳（客户端每 30s `ping`，60s 窗口判定在线）

> 旧的本地 WebSocket 版保留为 `server.js`（`npm run serve:ws`，端口 8899，仅本地联调用）。
> 实时协议已从 WebSocket 升级为 HTTP API + Pusher，**客户端需适配新协议**（见第五节）。

## 一、Netlify 部署步骤

1. 把本目录推送到 GitHub 仓库（见第四节）。
2. 打开 [Netlify](https://app.netlify.com) → **添加新项目 → 导入 Git 仓库 → GitHub** → 选择本仓库。
3. 自动读取 `netlify.toml`：构建命令 `npm install`，发布目录 `public`，函数目录 `netlify/functions`。
4. **环境变量**（Site settings → Environment variables）必须配置：

| 变量 | 说明 | 示例 |
|---|---|---|
| `PUSHER_APP_ID` | Pusher Channels App ID（Pusher 控制台 → 应用密钥） | `<your-app-id>` |
| `PUSHER_KEY` | Pusher 公钥（客户端公开） | `<your-key>` |
| `PUSHER_SECRET` | Pusher 私钥（**标记为秘密值**，绝不写入仓库） | `<your-secret>` |
| `PUSHER_CLUSTER` | Pusher 集群 | `ap1` |
| `ADMIN_KEY` | 管理面板密码（可选，默认 `ayanball-admin`） | `ayanball-admin` |

5. 点击**部署项目**，等待构建完成。

## 二、访问地址

- 管理面板：`https://<你的站点>.netlify.app/admin.html`（密码 = `ADMIN_KEY`）
- 服务状态页：`https://<你的站点>.netlify.app/`
- 业务 API：`https://<你的站点>.netlify.app/.netlify/functions/api`（POST，body `{action, payload}`，Bearer token）

## 三、图形化管理面板功能

| 模块 | 功能 |
|---|---|
| 概览 | 在线/注册用户、群聊数、消息数、文件数、实时通道状态 |
| 用户管理 | 搜索用户、设为管理员 / 取消管理员、删除用户（连带清理好友/群关系/登录态） |
| 群聊管理 | 查看全部群聊（邀请码、群主、成员数）、查看群成员、踢人、转让群主、解散群聊 |
| 消息记录 | 查看最近消息（私聊/群聊，文本/文件可筛选，文件可下载） |
| 文件管理 | 文件大小、上传者、剩余有效期（3 天）、删除文件 |
| 系统操作 | 广播消息（在线客户端弹窗+提醒音）、清理过期文件、清理离线登录态 |

## 四、推送代码到 GitHub

```bash
git init -b main
git add -A
git commit -m "AyanBall Chat Server: Netlify + Pusher 动态服务端"
git remote add origin https://github.com/<你的账号>/ayanball-chat-server.git
git push -u origin main
```

## 五、客户端对接（重要）

客户端（Tauri 打包 EXE）已改为 **HTTP + Pusher** 协议，不再使用 WebSocket：

- API 地址：`https://<站点>.netlify.app/.netlify/functions/api`
- 实时配置：客户端先调 `action: "config"` 获取 `{pusher: {key, cluster}}`
- Pusher 订阅：`private-user_{id}`（个人事件）、`private-conv_dm_{id}` / `private-conv_g_{gid}`（消息）、`private-call_{id}`（通话信令）
- 文件上传：调 `upload` 函数拿预签名地址 → 客户端直接 `PUT` 二进制（绕过函数 6MB 限制，支持 50MB）
- 在线心跳：每 30s 调 `action: "ping"`，服务端据此判定在线

## 六、本地验证

```bash
npm install
npm run test        # node test-netlify.cjs，mock Blobs 本地回归测试（48 项）
node --check netlify/functions/api.js   # 语法检查
```

> 注：免费版 Pusher Sandbox 限额 100 并发连接 / 20 万条消息每日 / 100 频道，量大需升级。

## 七、数据与文件

- 数据：Netlify Blobs（分 key 存储：users / tokens / groups / requests / friends / blocked / room / files / lastSeen）
- 文件：Blobs 预签名直传，**≤50MB，3 天有效期**，超限返回 `too-large`（客户端提示"目前服务器原因，仅支持发送50MB以内的文件，且有效期3天！！！"）
- 群上限：普通群 **100 人**；首个注册用户自动成为管理员
