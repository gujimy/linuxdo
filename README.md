# Linux.do 等级 + LDC 脚本

一个 Tampermonkey 用户脚本，用于在 `linux.do` 页面侧边展示：
- 信任等级进度（等级）- **支持完整的 TL3 要求数据**
- LDC 数据（Credit）

## ✨ 功能特性

### 📊 信任等级显示
- ✅ **完整的 TL3 要求数据**：访问天数、浏览话题、浏览帖子、回复话题、点赞、获赞、**获赞天数**、**获赞用户**、合规记录
- ✅ 自动从 `connect.linux.do` 获取详细进度
- ✅ 优雅降级到 Summary API（TL0-2 用户）
- ✅ 实时进度条显示
- ✅ 达标/未达标状态提示

### 💰 LDC 数据显示
- ✅ 余额、今日额度
- ✅ **预估涨分**（基于 gamification_score）
- ✅ 近 7 日收入/支出统计
- ✅ 近 5 日详细记录

### 🎨 交互体验
- ✅ 悬浮按钮显示预估涨分
- ✅ **悬浮按钮可自由拖动**
- ✅ **悬浮面板可自由拖动**（拖动卡片头部）
- ✅ 位置自动保存
- ✅ 折叠/展开各区块
- ✅ 一键手动刷新
- ✅ 自动刷新（固定间隔 5 分钟）

### 🔧 性能优化（v1.2.0）
- ✅ **调试模式开关**（生产环境零日志污染）
- ✅ **优化请求逻辑**（移除无效的 fetch 方案）
- ✅ **代码体积减少** ~43 行
- ✅ 缓存上次数据（减少空白期）

## 📸 功能截图

### 完整的 TL3 要求数据
```
等级 Lv.3 [已达标]

访问天数     95 / 50    ████████████ 100%
浏览话题     533 / 500  ████████████ 100%
浏览帖子     31352 / 20000 ████████ 100%
回复话题     11 / 10    ████████████ 100%
点赞         152 / 30   ████████████ 100%
获赞         138 / 20   ████████████ 100%
获赞天数     40 / 7     ████████████ 100%  ← 新增
获赞用户     133 / 5    ████████████ 100%  ← 新增
被举报帖子   0 / 5      ████████████ 100%
举报用户     0 / 5      ████████████ 100%
```

## 🚀 安装与更新

### 安装步骤
1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 点击安装链接：[linuxdo.user.js](https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js)
3. 在弹出的 Tampermonkey 安装页面点击"安装"
4. 打开 `https://linux.do/` 任意页面验证悬浮按钮

### 自动更新
脚本已配置自动更新：
- `@downloadURL https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js`
- `@updateURL https://raw.githubusercontent.com/gujimy/linuxdo/main/linuxdo.user.js`

Tampermonkey 会定期检查更新。

## ⚙️ 配置说明

### 调试模式
在 `linuxdo.user.js` 第 24 行：

```javascript
const DEBUG = false;  // 生产环境（默认）
const DEBUG = true;   // 开发环境（启用调试日志）
```

### 节流与稳定性策略

当前版本已实现以下优化：

#### 1. 最小请求间隔
- 自动刷新最小间隔：`60s`
- 手动刷新最小间隔：`3s`
- 防止短时间重复触发请求

#### 2. 按数据源独立退避（Trust / Credit）
- Trust 与 Credit 分别维护 `failCount` 和 `nextAllowedAt`
- 单侧失败不会拖慢另一侧
- 失败后指数退避，最大不超过 `40min`

#### 3. 跨标签页去重
- 使用共享锁（`GM_setValue`）避免多标签页同时请求
- 锁默认有效期 `20s`

#### 4. Credit 401 暂停窗口
- 检测到 Credit `HTTP 401` 后，自动暂停 Credit 请求 `20min`
- 面板提示暂停到具体时间，用户可点击"刷新"手动重试

#### 5. 请求超时保护
- 同源请求增加超时控制（默认 `15s`）
- 避免弱网下长时间 pending

### 可调参数

在 `linuxdo.user.js` 中修改 `THROTTLE` 对象：

```javascript
const THROTTLE = {
  BASE_INTERVAL_MS: 5 * 60 * 1000,        // 自动刷新基础间隔: 5分钟
  MIN_INTERVAL_MS: 60 * 1000,             // 最小请求间隔: 1分钟
  MANUAL_MIN_INTERVAL_MS: 3 * 1000,       // 手动刷新最小间隔: 3秒
  MAX_BACKOFF_MS: 40 * 60 * 1000,         // 最大退避时间: 40分钟
  CREDIT_401_PAUSE_MS: 20 * 60 * 1000,    // Credit 401错误暂停: 20分钟
  CROSS_TAB_LOCK_MS: 20 * 1000,           // 跨标签页锁: 20秒
  SAME_ORIGIN_TIMEOUT_MS: 15000,          // 同源请求超时: 15秒
};
```

## 📋 技术实现

### 数据来源优先级
1. **优先**：`connect.linux.do` - 完整的 TL3 要求数据
2. **降级**：`linux.do/u/{username}/summary.json` - TL0-2 基础数据
3. **Credit**：`credit.linux.do/api/v1/*` - LDC 数据

### 核心技术
- **GM API**：`GM_xmlhttpRequest`, `GM_getValue`, `GM_setValue`, `GM_addStyle`
- **DOM 解析**：基于内容的智能解析（不依赖 CSS 类名）
- **跨域请求**：通过 `@connect` 白名单
- **状态持久化**：LocalStorage + GM_getValue
- **拖动交互**：Pointer Events API

### 解析策略
采用**内容优先**的解析方式，而非依赖 CSS 类名：
1. 查找标题元素（如"活跃程度"）
2. 获取下一个兄弟元素（数据容器）
3. 精确匹配标签文本（如"访问天数"）
4. 向上查找包含数字的父容器
5. 提取并验证数据

## 🐛 故障排查

### 等级部分不显示
1. 检查是否登录 `linux.do`
2. 点击"等级"区域的刷新按钮
3. 打开控制台查看错误信息（需启用 `DEBUG = true`）

### LDC 提示"未登录"
1. 点击面板内的 `Credit` 链接
2. 在 `credit.linux.do` 完成登录
3. 返回 `linux.do` 并点击"LDC"区域的刷新按钮

### 悬浮按钮位置异常
1. 拖动悬浮按钮到合适位置
2. 位置会自动保存到 `GM_getValue`

## 📝 更新日志

### v1.2.0 (2026-06-23)
- ✨ **新增**：完整的 TL3 要求数据显示（获赞天数、获赞用户等）
- ✨ **新增**：悬浮面板可自由拖动
- 🔧 **优化**：添加调试模式开关（生产环境零日志）
- 🔧 **优化**：移除无效的 fetch 方案，简化请求逻辑
- 🔧 **优化**：代码体积减少约 43 行
- 🔧 **优化**：提升请求速度（直接使用 GM_xmlhttpRequest）
- 🐛 **修复**：Connect 页面数据解析失败问题
- 🐛 **修复**：CORS 策略导致的请求失败

### v1.1.x
- 初始版本
- 基础等级和 LDC 数据显示
- 悬浮按钮拖动功能

## 📄 许可证

MIT License

## 🙏 致谢

感谢 [Linux.do](https://linux.do) 社区的支持！

---

**仓库地址**：[gujimy/linuxdo](https://github.com/gujimy/linuxdo)

**问题反馈**：[Issues](https://github.com/gujimy/linuxdo/issues)
