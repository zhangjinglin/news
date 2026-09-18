/* Cloudflare Worker: 多站热点聚合代理 + 静态站
 * GET /api/hot?key=xxx -> 按栏目配置选 provider 抓取上游页面并解析成 JSON
 * 缓存 5 分钟,失败回退旧缓存,避免打爆上游
 *
 * 加新栏目:在 SOURCES 里加一行;加新网站:在 PROVIDERS 里加一个
 * { page, parse } 适配器即可,分别是“抓哪页”和“怎么抠条目”。
 */

const CACHE_TTL = 300; // 秒

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// 加新栏目只需要在下面追加一行,展示时自动倒序,新加的永远排最前面
// provider 决定去哪个站抓,ref 是站内定位(详情页 id / 板块名)
// cat 决定顶部分类页签:all(全部,隐含) / news(综合) / tech(科技) / bbs(社区)
const SOURCES = [
  { key: "zhihu-hot", name: "知乎热搜", desc: "知乎实时热搜", accent: "#0066ff", glyph: "知", cat: "news", provider: "allnet", ref: 76, origin: "https://allnet.hot/detail/76" },
  { key: "zhihu-top", name: "知乎热榜", desc: "知乎热榜讨论", accent: "#4c7df0", glyph: "榜", cat: "news", provider: "allnet", ref: 13, origin: "https://allnet.hot/detail/13" },
  { key: "v2ex", name: "V2EX 最新", desc: "创意工作者社区", accent: "#334155", glyph: "V", cat: "bbs", provider: "allnet", ref: 1199, origin: "https://allnet.hot/detail/1199" },
  { key: "ithome-ai", name: "IT 之家 AI", desc: "AI 科技资讯", accent: "#d32f2f", glyph: "AI", cat: "tech", provider: "allnet", ref: 143, origin: "https://allnet.hot/detail/143" },
  { key: "huxiu", name: "虎嗅网最新", desc: "商业科技评论", accent: "#f59e0b", glyph: "虎", cat: "tech", provider: "allnet", ref: 473, origin: "https://allnet.hot/detail/473" },
  { key: "linuxdo", name: "Linux DO", desc: "技术社区新帖", accent: "#10b981", glyph: "L", cat: "bbs", provider: "allnet", ref: 308, origin: "https://allnet.hot/detail/308" },
  { key: "guokr", name: "果壳首页推荐", desc: "科技科普推荐", accent: "#65a30d", glyph: "果", cat: "tech", provider: "allnet", ref: 124, origin: "https://allnet.hot/detail/124" },
  { key: "zol", name: "中关村最新资讯", desc: "数码科技资讯", accent: "#0284c7", glyph: "中", cat: "tech", provider: "allnet", ref: 702, origin: "https://allnet.hot/detail/702" },
  { key: "douban", name: "豆瓣实时热门", desc: "实时热门讨论", accent: "#007722", glyph: "豆", cat: "news", provider: "open2hub", ref: "豆瓣", origin: "https://top.open2hub.com/" },
  { key: "zaker", name: "ZAKER 新闻", desc: "新闻频道热点", accent: "#e11d48", glyph: "Z", cat: "news", provider: "open2hub", ref: "ZAKER", page: "https://top.open2hub.com/channel/news", origin: "https://top.open2hub.com/channel/news" },
  { key: "cto51", name: "51CTO 推荐", desc: "技术干货推荐", accent: "#c2410c", glyph: "51", cat: "tech", provider: "open2hub", ref: "51CTO", page: "https://top.open2hub.com/channel/tech", origin: "https://top.open2hub.com/channel/tech" },
  { key: "tweet", name: "推文起爆榜", desc: "X 中文热门推文", accent: "#64748b", glyph: "X", cat: "bbs", provider: "sopilot", ref: "rank", origin: "https://sopilot.net/rank" },
  { key: "tweet-hot", name: "推文最热曝光", desc: "6 小时曝光最高", accent: "#0f766e", glyph: "爆", cat: "bbs", provider: "sopilot", ref: "tweets-6h", page: "https://sopilot.net/zh/rank/tweets?range=6h", origin: "https://sopilot.net/zh/rank/tweets?range=6h" },
  { key: "article", name: "长文起爆榜", desc: "X 热门长文", accent: "#7c3aed", glyph: "文", cat: "bbs", provider: "sopilot", ref: "articles", page: "https://sopilot.net/zh/rank/articles", origin: "https://sopilot.net/zh/rank/articles" },
  { key: "hot-day", name: "榜中榜日榜", desc: "全网热度聚合", accent: "#db2777", glyph: "日", cat: "news", provider: "tophub", ref: "hot", origin: "https://tophub.today/hot" },
];

const byKey = Object.fromEntries(SOURCES.map((s) => [s.key, s]));
// 兼容老参数 ?id=76 :只对 allnet 栏目的数字 id 有效
const byId = Object.fromEntries(
  SOURCES.filter((s) => s.provider === "allnet").map((s) => [String(s.ref), s])
);

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=60",
      ...extra,
    },
  });
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s) {
  return decodeEntities((s || "").replace(/<[^>]*>/g, "").trim());
}

function attr(tag, name) {
  const m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? decodeEntities(m[1]) : "";
}

/** allnet.hot 详情页:从 data-list-item 锚点里抠条目,兼容有图 / 无图两种写法 */
function parseAllnet(html) {
  const items = [];
  const re = /<a\s[^>]*class="data-list-item[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && items.length < 50) {
    const full = m[0];
    const inner = m[1];
    const openTag = full.slice(0, full.indexOf(">") + 1);

    const titleAttr = attr(openTag, "data-title");
    const urlAttr = attr(openTag, "data-url");
    const href = attr(openTag, "href");
    const image = attr(openTag, "data-image-url");
    const date = attr(openTag, "data-item-date");

    let rank = items.length + 1;
    const rankM =
      inner.match(/data-item-index[^"]*"[^>]*>\s*(\d+)/) ||
      openTag.match(/rank-(\d+)/) ||
      inner.match(/rank-(\d+)/);
    if (rankM) rank = parseInt(rankM[1], 10);

    let title = titleAttr;
    if (!title) {
      const t = inner.match(/data-item-title[^>]*>([\s\S]*?)<\//);
      title = t ? stripTags(t[1]) : "";
    }
    title = stripTags(title);
    if (!title) continue;

    let url = urlAttr || href;
    if (!url) continue;
    if (url.startsWith("//")) url = "https:" + url;

    let status = "";
    if (full.includes("status-new") || />\s*新\s*</.test(inner)) status = "new";
    else if (full.includes("status-up")) status = "up";
    else if (full.includes("status-down")) status = "down";

    // 内嵌 <img> 兜底(有图卡片 data-image-url 偶尔为空)
    let img = image;
    if (!img) {
      const im = inner.match(/<img[^>]*src="([^"]+)"/);
      if (im) img = decodeEntities(im[1]);
    }

    items.push({ rank, title, url, image: img || "", date: date || "", status });
  }
  items.sort((a, b) => a.rank - b.rank);
  return items;
}

/** sopilot 推文榜:从 x.com/status 锚点抠条目。
 *  纯图片/视频推文的锚文本只有时间,则往后找作者名拼标题 */
function parseSopilot(html) {
  const items = [];
  const seen = new Set();
  const re = /href=\\?"(https:\/\/x\.com\/[^"]+\/status\/[^"]+)\\?"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null && items.length < 50) {
    const url = m[1];
    if (seen.has(url)) continue;
    let title = stripTags(m[2]).replace(/\s*https?:\/\/t\.co\/\w+\s*/g, " ").trim();
    // 纯数字的是点赞/回复数链接,不是推文标题
    if (title.length < 2 || /^\d+$/.test(title)) continue;
    if (/^\d{1,2}\/\d{1,2},\s*\d{1,2}:\d{2}\s*[AP]M$/.test(title)) {
      const ahead = html.slice(m.index, m.index + 2000);
      const am = ahead.match(/rank\/creators\/[^"]*"[^>]*title="([^"]+)"/) ||
        ahead.match(/class="truncate"[^>]*>([^<]+)</);
      const author = am ? stripTags(am[1]) : "";
      title = author ? `${author} 的热门推文` : "热门推文(图片/视频)";
    }
    seen.add(url);
    items.push({ rank: items.length + 1, title, url, image: "", date: "", status: "" });
  }
  return items;
}

/** tophub 榜中榜日榜:按 li.child-item 切块,取排名/标题/链接/来源热度 */
function parseTophub(html) {
  const items = [];
  const blocks = html.match(/<li class="child-item">[\s\S]*?<\/li>/g) || [];
  for (const b of blocks) {
    if (items.length >= 50) break;
    const rm = b.match(/index-\d+">\s*(\d+)/);
    const um = b.match(/medium-txt"><a href="([^"]+)"/);
    const tm = b.match(/medium-txt"><a[^>]*>([\s\S]*?)<\/a>/);
    const sm = b.match(/small-txt">([\s\S]*?)<\/p>/);
    if (!um || !tm) continue;
    const title = stripTags(tm[1]).replace(/\s+/g, " ").trim();
    if (!title) continue;
    const meta = sm ? stripTags(sm[1]).replace(/\s+/g, " ").trim() : "";
    items.push({
      rank: rm ? parseInt(rm[1], 10) : items.length + 1,
      title,
      url: um[1],
      image: "",
      date: "",
      status: "",
      meta,
    });
  }
  items.sort((a, b) => a.rank - b.rank);
  return items;
}

/** sopilot 长文榜:按 <article> 卡片切块,取状态链接 + <h2> 真标题 */
function parseSopilotArticles(html) {
  const items = [];
  const seen = new Set();
  const blocks = html.match(/<article[\s\S]*?<\/article>/g) || [];
  for (const b of blocks) {
    if (items.length >= 50) break;
    const um = b.match(/href=\\?"(https:\/\/x\.com\/[^"\\]+)\\?"/);
    const tm = b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!um || !tm) continue;
    const url = um[1];
    const title = stripTags(tm[1]).replace(/\s+/g, " ").trim();
    if (!title || seen.has(url)) continue;
    seen.add(url);
    items.push({ rank: items.length + 1, title, url, image: "", date: "", status: "" });
  }
  return items;
}

/** open2hub:按 <h3 class="platform-title">板块名</h3> 切出对应区块,
 *  再从 list-item-link 锚点里抠 (list-number 排名 + list-text 标题) */
function parseOpen2hub(html, section) {
  const items = [];
  const head = `<h3 class="platform-title">${section}</h3>`;
  let start = html.indexOf(head);
  if (start < 0) return items;
  start += head.length;
  let end = html.indexOf('<h3 class="platform-title">', start);
  if (end < 0) end = html.length;
  const block = html.slice(start, end);
  const re = /<a\s[^>]*class="list-item-link"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(block)) !== null && items.length < 50) {
    const full = m[0];
    const inner = m[1];
    const openTag = full.slice(0, full.indexOf(">") + 1);
    const url = attr(openTag, "href");
    const numM = inner.match(/list-number[^>]*>\s*(\d+)/);
    const txtM = inner.match(/list-text[^>]*>([\s\S]*?)<\//);
    const title = txtM ? stripTags(txtM[1]) : "";
    if (!title || !url || url === "-") continue;
    items.push({
      rank: numM ? parseInt(numM[1], 10) : items.length + 1,
      title,
      url: url.startsWith("//") ? "https:" + url : url,
      image: "",
      date: "",
      status: "",
    });
  }
  items.sort((a, b) => a.rank - b.rank);
  return items;
}

// 每个上游站一个适配器:page(抓哪页) + parse(怎么抠)
const PROVIDERS = {
  allnet: {
    page: (src) => `https://allnet.hot/detail/${src.ref}`,
    parse: (html) => parseAllnet(html),
  },
  open2hub: {
    // 默认抓首页;个别板块只在频道页出现时,栏目配 page 覆盖
    page: (src) => src.page || `https://top.open2hub.com/`,
    parse: (html, src) => parseOpen2hub(html, src.ref),
  },
  sopilot: {
    // /zh/rank 不稳定,直接抓无语言前缀的 /rank(内容同样是中文热推);
    // 曝光榜/长文榜这类子榜单由栏目配 page 覆盖;长文榜用 article 卡片解析
    page: (src) => src.page || `https://sopilot.net/rank`,
    parse: (html, src) => (src.ref === "articles" ? parseSopilotArticles(html) : parseSopilot(html)),
  },
  tophub: {
    page: () => `https://tophub.today/hot`,
    parse: (html) => parseTophub(html),
  },
};

async function fetchUpstream(src) {
  const p = PROVIDERS[src.provider];
  if (!p) throw new Error(`unknown provider ${src.provider}`);
  const target = p.page(src);
  const resp = await fetch(target, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "zh-CN,zh;q=0.9",
      referer: new URL(target).origin + "/",
    },
  });
  if (!resp.ok) throw new Error(`upstream ${resp.status}`);
  return p.parse(await resp.text(), src);
}

async function handleHot(request, key, ctx) {
  const src = byKey[key] || byId[String(key)];
  if (!src) return json({ ok: false, error: "unknown source" }, 404);

  const url = new URL(request.url);
  const force = url.searchParams.get("force") === "1" || url.searchParams.get("t");
  const cache = caches.default;
  const cacheKey = new Request(`https://hot.local/api/hot?key=${src.key}`, request);
  if (!force) {
  try {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const data = await hit.json();
      // 后台悄悄刷新,不阻塞本次返回(纯手动刷新场景下次生效)
      ctx.waitUntil(
        (async () => {
          try {
            const items = await fetchUpstream(src);
            const fresh = {
              ok: true,
              key: src.key,
              name: src.name,
              updatedAt: new Date().toISOString(),
              items,
              cached: false,
            };
            await cache.put(
              cacheKey,
              new Response(JSON.stringify(fresh), {
                headers: { "content-type": "application/json" },
              })
            );
          } catch (_) {
            /* 忽略后台刷新失败 */
          }
        })()
      );
      return json({ ...data, cached: true }, 200, { "x-cache": "HIT" });
    }
  } catch (_) {
    /* 无缓存可用时继续往下抓 */
  }
  }

  const items = await fetchUpstream(src);
  const payload = {
    ok: true,
    key: src.key,
    name: src.name,
    updatedAt: new Date().toISOString(),
    items,
    cached: false,
  };
  try {
    const toStore = new Response(JSON.stringify(payload), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${CACHE_TTL}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, toStore));
  } catch (_) {
    /* 缓存写失败不影响返回 */
  }
  return json(payload, 200, { "x-cache": "MISS" });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/api/sources") {
      return json({
        ok: true,
        // 展示倒序:后追加的(新的)排前面
        sources: [...SOURCES].reverse().map(({ key, name, desc, accent, glyph, cat, provider, ref, origin }) => ({
          key,
          name,
          desc,
          accent,
          glyph,
          cat,
          provider,
          ref,
          origin,
        })),
      });
    }

    if (url.pathname === "/api/hot") {
      const key = url.searchParams.get("key") || url.searchParams.get("id") || "";
      try {
        return await handleHot(request, key, ctx);
      } catch (e) {
        return json({ ok: false, error: String((e && e.message) || e) }, 502);
      }
    }

    if (url.pathname === "/api/health") {
      return json({ ok: true, time: new Date().toISOString() });
    }

    // 其余请求交给静态资源(./public)
    try {
      if (env && env.ASSETS && typeof env.ASSETS.fetch === "function") {
        return await env.ASSETS.fetch(request);
      }
    } catch (_) {
      /* 掉到 404 */
    }
    return new Response("not found", { status: 404 });
  },
};
