# Linux.do 等级 + LDC 脚本

一个 Tampermonkey 用户脚本，用于在 `linux.do` 页面侧边展示：
- 信任等级进度（等级）
- LDC 数据（Credit）

## 功能

- 全站 `linux.do/*` 页面显示悬浮入口和面板
- 一键手动刷新
- 自动刷新（固定间隔 5 分钟）
- LDC 未登录（HTTP 401）时给出中文提示，并提供 Credit 跳转链接
- 缓存上次数据（减少空白期）

## 自动刷新间隔

- 当前自动刷新间隔：`5 分钟`
- 对应配置项：`THROTTLE.BASE_INTERVAL_MS = 5 * 60 * 1000`
- 该间隔用于定时自动刷新与成功后的下一次自动请求窗口计算

## 节流与稳定性策略

当前版本已实现以下优化：

1. 最小请求间隔
- 自动刷新最小间隔：`60s`
- 手动刷新最小间隔：`3s`
- 防止短时间重复触发请求

2. 按数据源独立退避（Trust / Credit）
- Trust 与 Credit 分别维护 `failCount` 和 `nextAllowedAt`
- 单侧失败不会拖慢另一侧
- 失败后指数退避，最大不超过 `40min`

3. 跨标签页去重
- 使用共享锁（`GM_setValue`）避免多标签页同时请求
- 锁默认有效期 `20s`

4. Credit 401 暂停窗口
- 检测到 Credit `HTTP 401` 后，自动暂停 Credit 请求 `20min`
- 面板提示暂停到具体时间，用户可点击“刷新”手动重试

5. 请求超时保护
- 同源 `fetch` 增加 `AbortController` 超时控制（默认 `15s`）
- 避免弱网下长时间 pending

## 主要可调参数

在 `linuxdo.user.js` 中修改 `THROTTLE`：

- `BASE_INTERVAL_MS`：自动刷新基础间隔
- `MIN_INTERVAL_MS`：自动刷新最小间隔
- `MANUAL_MIN_INTERVAL_MS`：手动刷新最小间隔
- `MAX_BACKOFF_MS`：失败退避上限
- `CREDIT_401_PAUSE_MS`：Credit 401 暂停时长
- `CROSS_TAB_LOCK_MS`：跨标签锁有效期
- `SAME_ORIGIN_TIMEOUT_MS`：同源请求超时

## 安装与更新

1. 安装 Tampermonkey
2. 在浏览器打开安装链接：`https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js`
3. 按 Tampermonkey 提示完成安装
4. 打开 `https://linux.do/` 任意页面验证悬浮按钮

脚本头已配置：
- `@downloadURL`
- `@updateURL`

## 说明

- 脚本运行域名：`https://linux.do/*`
- Credit 数据通过 `credit.linux.do` API 获取
- 如出现“用户未登录 Credit”，点击面板内 `Credit` 链接登录后再刷新
