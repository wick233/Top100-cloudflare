# AI 部署 Cloudflare 提示词

本文用于让具备终端权限的 AI 助手检查并部署本项目到 Cloudflare Pages。

## 使用前提

AI 助手必须能够：

- 访问本地项目目录 `/root/project/Top100-cloudflare`；
- 执行终端命令；
- 使用已经登录的 Wrangler，或读取安全配置中的 Cloudflare 凭据；
- 访问 GitHub 仓库 `wick233/Top100-cloudflare`。

仅复制提示词不会自动授予 AI 终端、GitHub 或 Cloudflare 权限。

## 推荐部署方式

推荐只在第一次部署时让 AI 检查 Cloudflare 配置。完成 GitHub 与 Pages 绑定后，后续发布通常只需要：

```sh
git add .
git commit -m "更新 Cloudflare 页面"
git push origin main
```

推送到 Cloudflare Pages 项目的生产分支后，会自动触发部署，不需要每次重新提供 Cloudflare Token。

Pages 项目应使用以下配置：

| 配置项 | 值 |
| --- | --- |
| GitHub 仓库 | `wick233/Top100-cloudflare` |
| Production branch | `main` |
| Root directory | 留空，使用仓库根目录 |
| Build command | 留空 |
| Build output directory | `public` |

本项目是仓库根目录布局，不能把 Root directory 设置为 `static`，也不能把输出目录设置为 `../public`。

## 凭据安全

不要把 Cloudflare API Token 直接粘贴到聊天窗口、提示词、GitHub 仓库或 Markdown 文件中。

优先使用本机 Wrangler 登录：

```sh
npx wrangler login
```

如果必须使用 API Token，应将它配置在本机的环境变量或终端工具的安全凭据存储中，并使用最小权限、短有效期 Token。不要把 Token 写入项目文件，也不要让 AI 在输出中打印 Token。

Token 至少应具备完成实际操作所需的 Cloudflare Pages 权限；D1 读取、D1 写入、Workers 或 Pages 权限是分开的，不能假定拥有其中一种权限就能完成所有操作。

## 可直接复制给 AI 的提示词

```text
请在当前仓库部署 Top100 到 Cloudflare Pages。

约束：
- 先检查仓库、当前分支、git 状态、wrangler.toml 和 Pages 配置，再操作。
- 本项目静态输出目录是 public，Pages Root directory 应为空，Build command 留空，Build output directory 为 public。
- 使用现有 Cloudflare Pages 项目 top100-cloudflare 和 GitHub 仓库 wick233/Top100-cloudflare，不要新建重复项目。
- 优先使用本机已登录的 Wrangler 身份；不要要求我把 API Token 粘贴到聊天，也不要输出、保存或提交任何凭据。
- 不要修改原项目，不要改 DNS 或自定义域名。
- 不要执行线上 D1 迁移，除非先说明迁移内容和影响并得到我确认。
- 部署前运行 npm test 和必要的 Wrangler 检查；如果发现配置不一致或需要有破坏性的远程操作，先停下来说明。
- 部署后验证 Pages 首页和 /api/indices、/api/stocks?index=sp500、/api/rank?index=sp500&range=1wk、/api/stock/AAPL?range=1mo&interval=1d。
- 最后报告部署 URL、部署结果、验证状态，以及之后是否已具备 push 自动部署条件。
```

## AI 应执行的检查内容

部署前，AI 应确认：

1. 当前仓库确实是 `Top100-cloudflare`，且没有误操作原项目 `/root/project/Top100`。
2. 当前分支和远程仓库正确，工作区变更不会被覆盖。
3. `public/index.html` 存在。
4. `wrangler.toml` 中的 `pages_build_output_dir` 指向 `./public`。
5. `functions/_middleware.js` 和 `worker.js` 存在。
6. Pages 项目的 Root directory、Build command、Output directory 与本文件一致。
7. `npm test`、Worker 语法检查和 Functions 构建检查通过。

## 部署后验收

AI 应实际请求以下地址，而不是只根据命令返回成功就宣布完成：

```text
/
/api/indices
/api/stocks?index=sp500
/api/rank?index=sp500&range=1wk
/api/stock/AAPL?range=1mo&interval=1d
```

验收时应确认：

- 首页返回 HTTP 200；
- `/api/indices` 返回指数列表；
- `/api/stocks` 返回股票列表；
- `/api/rank` 返回排名数据或明确的上游数据错误；
- `/api/stock/AAPL` 返回历史数据或明确的上游数据错误；
- Pages Functions 没有被错误地当成普通静态文件；
- 部署日志没有出现 `Output directory "public" not found`；
- 部署日志没有出现 `build output directory is outside of the repository`。

## 关于 D1 迁移

本项目使用 D1。线上数据库迁移会修改远程数据，不能作为普通部署步骤自动执行。

本地测试可以使用：

```sh
npx wrangler d1 migrations apply top100-market --local
```

线上迁移必须先确认数据库、账户和迁移内容，再执行：

```sh
npx wrangler d1 migrations apply top100-market --remote
```

除非用户明确授权，AI 不应自动执行 `--remote`。

## 部署失败时

AI 应保留完整错误信息，先判断属于哪一类：

- `Output directory "public" not found`：检查 Root directory 是否误填为 `static`，导致实际路径变成 `static/public`。
- `build output directory is outside of the repository`：检查是否填了 `../public`，改为 `public`。
- `/api/*` 返回 404：检查 `functions/_middleware.js` 是否存在、是否参与了 Pages Functions 构建。
- D1 相关接口返回 500：检查线上 D1 是否执行迁移，以及 `wrangler.toml` 的数据库绑定是否正确。
- 基本面数据源返回 401 或限流：Yahoo Finance 是非官方接口，检查 Worker 的兜底响应，不要把数据源暂时不可用误判成 Pages 部署失败。

AI 不应通过创建重复的 `public/` 目录、修改 DNS 或删除现有 Cloudflare 项目来掩盖配置错误。
