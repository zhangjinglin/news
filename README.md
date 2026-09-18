# 热点聚合 · 我的资讯墙

一个跑在 Cloudflare Workers 上的轻量热点聚合页：打开即看，无登录、无刷新按钮，卡片内滚动浏览。

## 当前栏目（15 个，分综合 / 科技 / 社区三类）

| 栏目 | 分类 | 数据来源 |
| --- | --- | --- |
| 榜中榜日榜 | 综合 | tophub.today/hot |
| 知乎热搜 / 知乎热榜 | 综合 | allnet.hot |
| 豆瓣实时热门 | 综合 | top.open2hub.com |
| ZAKER 新闻 | 综合 | top.open2hub.com/channel/news |
| IT 之家 AI / 虎嗅网最新 / 果壳首页推荐 / 中关村最新资讯 | 科技 | allnet.hot |
| 51CTO 推荐 | 科技 | top.open2hub.com/channel/tech |
| V2EX 最新 / Linux DO | 社区 | allnet.hot |
| 推文起爆榜 / 推文最热曝光（6 小时） | 社区 | sopilot.net |
| 长文起爆榜 | 社区 | sopilot.net/zh/rank/articles |

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

1. 只加同站栏目：在 `src/index.js` 的 `SOURCES` 末尾追加一行
   （记得填 `cat` 分类：news 综合 / tech 科技 / bbs 社区），
   再在 `public/index.html` 的 `FALLBACK` 末尾同步追加一行。
   展示自动倒序，新加的永远排最前面。
2. 加新网站：在 `PROVIDERS` 里加一个 `{ page, parse }` 适配器，
   然后按第 1 步配栏目即可。
