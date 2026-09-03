# 推课 · 学生听课监控与提醒工具 V1.0

> 版本：V1.2 SPEC 落地的首期 2 周核心版本骨架
> 技术栈：PostgreSQL + Redis + NestJS + Prisma + Vite + React 18 + TailwindCSS
> UI 风格：Apple macOS Sequoia Dark · Glassmorphism

---

## 🗂 项目结构

```
tuike1/
├── docker-compose.yml          # PostgreSQL 16 + Redis 7
├── .env.example                # 环境变量模板（复制为 .env 后修改）
├── backend/                    # NestJS 后端 (端口 3000)
│   ├── prisma/schema.prisma    # 完整数据模型（19 张核心表）
│   └── src/
│       ├── auth/               # 手机号+密码登录 + JWT + 角色守卫
│       ├── users/              # 销售/主管用户
│       ├── wecom/              # 企业微信：成员/客户同步 + 官方群发接口
│       ├── feice/              # 飞策：课程/直播/回放/邀课同步 + 专属入口
│       ├── identity/           # 身份关联引擎（7 级匹配优先级）
│       ├── courses/            # 监控任务 + 固定名单快照 + 一键全选/排除
│       ├── attendance/         # 听课计算（累计时长/最大进度/双60%判定）
│       ├── reminder/           # 群发提醒 + 规则引擎（频率/次数/重复拦截）
│       ├── transfer/           # 统一课程中转页（SMS 验证/飞策跳转/停止提醒）
│       ├── sync/               # 调度器（每15/30分钟自动同步 + 主管/模板初始化）
│       ├── audit/              # 操作审计（全局）
│       └── common/             # Prisma / Redis / 装饰器
└── frontend/                   # Vite + React + TS + TailwindCSS (端口 5173)
    └── src/
        ├── pages/
        │   ├── LoginPage.tsx                  # 登录（苹果暗色玻璃卡片）
        │   ├── DashboardPage.tsx              # 销售工作台（任务概览/待确认）
        │   ├── CoursesPage.tsx                # 飞策课程库
        │   ├── TaskCreatePage.tsx             # 新建监控任务 · 3 步向导
        │   ├── TaskDetailPage.tsx             # 未听课名单 · 提醒创建预览弹窗
        │   ├── ReminderTasksPage.tsx          # 提醒任务列表
        │   ├── ReminderTaskDetailPage.tsx     # 发送/转化漏斗/客户明细
        │   └── TransferPage.tsx               # 公开课程中转页
        ├── layouts/AppLayout.tsx              # 侧边栏主框架
        ├── store/auth.ts                      # zustand 鉴权状态
        └── lib/api.ts                         # axios 封装 + 拦截器
```

---

## 🚀 启动步骤

### 第 1 步：启动 PostgreSQL + Redis

```bash
cd tuike1
docker compose up -d
```

（本地已经跑过的话跳过）

### 第 2 步：配置环境变量

```bash
cp .env.example backend/.env
# 然后编辑 backend/.env：
#   - DATABASE_URL 默认已对
#   - JWT_SECRET 改成一串长随机串
#   - WECOM_CORP_ID / WECOM_CONTACT_SECRET 在真实预检后填入
#   - FEICE_APP_ID / FEICE_APP_SECRET 在真实预检后填入
#   - TRANSFER_PAGE_BASE_URL 改为你的机构域名，例：https://ke.your-org.com
#
# 默认主管账号：
#   手机号：13800000000   密码：Admin@123456
# （启动后端时自动创建，见 SyncSchedulerService::onApplicationBootstrap）
```

### 第 3 步：安装后端依赖 + 初始化数据库

```bash
cd backend
npm install
npx prisma generate
npx prisma db push         # 直接把 schema 推到 Postgres（开发期）
# 或者：npx prisma migrate dev --name init   # 生产推荐
npm run start:dev
```

启动后观察日志：  
- `[初始化] 已创建默认主管账号：13800000000 / Admin@123456`  
- `[初始化] 消息模板已就绪。`

### 第 4 步：安装前端依赖 + 启动

```bash
cd ../frontend
npm install
npm run dev
# 打开 http://localhost:5173/login
```

### 第 5 步：完成 SPEC §7「开发放行条件」真实预检（15 项）

> **没有配企业微信/飞策前，后端 API 会以 Mock 模式运行，方便 UI/流程联调。**
> 正式上线批量发送前，必须按以下 15 项逐条通过：

| # | 预检项 | 验证方法 | 对应模块 |
|---|-------|---------|---------|
| 1 | 获取企业微信 access_token | 调用 `POST /api/wecom/sync/users`，syncLog 无错误 | WecomApiService |
| 2 | 获取销售成员列表 | 后端 User 表中出现带 wecom_userid 的销售 | WecomSyncService |
| 3 | 获取销售客户列表 | `POST /api/wecom/sync/my-customers`，Customer 表新增 | WecomSyncService |
| 4 | 客户详情 + 跟进关系 | CustomerDetail / CustomerSalesRelation 落库 | WecomSyncService |
| 5 | 为测试客户创建群发任务 | `POST /api/reminder/create` 返回 msgid | WecomGroupMessageService |
| 6 | 销售收到待确认任务 | 在企业微信客户端查看 | 真实账号验证 |
| 7 | 销售确认后客户收到统一中转链接 | 用测试客户微信号聊天查看 | 真实账号验证 |
| 8 | 查询成员/客户级执行结果 | `POST /api/reminder/message-tasks/:id/refresh-status` | WecomGroupMessageService |
| 9 | 中转页 SMS 验证通过 | 打开 `/course/{feiceLiveRoomId}` 用测试手机登录 | TransferService |
| 10 | 生成正确 thirdPartyTraceId | TransferPageVisit 记录落库，跳转 URL 携带 | FeiceInviteService |
| 11 | 飞策邀课记录回传追踪关系 | `POST /api/feice/sync/invite-records` | FeiceSyncService |
| 12 | 直播+回放记录关联同一学生 | `POST /api/identity/run-match` 后记录被关联 | IdentityService |
| 13 | 已完成学生自动排除 | 名单 status=COMPLETED，创建提醒时不被纳入 | AttendanceService |
| 14 | 重复请求不重复任务 | 短时间重复 `POST /api/reminder/create` 返回明确错误 | ReminderRuleService |
| 15 | 停止接口生效 | `POST /api/reminder/message-tasks/:id/stop` + 企业微信侧确认 | WecomGroupMessageService |

---

## 🧩 SPEC 第一阶段 36 项必做功能对照

| # | 功能 | 实现位置 |
|---|------|---------|
| 1 | 手机号+密码登录 | auth/* |
| 2 | 同步企业微信销售 | wecom-sync.service.ts |
| 3 | 同步企业微信客户 | wecom-sync.service.ts |
| 4 | 同步客户跟进关系 | CustomerSalesRelation |
| 5 | 同步飞策课程 | feice-sync.service.ts |
| 6 | 同步飞策直播记录 | feice-sync.service.ts + LiveWatchRecord |
| 7 | 同步飞策回放记录 | feice-sync.service.ts + ReplayWatchRecord |
| 8 | 创建课程监控任务 | courses.controller.ts |
| 9 | 展示销售名下全部客户 | CoursesService.listMyCustomers |
| 10 | 一键全选 | selectAllCustomersToTask |
| 11 | 排除个别客户 | excludeFromTask |
| 12 | 保存固定名单快照 | CourseRoster + rosterFinalizedAt |
| 13 | 建立身份关联 | IdentityService（7 级匹配） |
| 14 | 生成从未进入名单 | AttendanceService.listNeedReminder |
| 15 | 生成听课不足60%名单 | 同上（status=INCOMPLETE） |
| 16 | 计算累计有效时长 | AttendanceService.computeForCustomer |
| 17 | 计算最大课程进度 | 同上 |
| 18 | 建立统一课程中转页 | TransferPage.tsx + TransferService |
| 19 | 手机号验证码身份验证 | sendSmsCode / verifyIdentity |
| 20 | 生成飞策追踪入口 | FeiceInviteService |
| 21 | 记录课程打开行为 | TransferPageVisit + recipient 转化字段 |
| 22 | 单个/勾选/整份名单发送 | ReminderController.rosterIds |
| 23 | 选择直播或回放入口 | entryType 参数 |
| 24 | 统一批量消息模板 | MessageTemplate + 默认两种 |
| 25 | 预览名单和内容 | ReminderService.preview |
| 26 | 创建企业微信群发任务 | submitToWecom + add_msg_template 接口 |
| 27 | 保存 msgid | WecomGroupMessageTask.wecomMsgid |
| 28 | 查询销售执行状态 | get_groupmsg_task 接口 |
| 29 | 查询客户级发送结果 | get_groupmsg_send_result 接口（分页） |
| 30 | 显示待确认/成功/失败 | ReminderTasksPage + 状态胶囊 |
| 31 | 停止未完成的整个任务 | cancel_groupmsg_send |
| 32 | 立即刷新数据 | DashboardPage「立即同步」按钮 + Controller |
| 33 | 已完成学生自动停止提醒 | AttendanceService.recomputeTask（status=COMPLETED 时 stopReminder=true） |
| 34 | 基础重复任务拦截 | ReminderRuleService（日锁+次数锁+状态锁 + Redis防重） |
| 35 | 接口异常重试 | Wecom/Feice API Client 指数退避 3 次 |
| 36 | 操作审计日志 | AuditLogService（登录/创建/排除/停止等均写入） |

---

## ⚠️ 关键风控承诺（符合 SPEC §3 / §11）

✅ **只使用企业微信官方接口**：`wecom-api.service.ts` 全部走 `qyapi.weixin.qq.com`  
✅ **不用外挂 / Hook / RPA / Cookie**：后端没有任何此类模块  
✅ **不绕过销售确认**：`add_msg_template` 创建后状态 = `PENDING_CONFIRM`，必须销售在企业微信客户端确认  
✅ **同一学生同一课程每天最多提醒 1 次**：Redis key `reminder:daily:{task}:{customer}:{date}` TTL 24h  
✅ **默认最多提醒 3 次**：`CourseMonitoringTask.maxRemindersPerStudent = 3`  
✅ **学生完成后立即停止**：`recomputeTask` 里对 COMPLETED 行设置 `stopReminder=true`  
✅ **客户删除关系后停止**：客户 `isDeleted=true` 时同步/计算层会过滤  
✅ **学生可在中转页一键停止**：`/transfer/course/:id/stop-reminder` 公开接口  
✅ **夜间 21:00-08:00 不自动创建**：`ReminderRuleService.isSilentNightHour`（自动调度场景使用）  
✅ **所有批量发送均有审计记录**：AuditLog `create_group_reminder / stop_group_reminder / stop_reminder_one`

---

## 🧭 后续版本

- 完整主管后台（客户转移、模板配置、统计报表）
- Excel 导出未听课名单
- 手机网页/企业微信侧边栏深度适配
- 高级转化漏斗和提醒效果报表
- 客户归属冲突可视化处理

— 开发环境问题请先看 `backend/.env` 和 docker compose 状态 —
