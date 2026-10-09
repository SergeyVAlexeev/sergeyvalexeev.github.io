// Fetches the configured public website pages and extracts readable text with
// links. Results are cached in memory for WEBSITE_TTL_SECONDS; a last-good
// snapshot in KV covers fetch failures and cold isolates.

import { kvGet, kvPut, log } from "./store.js";

const KV_KEY = "website";

const state = {
  snapshot: null, // { fetchedAt, pages: [{ url, title, description, text, fetchedAt, ok, error }] }
  inflight: null,
  lastError: null,
};

export function resetWebsiteState() {
  state.snapshot = null;
  state.inflight = null;
  state.lastError = null;
}

export function websiteState() {
  return state;
}

// ---------- HTML extraction ----------

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr",
]);
// Elements dropped with their contents (navigation, controls, media players).
const DROP_TAGS = new Set(["nav", "footer", "form", "button", "video", "audio", "select", "textarea", "dialog"]);
const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "header", "main", "aside", "ul", "ol", "table", "tr", "details", "summary",
  "blockquote", "figure", "figcaption", "dl", "dt", "dd", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "li",
]);

const ABS = "\u0001"; // marks the start of a publication abstract

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", middot: "·",
  copy: "©", times: "×", rarr: "→", larr: "←", uarr: "↑", darr: "↓",
  minus: "−", thinsp: " ", ensp: " ", emsp: " ", shy: "",
};

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    const v = ENTITIES[code.toLowerCase()];
    return v === undefined ? m : v;
  });
}

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? "") : null;
}

function isHidden(attrs) {
  return /(?:^|\s)hidden(?:\s|=|\/|$)/i.test(attrs) || /aria-hidden\s*=\s*["']?true/i.test(attrs);
}

function resolveLink(href, pageUrl) {
  if (!href) return null;
  if (/^(javascript:|#)/i.test(href)) return null; // same-page anchors add noise
  try {
    const u = new URL(href, pageUrl);
    if (u.protocol === "mailto:") return `mailto:${u.pathname}`; // drop prefilled subject/body
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function extractPage(html, pageUrl, maxChars) {
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim());
  const descTag = /<meta\s[^>]*name=["']description["'][^>]*>/i.exec(html)?.[0] || "";
  const description = attr(descTag.replace(/^<meta/i, ""), "content") || "";

  let src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<![^>]*>/g, "")
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, "");

  let out = "";
  let skipTag = null;
  let skipDepth = 0;
  const links = [];
  const tokenRe = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|</g;
  let m;
  while ((m = tokenRe.exec(src))) {
    const [, closing, rawTag, attrs = "", text] = m;
    if (text !== undefined || rawTag === undefined) {
      if (!skipTag) out += decodeEntities(text ?? "<").replace(/\s+/g, " ");
      continue;
    }
    const tag = rawTag.toLowerCase();
    const isVoid = VOID_TAGS.has(tag) || /\/\s*$/.test(attrs);

    if (skipTag) {
      if (tag === skipTag && !isVoid) skipDepth += closing ? -1 : 1;
      if (skipDepth === 0) skipTag = null;
      continue;
    }
    if (!closing && !isVoid && (DROP_TAGS.has(tag) || isHidden(attrs))) {
      skipTag = tag;
      skipDepth = 1;
      continue;
    }

    if (tag === "a") {
      if (!closing) {
        links.push({ href: resolveLink(attr(attrs, "href"), pageUrl), start: out.length });
      } else if (links.length) {
        const { href, start } = links.pop();
        // An abstract nested inside a title link goes after the link.
        const [label, abstract] = out.slice(start).replace(/\s+/g, " ").split(ABS).map((s) => s.trim());
        const bare = href ? href.replace(/^mailto:/, "") : "";
        out = out.slice(0, start) + (href && label && label !== bare ? ` [${label}](${href}) ` : ` ${label} `);
        if (abstract) out += `\u2014 ${abstract} `;
      }
      continue;
    }

    if (!closing && /^h[1-6]$/.test(tag)) {
      out += tag === "h1" ? "\n\n# " : Number(tag[1]) <= 3 ? "\n\n## " : "\n\n### ";
    } else if (!closing && tag === "li") {
      out += "\n- ";
    } else if (!closing && tag === "span" && /class=["'][^"']*\babs\b/.test(attrs)) {
      out += ABS; // publication abstract preview
    } else if (BLOCK_TAGS.has(tag)) {
      out += "\n";
    }
  }

  let textOut = out
    .replaceAll(ABS, " \u2014 ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, i, arr) => l || (arr[i - 1] && arr[i - 1].trim()))
    .join("\n")
    .replace(/^(#+|-)\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (maxChars && textOut.length > maxChars) {
    const cut = textOut.lastIndexOf("\n", maxChars);
    textOut = textOut.slice(0, cut > maxChars * 0.5 ? cut : maxChars) + "\n[Page truncated.]";
  }
  return { title, description, text: textOut };
}

// ---------- Fetching and caching ----------

async function fetchPage(url, cfg, index) {
  const res = await fetch(url, {
    headers: { "User-Agent": "SergeyAI-Worker/1.0 (+https://www.alexeev.pw/)", Accept: "text/html" },
    signal: AbortSignal.timeout(cfg.WEBSITE_TIMEOUT_MS),
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const max = index === 0 ? cfg.WEBSITE_HOME_MAX_CHARS : cfg.WEBSITE_PAGE_MAX_CHARS;
  return extractPage(html, url, max);
}

async function refresh(env, cfg, ctx) {
  const now = Date.now();
  const previous = state.snapshot || (await kvGet(env, KV_KEY));
  const prevByUrl = new Map((previous?.pages || []).map((p) => [p.url, p]));

  const results = await Promise.allSettled(cfg.websitePages.map((url, i) => fetchPage(url, cfg, i)));
  const pages = results.map((r, i) => {
    const url = cfg.websitePages[i];
    if (r.status === "fulfilled") return { url, ...r.value, fetchedAt: now, ok: true };
    const error = r.reason?.name === "TimeoutError" ? "timed out" : String(r.reason?.message || r.reason);
    log("website_page_error", { url, error });
    const prev = prevByUrl.get(url);
    return prev ? { ...prev, ok: false, error } : { url, title: "", description: "", text: "", fetchedAt: 0, ok: false, error };
  });

  const okCount = pages.filter((p) => p.ok).length;
  state.lastError = okCount === pages.length ? null : { at: now, message: `${pages.length - okCount} of ${pages.length} pages failed` };
  // Retry failed pages after a minute rather than waiting for the full TTL.
  const nextRefreshAt = now + (okCount === pages.length ? cfg.WEBSITE_TTL_SECONDS * 1000 : 60_000);
  state.snapshot = { fetchedAt: now, nextRefreshAt, pages };

  const changed = JSON.stringify(pages.map((p) => p.text)) !== JSON.stringify((previous?.pages || []).map((p) => p.text));
  if (okCount > 0 && (changed || !previous)) {
    log("website_updated", { pages: okCount });
    const write = kvPut(env, KV_KEY, state.snapshot);
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
  }
  return state.snapshot;
}

// Returns { status: "fresh" | "partial" | "stale" | "unavailable", fetchedAt, pages }
export async function getWebsite(env, cfg, ctx) {
  const now = Date.now();
  let snap = state.snapshot;
  if (!snap || now >= snap.nextRefreshAt) {
    state.inflight ||= refresh(env, cfg, ctx).finally(() => (state.inflight = null));
    snap = await state.inflight;
  }
  const usable = snap.pages.filter((p) => p.text);
  const okCount = snap.pages.filter((p) => p.ok).length;
  const status =
    usable.length === 0 ? "unavailable" : okCount === snap.pages.length ? "fresh" : okCount > 0 ? "partial" : "stale";
  return { status, fetchedAt: snap.fetchedAt, pages: snap.pages };
}

export function formatWebsite(website) {
  return website.pages
    .filter((p) => p.text)
    .map((p) => {
      const head = [`### Page: ${p.title || p.url}`, `URL: ${p.url}`];
      if (p.description) head.push(`Summary: ${p.description}`);
      if (!p.ok && p.fetchedAt) head.push(`(Could not refresh this page; showing copy from ${new Date(p.fetchedAt).toISOString()}.)`);
      return head.join("\n") + "\n\n" + p.text;
    })
    .join("\n\n");
}
