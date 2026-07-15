#!/usr/bin/env node
"use strict";
/*
 * 金价全天候监控脚本（与主机无关，跑在任何有 Node.js 18+ 的地方）
 * ---------------------------------------------------------------
 * 作用：定时抓取实时金价 → 计算持仓与建议 → 当进入补仓/止盈/止损档位时，
 *       通过 Server酱(ServerChan) 把提醒推到你的微信。
 * 依赖：仅 Node 内置 fetch（Node 18+ 自带），无需 npm install。
 *
 * 配置：同目录下的 monitor-config.json（由网页「导出监控配置」生成，结构一致）
 * 状态：同目录下的 monitor-state.json（记录上次推送到的档位，避免重启重复推）
 *
 * 运行：
 *   node monitor.js              # 前台运行，每 5 分钟检查一次（默认）
 *   INTERVAL=300 node monitor.js # 自定义间隔（秒）
 * 常驻：用 pm2 / nohup / 服务器定时任务 / 云函数 跑起来即可 24/7
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "monitor-config.json");
const STATE_PATH = path.join(__dirname, "monitor-state.json");

const OZ_TO_G = 31.1034768;
const DEFAULT_RATE = 7.18;
const INTERVAL_SEC = Number(process.env.INTERVAL) || 300; // 默认 5 分钟

/* ---------------- 配置与状态 ---------------- */
// 配置优先级：环境变量 MONITOR_CONFIG_B64（base64，GitHub Actions 用 Secret 注入）
//            > 环境变量 MONITOR_CONFIG（原始 JSON）
//            > 本地文件 monitor-config.json
// 用环境变量可避免把真实持仓/推送 key 提交到公开仓库。
function normalizeConfig(cfg) {
  cfg = cfg || {};
  cfg.strategy = Object.assign(
    { stopLoss: 8, takeProfit: 15, addDrop: 5, addTranche: 25, sellRatio: 33, premium: 0 },
    cfg.strategy || {}
  );
  cfg.transactions = cfg.transactions || [];
  cfg.push = cfg.push || { enabled: false, channel: "serverchan", key: "" };
  cfg.mode = cfg.mode || "domestic";
  return cfg;
}
function loadConfig() {
  if (process.env.MONITOR_CONFIG_B64) {
    try {
      return normalizeConfig(JSON.parse(Buffer.from(process.env.MONITOR_CONFIG_B64, "base64").toString("utf-8")));
    } catch (e) {
      console.error("[错误] 环境变量 MONITOR_CONFIG_B64 解析失败：", e.message);
      process.exit(1);
    }
  }
  if (process.env.MONITOR_CONFIG) {
    try { return normalizeConfig(JSON.parse(process.env.MONITOR_CONFIG)); }
    catch (e) {
      console.error("[错误] 环境变量 MONITOR_CONFIG 解析失败：", e.message);
      process.exit(1);
    }
  }
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(
      `[错误] 找不到配置 ${CONFIG_PATH}，也没设置 MONITOR_CONFIG_B64 环境变量。\n` +
      `GitHub Actions 用法：在网页点「导出监控配置」→ base64 编码 → 设为仓库 Secret: MONITOR_CONFIG_B64。\n` +
      `本地用法：把导出的配置保存为同目录 monitor-config.json。`
    );
    process.exit(1);
  }
  return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")));
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8")); }
  catch (e) { return { lastLevel: null, lastTier: 0 }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s), "utf-8");
}

/* ---------------- 价格抓取（与网页一致） ---------------- */
async function fetchIntlPrice() {
  const r = await fetch("https://api.gold-api.com/price/XAU", { cache: "no-store" });
  if (!r.ok) throw new Error("gold-api http " + r.status);
  const d = await r.json();
  return Number(d.price);
}
async function fetchRate() {
  try {
    const rr = await fetch("https://open.er-api.com/v6/latest/USD", { cache: "no-store" });
    if (rr.ok) { const rd = await rr.json(); if (rd && rd.rates && rd.rates.CNY) return Number(rd.rates.CNY); }
  } catch (e) {}
  return DEFAULT_RATE;
}
function intlToDomestic(intlUsdOz, rate, premium) {
  return intlUsdOz / OZ_TO_G * rate * (1 + (premium || 0) / 100);
}

/* ---------------- 持仓计算（与网页 computePosition 一致） ---------------- */
function computePosition(cfg) {
  const tx = [...cfg.transactions].sort((a, b) => a.date < b.date ? -1 : 1);
  let grams = 0, cost = 0, realized = 0;
  for (const t of tx) {
    const g = Number(t.grams) || 0, p = Number(t.price) || 0, f = Number(t.fee) || 0;
    if (t.type === "buy") {
      const amt = g * p + f;
      grams += g; cost += amt;
    } else {
      if (grams > 0) {
        const avgBefore = cost / grams;
        const sold = Math.min(g, grams);
        realized += sold * (p - avgBefore) - f;
        cost -= sold * avgBefore;
        grams -= sold;
      }
    }
  }
  const avg = grams > 0 ? cost / grams : 0;
  return { grams, cost, avg, realized };
}

/* ---------------- 建议引擎 + 档位（与网页 recommend/pushIfNeeded 一致） ---------------- */
function fmtM(v, d = 2) { return (v || 0).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d }); }
function fmtP(v) { return (v >= 0 ? "+" : "") + v.toFixed(2) + "%"; }

function evaluate(price, pos, s) {
  if (pos.grams <= 0) return { level: "empty", avg: 0 };
  const { grams, cost, avg } = pos;
  const sl = avg * (1 - s.stopLoss / 100);
  const tp = avg * (1 + s.takeProfit / 100);
  let level;
  if (price <= sl) level = "stop";
  else if (price < avg) level = "add";
  else if (price < tp) level = "hold";
  else level = "act";
  return { level, avg, sl, tp };
}

function computeHitTier(price, avg, drop) {
  if (!(avg > 0)) return 0;
  let hitTier = 0;
  for (let k = 1; k <= 8; k++) {
    const tierPrice = avg * (1 - drop * k / 100);
    if (price <= tierPrice) hitTier = k;
    else break;
  }
  return hitTier;
}

/* ---------------- 推送（Server酱，与网页 sendPush 一致） ---------------- */
async function sendPush(title, desp, cfg) {
  if (!cfg.push.enabled || !cfg.push.key || !cfg.push.key.trim()) return false;
  const key = cfg.push.key.trim();
  try {
    if (cfg.push.channel === "serverchan") {
      const url = `https://sctapi.ftqq.com/${encodeURIComponent(key)}.send`;
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `title=${encodeURIComponent(title)}&desp=${encodeURIComponent(desp)}`,
      });
      const j = await r.json().catch(() => ({}));
      if (j.code === 0) return true;
      console.warn("  [Server酱返回]", j);
      return false;
    } else {
      const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
      await fetch(url, {
        method: "POST", mode: "no-cors",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "markdown", markdown: { content: `## ${title}\n${desp.replace(/\n/g, "\n\n")}` } }),
      });
      return true;
    }
  } catch (e) { console.warn("  [推送失败]", e.message); return false; }
}

/* ---------------- 单次检查 ---------------- */
async function checkOnce(cfg, state) {
  const intl = await fetchIntlPrice();
  const rate = await fetchRate();
  const price = cfg.mode === "international"
    ? intl
    : intlToDomestic(intl, rate, cfg.strategy.premium);

  const pos = computePosition(cfg);
  if (pos.grams <= 0) {
    console.log(`[${ts()}] 持仓为空，跳过（金价 ${fmtM(price)} 元/克）`);
    return;
  }

  const rec = evaluate(price, pos, cfg.strategy);
  const ACTIONABLE = ["add", "act", "stop"];
  const unit = cfg.mode === "domestic" ? "元/克" : "美元/盎司";

  console.log(`[${ts()}] 金价 ${fmtM(price)} · 均价 ${fmtM(pos.avg)} · 状态 ${rec.level} · 上次档位 ${state.lastTier}`);

  // 1) 粗粒度状态切换
  if (ACTIONABLE.includes(rec.level)) {
    if (rec.level !== state.lastLevel) {
      state.lastLevel = rec.level;
      state.lastTier = 0;
      const titleMap = { add: "回调补仓区", act: "已达止盈线", stop: "已触止损线" };
      const desp = `当前${unit}：${fmtM(price)}\n持仓均价：${fmtM(pos.avg)}\n浮亏：${fmtP((price - pos.avg) / pos.avg * 100)}`;
      await sendPush(`黄金调仓提醒：${titleMap[rec.level]}`, desp, cfg);
      console.log(`  → 推送状态切换：${rec.level}`);
    }
  } else {
    state.lastLevel = rec.level;
  }

  // 2) 补仓区逐档位
  if (rec.level === "add" && pos.avg > 0) {
    const hitTier = computeHitTier(price, pos.avg, cfg.strategy.addDrop || 3);
    if (hitTier > state.lastTier) {
      state.lastTier = hitTier;
      const tierPrice = pos.avg * (1 - cfg.strategy.addDrop * hitTier / 100);
      const desp =
        `金价 ${fmtM(price)} ${unit}\n` +
        `第${hitTier}档触发价 ${fmtM(tierPrice)}（较均价 -${cfg.strategy.addDrop * hitTier}%）\n` +
        `持仓均价 ${fmtM(pos.avg)}，浮亏 ${fmtP((price - pos.avg) / pos.avg * 100)}\n` +
        `建议按金字塔计划表买入第${hitTier}档对应克数`;
      await sendPush(`补仓提醒：已进入第${hitTier}档`, desp, cfg);
      console.log(`  → 推送补仓第${hitTier}档`);
    }
  }

  saveState(state);
}

function ts() { return new Date().toLocaleString("zh-CN"); }

/* ---------------- 主循环 ---------------- */
function bootstrap() {
  const cfg = loadConfig();
  // 允许用独立 Secret 覆盖推送 key（与配置解耦）
  if (process.env.SCT_KEY && process.env.SCT_KEY.trim()) cfg.push.key = process.env.SCT_KEY.trim();
  if (cfg.push.key && cfg.push.key.trim()) cfg.push.enabled = true;
  return cfg;
}

// GitHub Actions 模式：每次被定时触发只跑一次就退出（RUN_ONCE=1）
if (process.env.RUN_ONCE === "1" || process.env.RUN_ONCE === "true") {
  (async () => {
    const cfg = bootstrap();
    const state = loadState();
    console.log(`[单次检查] 模式=${cfg.mode}，推送=${cfg.push.enabled ? "开" : "关"}`);
    try { await checkOnce(cfg, state); }
    catch (e) { console.error(`[${ts()}] 检查异常：`, e.message); }
    // 不论成功失败都正常退出，避免 Actions 把每次巡检标红
    process.exit(0);
  })();
} else {
  // 本地常驻模式：死循环定时检查
  (async () => {
    const cfg = bootstrap();
    const state = loadState();
    console.log(`金价监控已启动：每 ${INTERVAL_SEC} 秒检查一次，模式=${cfg.mode}，推送=${cfg.push.enabled ? "开" : "关"}`);
    try { await checkOnce(cfg, state); }
    catch (e) { console.error(`[${ts()}] 检查异常：`, e.message); }
    setInterval(async () => {
      try { await checkOnce(cfg, state); }
      catch (e) { console.error(`[${ts()}] 检查异常：`, e.message); }
    }, INTERVAL_SEC * 1000);
  })();
}
