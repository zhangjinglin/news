# 热点聚合 · 我的资讯墙

一个跑在 Cloudflare Workers 上的轻量热点聚合页：打开即看，无登录、无刷新按钮，卡片内滚动浏览。

线上地址：<https://news-hot.jiv.workers.dev>

## 当前栏目（9 个）

| 栏目 | 数据来源 |
| --- | --- |
| 知乎热搜 / 知乎热榜 | allnet.hot |
| V2EX 最新 | allnet.hot |
| IT 之家 AI | allnet.hot |
| 虎嗅网最新 | allnet.hot |
| Linux DO | allnet.hot |
| 果壳首页推荐 | allnet.hot |
| 中关村最新资讯 | allnet.hot |
| 豆瓣实时热门 | top.open2hub.com |

## 结构

```
wrangler.toml        Workers 配置（静态目录指向 public）
src/index.js         后端：/api/sources、/api/hot、5 分钟边缘缓存
public/index.html    前端：卡片网格、站内关键词过滤、深浅色跟随系统
```

后端是 provider 适配器架构：每个上游站实现一组 `{ page, parse }`
（抓哪页、怎么抠条目），栏目配置里只写 `provider` + `ref`。

## 本地开发 / 部署

环境：Node 由 Volta 管理，包管理器用 pnpm。

```bash
pnpm install
pnpm exec wrangler dev      # 本地预览
pnpm exec wrangler deploy   # 发布
```

## 加新栏目

1. 只加同站栏目：在 `src/index.js` 的 `SOURCES` 里加一行，
   再在 `public/index.html` 的 `FALLBACK` 里同步加一行。
2. 加新网站：在 `PROVIDERS` 里加一个 `{ page, parse }` 适配器，
   然后按第 1 步配栏目即可。
