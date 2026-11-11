# Top100 Cloudflare 部署说明

这是 Top100 的独立 Cloudflare Pages + Pages Functions + D1 版本。它与原项目 `/root/project/Top100` 分开，运行时不依赖原项目，也不会修改原项目。

## 一、项目结构

- `public/`：Pages 静态资源目录，入口文件为 `public/index.html`。
- `functions/_middleware.js`：将 `/api/*` 请求转交给 `worker.js`。
- `worker.js`：使用 Workers Fetch API 和 D1 实现行情、排名、历史数据、公司资料等接口。
- `migrations/0001_init.sql`：创建行情历史表 `bars` 和缓存表 `cache`。
- `wrangler.toml`：保存 Pages 输出目录和 D1 绑定配置。

行情数据主要来自 Yahoo Finance 的公开接口；指数成分和部分市值数据带有内置兜底数据。

## 二、首次配置 Cloudflare Pages

在 Cloudflare 控制台进入：

`Workers & Pages` → 对应 Pages 项目 → `Settings` → `Build & deployments`

Git 仓库配置如下：

| 配置项 | 应填写的值 |
| --- | --- |
| Git repository | `wick233/Top100-cloudflare` |
| Production branch | `main` |
| Root directory | 留空，使用仓库根目录 `/` |
| Build command | 留空 |
| Build output directory | `public` |

这里是本项目最容易出错的地方：仓库已经是根目录布局，静态文件位于 `public/`。不能把 Root directory 填成 `static`，也不能填写 `../public`。

错误配置会导致以下问题：

- Root directory 为 `static`、输出目录为 `public` 时，Cloudflare 会寻找不存在的 `static/public`。
- 输出目录为 `../public` 时，Cloudflare 会报 `build output directory is outside of the repository`。
- 正确路径必须是仓库内的 `public`，相对于仓库根目录计算。

仓库中的 `wrangler.toml` 已配置：

```toml
pages_build_output_dir = "./public"
```

因此 Pages 控制台与仓库配置应保持一致。

## 三、配置 D1

`wrangler.toml` 中应有一个名为 `top100-market` 的 D1 绑定，绑定变量为 `DB`。部署前确认其中的 `database_id` 是当前 Cloudflare 账户中的目标数据库 ID，不要把本地数据库 ID 当成线上数据库 ID。

如果还没有数据库，可以创建一个：

```sh
npx wrangler login
npx wrangler d1 create top100-market
```

将命令返回的线上数据库 ID 写入 `wrangler.toml` 的 `database_id`，再执行线上迁移：

```sh
npx wrangler d1 migrations apply top100-market --remote
```

线上迁移会修改生产数据库。执行前应确认数据库名称、账户和项目均正确；不要把 `--remote` 当作本地测试命令使用。

本地测试只使用本地 D1：

```sh
npx wrangler d1 migrations apply top100-market --local
```

## 四、本地运行和检查

需要 Node.js、npm 和 Wrangler：

```sh
npm install
npx wrangler d1 migrations apply top100-market --local
npm test
npm run dev
```

启动后可以在本地验证：

```sh
curl -i http://localhost:8788/
curl -i 'http://localhost:8788/api/indices'
curl -i 'http://localhost:8788/api/stocks?index=sp500'
curl -i 'http://localhost:8788/api/rank?index=sp500&range=1mo'
curl -i 'http://localhost:8788/api/stock/AAPL?range=1mo&interval=1d'
curl -i 'http://localhost:8788/api/index-history/sp500?range=1mo&interval=1d'
curl -i 'http://localhost:8788/api/fundamentals/AAPL'
```

本地端口以 Wrangler 启动输出为准。如果端口已经被占用，应使用 Wrangler 提供的端口参数切换端口。

## 五、通过 Git 自动部署

Pages 项目正确绑定 GitHub 仓库后，向生产分支 `main` 推送提交即可触发自动部署：

```sh
git add public worker.js functions migrations wrangler.toml README.md
git commit -m "更新 Cloudflare 页面"
git push origin main
```

部署流程通常包括：拉取仓库、读取 Wrangler 配置、生成 Pages Functions、发布 `public/` 静态文件。可以在 Cloudflare 控制台的 `Deployments` 中查看日志。

只有在以下条件都满足时，推送才会自动部署：

1. Pages 项目已经连接正确的 GitHub 仓库。
2. 推送分支是项目的 Production branch，通常为 `main`。
3. Root directory、Build command、Output directory 配置正确。
4. GitHub 仓库授权仍然有效。
5. D1 绑定和数据库迁移已经完成。

如果项目没有绑定 Git，也可以手动部署静态目录和 Functions，但手动部署不等于建立 Git 自动部署关系。

## 六、部署后验收

部署成功后，先打开首页，再检查接口：

```sh
curl -i https://你的项目.pages.dev/
curl -i https://你的项目.pages.dev/api/indices
curl -i 'https://你的项目.pages.dev/api/stocks?index=sp500'
curl -i 'https://你的项目.pages.dev/api/rank?index=sp500&range=1wk'
curl -i 'https://你的项目.pages.dev/api/stock/AAPL?range=1mo&interval=1d'
curl -i 'https://你的项目.pages.dev/api/index-history/sp500?range=1mo&interval=1d'
curl -i https://你的项目.pages.dev/api/fundamentals/AAPL
```

重点确认：

- 首页返回 HTTP 200，并能加载行情列表。
- `/api/indices` 返回指数列表。
- `/api/rank` 能识别 `1d`、`1wk`、`1mo`、`3mo`、`6mo`、`1y`。
- 历史数据接口返回日期和 K 线数据。
- 基本面接口即使 Yahoo 数据源不可用，也应返回可显示的兜底结果，而不是让整个页面报错。
- Cloudflare 部署日志中不再出现 `public not found` 或 `build output directory is outside of the repository`。

## 七、常见错误

### `Output directory "public" not found`

先检查 Cloudflare Pages 的 Root directory。对于本仓库，Root directory 必须留空，Output directory 填 `public`。如果 Root directory 为 `static`，Cloudflare 实际查找的是 `static/public`。

### `build output directory is outside of the repository`

检查是否把输出目录写成了 `../public`。改为 `public`，不要使用仓库外路径。

### `No Wrangler configuration file found`

确认部署使用的是仓库根目录，并且 `wrangler.toml` 已提交到 Git。即使没有 Wrangler 配置，纯静态页面也可能构建，但本项目的 Functions 和 D1 配置不会完整生效。

### 首页能打开，但 `/api/*` 返回 404

检查 `functions/_middleware.js` 是否存在并已提交，确认 Pages Functions 构建日志没有失败。也要确认请求路径确实以 `/api/` 开头。

### 基本面接口返回数据源错误

Yahoo 的 `quoteSummary` 是非官方公开接口，可能返回 401、限流或字段变化。当前 Worker 会返回带有 `source_error` 的可显示兜底结果；这不代表已经获得完整、权威的年报或分红数据。若生产环境需要稳定的基本面数据，应接入有授权的行情数据供应商。

### D1 相关接口返回 500

确认生产 D1 已执行迁移，并且 `wrangler.toml` 的数据库绑定指向正确数据库。线上数据库迁移使用：

```sh
npx wrangler d1 migrations apply top100-market --remote
```

不要只在 `--local` 数据库执行迁移后就认为线上已经完成。

## 八、已知限制

- Yahoo Finance 接口不是稳定的官方 API，可能限流、拒绝 Workers 请求或变更响应格式。
- 排名接口会并行请求成分股历史数据，大指数请求量较大时可能触发限流。
- 指数成分抓取失败时会使用内置兜底列表，兜底列表不是完整的权威成分快照。
- 基本面接口的年报和分红历史不能依赖 Yahoo quoteSummary 作为生产级数据源。
- 不要把 Cloudflare API Token、D1 凭据或其他密钥提交到 GitHub；推荐使用 `wrangler login` 或 Cloudflare 控制台的加密配置。
