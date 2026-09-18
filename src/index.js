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

// 加新栏目只需要在下面加一行,provider 决定去哪个站抓,ref 是站内定位(详情页 id / 板块名)
const SOURCES = [
  { key: "zhihu-hot", name: "知乎热搜", desc: "知乎实时热搜", accent: "#0066ff", glyph: "知", provider: "allnet", ref: 76, origin: "https://allnet.hot/detail/76" },
  { key: "zhihu-top", name: "知乎热榜", desc: "知乎热榜讨论", accent: "#4c7df0", glyph: "榜", provider: "allnet", ref: 13, origin: "https://allnet.hot/detail/13" },
  { key: "v2ex", name: "V2EX 最新", desc: "创意工作者社区", accent: "#334155", glyph: "V", provider: "allnet", ref: 1199, origin: "https://allnet.hot/detail/1199" },
  { key: "ithome-ai", name: "IT 之家 AI", desc: "AI 科技资讯", accent: "#d32f2f", glyph: "AI", provider: "allnet", ref: 143, origin: "https://allnet.hot/detail/143" },
  { key: "huxiu", name: "虎嗅网最新", desc: "商业科技评论", accent: "#f59e0b", glyph: "虎", provider: "allnet", ref: 473, origin: "https://allnet.hot/detail/473" },
  { key: "linuxdo", name: "Linux DO", desc: "技术社区新帖", accent: "#10b981", glyph: "L", provider: "allnet", ref: 308, origin: "https://allnet.hot/detail/308" },
  { key: "guokr", name: "果壳首页推荐", desc: "科技科普推荐", accent: "#65a30d", glyph: "果", provider: "allnet", ref: 124, origin: "https://allnet.hot/detail/124" },
  { key: "zol", name: "中关村最新资讯", desc: "数码科技资讯", accent: "#0284c7", glyph: "中", provider: "allnet", ref: 702, origin: "https://allnet.hot/detail/702" },
  { key: "douban", name: "豆瓣实时热门", desc: "实时热门讨论", accent: "#007722", glyph: "豆", provider: "open2hub", ref: "豆瓣", origin: "https://top.open2hub.com/" },
  { key: "zaker", name: "ZAKER 新闻", desc: "新闻频道热点", accent: "#e11d48", glyph: "Z", provider: "open2hub", ref: "ZAKER", page: "https://top.open2hub.com/channel/news", origin: "https://top.open2hub.com/channel/news" },
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

/** open2hub 首页:按 <h3 class="platform-title">板块名</h3> 切出对应区块,
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
        sources: SOURCES.map(({ key, name, desc, accent, glyph, provider, ref, origin }) => ({
          key,
          name,
          desc,
          accent,
          glyph,
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
