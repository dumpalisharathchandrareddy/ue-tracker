// app.js — Uber Eats Discord Tracker (Multi-ticket, DB-first, Realtime Scrape + Ephemeral errors + Railway)
// -----------------------------------------------------------------------------
// REQUIRED ENV (.env or Railway variables)
//
// DISCORD_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
// DISCORD_APP_ID=1423195408041119829
// GUILD_ID=1405973995399942214
// THANK_BRAND=116 GAMER
// VOUCH_CHANNEL_ID=1405983244096372839
// NOTIFY_ROLE_ID=1405978891666849812
// STORE_EMOJI=🏬
//
// DB_PATH=/data/tracker.db        # use /data on Railway volume
// PORT=3000
// POLL_INTERVAL_MS=60000
// SCRAPE_DELAY_MS=2500
// THEME=classic                   # or modern
// DEBUG=1                         # optional
//
// Optional ops alerts:
// OWNER_USER_ID=123456789012345678
// DISCORD_LOG_CHANNEL_ID=123456789012345678
//
// -----------------------------------------------------------------------------
// Install:  npm i discord.js@14 puppeteer cheerio better-sqlite3 express dotenv
// Run:      node app.js
// -----------------------------------------------------------------------------

import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  MessageFlags,
} from 'discord.js';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import Database from 'better-sqlite3';

/* ─────────────── Config / utils ─────────────── */
const BRAND = process.env.THANK_BRAND || '116 GAMER';
const VOUCH_CHANNEL_ID = process.env.VOUCH_CHANNEL_ID || '1405983244096372839';
const STORE_EMOJI = process.env.STORE_EMOJI || '🏬';
const NOTIFY_ROLE_ID = process.env.NOTIFY_ROLE_ID || '1405978891666849812';

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60000);
const SCRAPE_DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 2500);
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH;
const THEME = (process.env.THEME || 'modern').toLowerCase();
const DEBUG = process.env.DEBUG === '1';

function log(...a) { console.log(...a); }
function dbg(...a) { if (DEBUG) console.log('[DEBUG]', ...a); }
function warn(...a) { console.warn(...a); }
function err(...a) { console.error(...a); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

/* ─────────────── Discord client ─────────────── */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // enable in dev portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});
function getGuildIconURL(guild) {
  try { return guild?.iconURL({ size: 128, extension: 'png' }) || null; } catch { return null; }
}

/* ─────────────── Ephemeral + ops helpers ─────────────── */
async function ephemeralTo(i, content) {
  try {
    if (!i.deferred && !i.replied) {
      return await i.reply({ content, flags: MessageFlags.Ephemeral });
    }
    return await i.followUp({ content, flags: MessageFlags.Ephemeral });
  } catch { /* interaction may have expired */ }
}
async function notifyOps(text) {
  try {
    if (process.env.DISCORD_LOG_CHANNEL_ID) {
      const ch = await client.channels.fetch(process.env.DISCORD_LOG_CHANNEL_ID).catch(() => null);
      if (ch?.isTextBased()) return ch.send(text).catch(() => {});
    }
    if (process.env.OWNER_USER_ID) {
      const u = await client.users.fetch(process.env.OWNER_USER_ID).catch(() => null);
      if (u) return u.send(text).catch(() => {});
    }
  } catch {}
}
async function dmRequester(userId, text) {
  try {
    if (!userId) return;
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;
    await user.send(text).catch(() => {});
  } catch {}
}

/* ─────────────── DB (SQLite, source of truth) ─────────────── */
if (!DB_PATH) {
  console.error('❌ DB_PATH is required (use /data/tracker.db on Railway).');
  process.exit(1);
}
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    assignee_user_id TEXT,
    requester_user_id TEXT,
    static_name TEXT,
    last_phase TEXT,
    last_hash TEXT,
    last_error_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_message ON jobs(message_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_channel ON jobs(channel_id);
  CREATE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
`);
const DB = {
  insert(job) {
    const now = nowIso();
    const stmt = db.prepare(`
      INSERT INTO jobs (url, guild_id, channel_id, message_id, assignee_user_id, requester_user_id, static_name, last_phase, last_hash, last_error_at, created_at, updated_at)
      VALUES (@url, @guild_id, @channel_id, @message_id, @assignee_user_id, @requester_user_id, @static_name, @last_phase, @last_hash, @last_error_at, @created_at, @updated_at)
    `);
    return stmt.run({ ...job, created_at: now, updated_at: now });
  },
  updateByMessageId(message_id, patch) {
    const now = nowIso();
    const keys = Object.keys(patch);
    if (!keys.length) return;
    const sets = keys.map(k => `${k}=@${k}`).join(', ');
    const stmt = db.prepare(`UPDATE jobs SET ${sets}, updated_at=@updated_at WHERE message_id=@message_id`);
    stmt.run({ ...patch, updated_at: now, message_id });
  },
  deleteByMessageId(message_id) {
    db.prepare('DELETE FROM jobs WHERE message_id = ?').run(message_id);
  },
  getAll() {
    return db.prepare('SELECT * FROM jobs').all();
  },
  getByMessageId(message_id) {
    return db.prepare('SELECT * FROM jobs WHERE message_id = ?').get(message_id);
  },
};

/* ─────────────── Puppeteer (Railway-friendly) ─────────────── */
let _browser = null;
async function getBrowser() {
  if (_browser) return _browser;
  const execPath = process.env.CHROME_PATH || undefined; // set in Dockerfile
  log('🟡 Launching Puppeteer…', execPath ? '(system chromium)' : '(bundled)');
  _browser = await puppeteer.launch({
    headless: 'new',
    executablePath: execPath, // Railway Docker uses system chromium
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--no-zygote', '--single-process',
    ],
  });
  log('✅ Puppeteer launched');
  return _browser;
}
async function prepPage(page) {
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const t = req.resourceType();
      if (t === 'image' || t === 'media' || t === 'font') req.abort();
      else req.continue();
    });
  } catch {}
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
}
async function newTrackedPage(browser) {
  const page = await browser.newPage();
  await prepPage(page);
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
  );
  return page;
}
async function gotoIfNeeded(page, url) {
  const cur = page.url();
  if (cur !== url) {
    dbg('NAV', { from: cur, to: url });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60_000 });
    await sleep(SCRAPE_DELAY_MS);
  } else {
    await sleep(Math.min(1000, SCRAPE_DELAY_MS));
  }
}

/* ─────────────── Helpers ─────────────── */
async function resolveChannelAssignee(channel, roleId) {
  try {
    const guild = channel.guild;
    if (!guild) return null;
    await guild.members.fetch({ withPresences: false }).catch(() => {});
    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role) return null;

    let candidates = role.members;
    if (typeof channel.isThread === 'function' && channel.isThread()) {
      const threadMembers = await channel.members.fetch().catch(() => null);
      const allowed = new Set(threadMembers?.map((m) => m.id) || []);
      candidates = candidates.filter((m) => allowed.has(m.id));
    } else {
      candidates = candidates.filter((m) =>
        channel.permissionsFor(m)?.has(PermissionsBitField.Flags.ViewChannel)
      );
    }
    if (candidates.size === 1) return candidates.first().id;
    return null;
  } catch {
    return null;
  }
}
function extractText($, el) {
  const t = $(el).text().replace(/\s+/g, ' ').trim();
  return t || null;
}
const sanitize = (val, max = 1024) => {
  if (!val) return null;
  let s = String(val)
    .replace(/\s+/g, ' ')
    .replace(/This website uses third party advertising cookies[\s\S]*$/i, '')
    .trim();
  if (!s) return null;
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
};
const sanitizeName = (v) => sanitize(v, 256);
const sanitizeValue = (v) => sanitize(v, 1024);

/* ─────────────── Scraping (Cheerio) ─────────────── */
function scrapeFromHTML(html) {
  const $ = cheerio.load(html);
  const textAll = $.root().text().replace(/\s+/g, ' ').trim();

  // STATUS + ETA
  let statusLine = null, etaLine = null, statusText = 'Unknown status';
  const sticky = $('[data-testid="active-order-sticky-eta"]').first();
  if (sticky.length) {
    const lines = sticky.find('div').map((_, d) => extractText($, d)).get().filter(Boolean);
    statusLine = lines[0] || null;
    etaLine = lines.find((t) => /estimated/i.test(t)) || null;
    statusText = [statusLine, etaLine].filter(Boolean).join(' ');
  }

  // STORE: "From <store>"
  let store = null;
  const fromNodes = $('div,span,p')
    .filter((_, el) => {
      const t = extractText($, el);
      return t && /^From\s+/.test(t) && t.length <= 80;
    })
    .map((_, el) => extractText($, el)).get();
  if (fromNodes.length) store = fromNodes[0].replace(/^From\s+/i, '').trim();

  // NAME from status line
  let name = null;
  const nm = (statusLine || statusText || '').match(/(?:preparing|picking up|heading)\s+(.+?)['’]s\s+(?:order|way)/i);
  if (nm) name = nm[1];

  // ADDRESS from container-0 only
  let address = null;
  const c0 = $('[data-testid="delivery-text-container-0"]').first();
  if (c0.length) {
    const leaves = c0.find('div').filter((_, d) => $(d).children().length === 0);
    const addrRx = /\d{2,6}[^,\n]+,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,\s*(US|USA))?/i;
    let hit = null;
    leaves.each((_, d) => {
      const t = extractText($, d);
      if (t && addrRx.test(t)) { hit = t; return false; }
    });
    if (hit) address = hit;
    else {
      const raw = extractText($, c0);
      const m = raw && raw.match(addrRx);
      if (m) address = m[0];
    }
  }

  // UNIT (apt/suite/floor)
  let unit = null;
  const c1 = $('[data-testid="delivery-text-container-1"]').first();
  if (c1.length) {
    const raw = extractText($, c1);
    const m = raw && raw.match(/(apt|apartment|suite|ste|floor|fl|unit|#)\s*[:\-]?\s*([A-Za-z0-9\- .#]+)$/i);
    if (m) {
      const label = m[1]; const value = m[2];
      unit = `${label.charAt(0).toUpperCase() + label.slice(1)}: ${value.trim()}`;
    } else {
      const leaves = c1.find('div').filter((_, d) => $(d).children().length === 0);
      leaves.each((_, d) => {
        const t = extractText($, d);
        if (t && /^(apt|apartment|suite|ste|floor|fl|unit|#)\b/i.test(t)) { unit = t; return false; }
      });
    }
  }

  // DELIVERY TYPE + NOTE (NOTE only from container-1)
  let delivery_type = null;
  let delivery_note_typed = null;

  const TYPE_RX = /(leave (?:it )?at (?:my )?door|hand it to me|meet (?:at )?(?:the |my )?door|meet outside|deliver (?:to|at) (?:my )?door)/i;
  const OPTION_RX = /\b(standard|priority|rush|asap|express|economy|saver)\b/i;
  const LABEL_RX = /^(address|delivery option|delivery options)$/i;
  const ADDR_RX = /\d{2,6}[^,\n]+,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?(?:,\s*(US|USA))?/i;
  const UNIT_HINT_RX = /^(apt|apartment|suite|ste|floor|fl|unit|#)\b/i;

  if (c1.length) {
    const leaves = c1.find('div').filter((_, d) => $(d).children().length === 0).get();
    for (let i = leaves.length - 1; i >= 0; i--) {
      const t = extractText($, leaves[i]);
      if (!t) continue;
      if (LABEL_RX.test(t)) continue;
      if (TYPE_RX.test(t)) continue;
      if (OPTION_RX.test(t)) continue;
      if (ADDR_RX.test(t)) continue;
      if (UNIT_HINT_RX.test(t)) continue;
      delivery_note_typed = t;
      break;
    }
  }
  const scanType = (sel) => {
    const cont = $(sel).first();
    if (!cont.length) return { type: null, opt: null };
    let typeLbl = null, optionLbl = null;
    cont.find('div').each((_, d) => {
      const t = extractText($, d); if (!t) return;
      if (!typeLbl && TYPE_RX.test(t)) { typeLbl = t.match(TYPE_RX)[0]; return; }
      if (!optionLbl && OPTION_RX.test(t)) {
        const m = t.match(OPTION_RX);
        if (m) optionLbl = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
      }
    });
    return { type: typeLbl, opt: optionLbl };
  };
  const t1 = scanType('[data-testid="delivery-text-container-1"]');
  const t2 = scanType('[data-testid="delivery-text-container-2"]');
  const typeLbl = t1.type || t2.type;
  const optLbl  = t1.opt  || t2.opt;
  delivery_type = [typeLbl, optLbl].filter(Boolean).join(' • ') || null;
  if (!delivery_type) {
    const mAny = textAll.match(TYPE_RX);
    if (mAny) delivery_type = mAny[0];
  }

  // CART
  const cartSel = '[data-testid="order-summary-card-item"], [data-testid*="order-summary-card-item"]';
  const cart = [];
  $(cartSel).each((_, item) => {
    const $item = $(item);
    const nameDiv = $item.find('div.bo.bp.bq.br').first();
    const name = extractText($, nameDiv.length ? nameDiv : item);
    const det  = extractText($, $item.find('div.bo.cn.bq.dq.g6, div.bo.cn.bq.dq.g7').first()) || '';
    const line = (det ? `${name} — ${det}` : name)?.replace(/\s{2,}/g, ' ').trim();
    if (line) cart.push(line);
  });

  // Delivered?
  let delivered = /\b(delivered|order arrived)\b/i.test(statusText);
  if (!delivered) {
    const enjoy = /Enjoy your order!/i.test(textAll);
    const thanks = /Thanks for using Uber Eats\./i.test(textAll);
    const backBtn = $('[data-testid="back-to-restaurants-primary-action"]').length > 0;
    if ((enjoy && thanks) || backBtn) delivered = true;
  }

  return {
    statusText,
    statusLine,
    etaLine,
    store,
    name,
    address,
    unit,
    delivery_type,
    delivery_note_typed,
    cart: cart.slice(0, 12),
    delivered,
  };
}
async function scrapeOrderPage(page, url) {
  const isDetachErr = (e) => e && /detached Frame/i.test(String(e.message || e));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await gotoIfNeeded(page, url);
      if (/auth\.uber\.com/i.test(page.url())) return { requiresLogin: true };
      await sleep(SCRAPE_DELAY_MS);
      const html = await page.content();
      return scrapeFromHTML(html);
    } catch (e) {
      if (isDetachErr(e) && attempt === 0) { await sleep(400); continue; }
      throw e;
    }
  }
  throw new Error('Unknown scrape error');
}

/* ─────────────── Phase / Embeds ─────────────── */
function classifyPhase(statusLineRaw = '') {
  const s = (statusLineRaw || '').toLowerCase();
  if (/received|preparing|confirm(ed|ing)?|waiting for the store|getting (the )?order ready/.test(s)) return 'PREPARING';
  if (/(heading .* way|on the way|head(?:ing)? your way)/i.test(s)) return 'HEADING';
  if (/(almost there|nearby|here|arriving)/i.test(s)) return 'ALMOST_HERE';
  if (/(delivered|order arrived)/i.test(s)) return 'DELIVERED';
  return null;
}
function buildActiveEmbed(data, link = null, { serverIconURL = null } = {}) {
  const fields = [];
  const top = sanitizeValue(data.statusLine || data.statusText || 'Unknown status');
  const eta = data.etaLine ? `\n*${sanitizeValue(data.etaLine)}*` : '';
  fields.push({ name: '⏳ Order Status', value: `${top}${eta}`.trim(), inline: false });

  const storeSafe = sanitizeValue(data.store);
  if (storeSafe) fields.push({ name: `${STORE_EMOJI} Store`, value: storeSafe, inline: true });

  const nameSafe = sanitizeValue(data.name);
  if (nameSafe) fields.push({ name: '👤 Name', value: nameSafe, inline: true });

  const typeSafe = sanitizeValue(data.delivery_type);
  if (typeSafe) fields.push({ name: 'ℹ️ Delivery Type', value: typeSafe, inline: true });

  const noteSafe = sanitizeValue(data.delivery_note_typed);
  if (noteSafe) fields.push({ name: '📝 Delivery Note', value: noteSafe, inline: true });

  if (data.address) {
    const addrBlock = data.unit ? `${data.address}\n${data.unit}` : data.address;
    const addrVal = sanitizeValue(addrBlock, 1000);
    if (addrVal) fields.push({ name: '📍 Delivery Address', value: '```' + addrVal + '```', inline: false });
  }

  if (data.cart?.length) {
    const items = data.cart
      .map((t) => sanitizeValue(t, 110)).filter(Boolean)
      .map((x) => '• ' + x).join('\n');
    if (items) fields.push({ name: THEME === 'classic' ? '🛒 Order Summary' : '🛒 Cart', value: items, inline: false });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle('✅ Tracking Information')
    .setURL(link || null)
    .addFields(fields)
    .setFooter({ text: `Updated by ${BRAND}` })
    .setTimestamp(new Date());

  if (serverIconURL) embed.setThumbnail(serverIconURL);
  return embed;
}
function buildDeliveredEmbed(data, link = null, { serverIconURL = null } = {}) {
  const thanks = `Thanks for ordering with **${BRAND}**! Hope you enjoyed your food and the experience.`;
  const vouch = `If you’re satisfied with your order, drop a vouch in <#${VOUCH_CHANNEL_ID}> for points towards a reward!`;
  const embed = new EmbedBuilder()
    .setColor(0x22aa66)
    .setTitle('✅ Order Arrived!')
    .setURL(link || null)
    .addFields(
      { name: '📦 Order Status', value: 'Enjoy your order!', inline: false },
      { name: '🙏 Thank You!', value: thanks, inline: false },
      { name: '📝 Leave a Vouch', value: vouch, inline: false },
    )
    .setFooter({ text: `Updated by ${BRAND}` })
    .setTimestamp(new Date());
  if (serverIconURL) embed.setThumbnail(serverIconURL);
  return embed;
}
const linkRow = (link, delivered = false) =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setStyle(ButtonStyle.Link)
      .setURL(link || 'https://www.ubereats.com/')
      .setLabel(delivered ? 'Order Link' : 'Track Order')
  );

/* ─────────────── Runtime maps ─────────────── */
const timers = new Map(); // message_id -> Timer
const pages  = new Map(); // message_id -> Puppeteer.Page
const states = new Map(); // message_id -> { lastPhase, staticName, assigneeUserId }

/* ─────────────── Discord message helpers ─────────────── */
async function fetchMessage(channelId, messageId) {
  try {
    const ch = await client.channels.fetch(channelId);
    if (!ch?.isTextBased()) return null;
    const msg = await ch.messages.fetch(messageId).catch(() => null);
    return msg || null;
  } catch { return null; }
}
function hashPayload(obj) { try { return JSON.stringify(obj); } catch { return Math.random().toString(); } }
async function safeEditOrRepost(jobRow, payload) {
  const { channel_id, message_id } = jobRow;
  let msg = await fetchMessage(channel_id, message_id);
  if (msg) {
    try { await msg.edit(payload); return msg; }
    catch (e) { if (e?.code !== 10008) throw e; } // Unknown Message => repost
  }
  // Repost
  const channel = await client.channels.fetch(channel_id);
  if (!channel?.isTextBased()) throw new Error('Cannot access channel to repost.');
  const newMsg = await channel.send(payload);
  // Update DB & move runtime keys
  DB.updateByMessageId(message_id, { message_id: newMsg.id });
  const t = timers.get(message_id); if (t) { timers.delete(message_id); timers.set(newMsg.id, t); }
  const p = pages.get(message_id);  if (p) { pages.delete(message_id);  pages.set(newMsg.id, p); }
  const st = states.get(message_id); if (st) { states.delete(message_id); states.set(newMsg.id, st); }
  return newMsg;
}

/* ─────────────── Core poll loop ─────────────── */
async function runOnceAndUpdate(messageId) {
  const job = DB.getByMessageId(messageId);
  if (!job) { clearInterval(timers.get(messageId)); timers.delete(messageId); return; }
  const page = pages.get(messageId);
  if (!page) return;

  try {
    let data;
    try {
      data = await scrapeOrderPage(page, job.url);
    } catch (e) {
      const m = String(e?.message || e);
      if (/detached Frame/i.test(m)) return; // transient SPA
      err('scrape error:', m);
      const tooSoon = job.last_error_at && Date.now() - new Date(job.last_error_at).getTime() < 5 * 60_000;
      if (!tooSoon) {
        await dmRequester(job.requester_user_id, `⚠️ Tracker had a scrape error for your order:\n\`${m}\``);
        DB.updateByMessageId(job.message_id, { last_error_at: nowIso() });
      }
      return;
    }

    if (data.requiresLogin) {
      await safeEditOrRepost(job, {
        content: '⚠️ This link appears to require login on Uber. Please provide a **public** tracking link.',
        embeds: [],
        components: [linkRow(job.url)],
      });
      await dmRequester(job.requester_user_id, '⚠️ Your Uber Eats link appears to require login. Please provide a **public** tracking link.');
      clearInterval(timers.get(messageId)); timers.delete(messageId);
      try { await page.close({ runBeforeUnload: true }); } catch {}
      pages.delete(messageId);
      DB.deleteByMessageId(messageId);
      states.delete(messageId);
      return;
    }

    // Name latch
    const st = states.get(messageId) || {};
    if (!st.staticName && data.name) st.staticName = data.name;
    if (st.staticName && !data.name) data.name = st.staticName;

    // Phase + delivered
    const phase = classifyPhase(data.statusLine || data.statusText) || st.lastPhase || null;
    const deliveredNow = !!data.delivered || phase === 'DELIVERED';

    // Single-member role ping on phase changes only
    if (st.assigneeUserId) {
      const ch = await client.channels.fetch(job.channel_id);
      if (!st.lastPhase && phase) {
        const label = phase === 'PREPARING' ? 'Preparing'
          : phase === 'HEADING' ? 'Heading your way'
          : phase === 'ALMOST_HERE' ? 'Almost here'
          : 'Delivered';
        await ch.send({
          content: `<@${st.assigneeUserId}> **Started tracking: ${label}**${data.etaLine ? ` — *${data.etaLine}*` : ''}`,
          allowedMentions: { users: [st.assigneeUserId], parse: [] },
        }).catch(() => {});
      } else if (phase && st.lastPhase && phase !== st.lastPhase) {
        const label = phase === 'PREPARING' ? 'Preparing'
          : phase === 'HEADING' ? 'Heading your way'
          : phase === 'ALMOST_HERE' ? 'Almost here'
          : 'Delivered';
        await ch.send({
          content: `<@${st.assigneeUserId}> **Status Update:** ${label}${data.etaLine ? ` — *${data.etaLine}*` : ''}`,
          allowedMentions: { users: [st.assigneeUserId], parse: [] },
        }).catch(() => {});
      }
    }
    st.lastPhase = phase;

    // Build embed
    const guild = await client.guilds.fetch(job.guild_id);
    const serverIconURL = getGuildIconURL(guild);
    const payload = deliveredNow
      ? { content: '', embeds: [buildDeliveredEmbed(data, job.url, { serverIconURL })], components: [linkRow(job.url, true)] }
      : { content: '', embeds: [buildActiveEmbed(data, job.url, { serverIconURL })],   components: [linkRow(job.url, false)] };

    // Edit only on change
    const h = hashPayload(payload);
    if (h !== job.last_hash) {
      await safeEditOrRepost(job, payload);
      DB.updateByMessageId(job.message_id, {
        last_hash: h, last_phase: st.lastPhase, static_name: st.staticName || null, last_error_at: null
      });
    }

    // Delivered → finalize
    if (deliveredNow) {
      if (st.assigneeUserId) {
        const channel = await client.channels.fetch(job.channel_id);
        await channel.send({
          content: `<@${st.assigneeUserId}> ✅ **Order Arrived!** Enjoy your order!`,
          allowedMentions: { users: [st.assigneeUserId], parse: [] },
        }).catch(() => {});
      }
      clearInterval(timers.get(messageId)); timers.delete(messageId);
      try { await page.close({ runBeforeUnload: true }); } catch {}
      pages.delete(messageId);
      DB.deleteByMessageId(job.message_id);
      states.delete(messageId);
    } else {
      states.set(job.message_id, st);
    }
  } catch (e) {
    const m = String(e?.message || e);
    err('runOnceAndUpdate error:', m);
    notifyOps('⚠️ runOnceAndUpdate: ' + m);
  }
}

/* ─────────────── Start & Resume ─────────────── */
async function startJob(channel, url, requesterUserId) {
  const browser = await getBrowser();
  const page = await newTrackedPage(browser);

  const assigneeUserId = await resolveChannelAssignee(channel, NOTIFY_ROLE_ID);

  // Initial message
  const msg = await channel.send({
    embeds: [buildActiveEmbed({ statusLine: 'Starting…' }, url, { serverIconURL: getGuildIconURL(channel.guild) })],
    components: [linkRow(url)],
  });

  // Persist
  DB.insert({
    url,
    guild_id: channel.guild.id,
    channel_id: channel.id,
    message_id: msg.id,
    assignee_user_id: assigneeUserId || null,
    requester_user_id: requesterUserId || null,
    static_name: null,
    last_phase: null,
    last_hash: null,
    last_error_at: null,
  });

  // Runtime
  pages.set(msg.id, page);
  states.set(msg.id, { assigneeUserId, staticName: null, lastPhase: null });

  await runOnceAndUpdate(msg.id);
  const timer = setInterval(() => runOnceAndUpdate(msg.id), POLL_INTERVAL_MS);
  timers.set(msg.id, timer);

  return msg;
}
async function resumeAllFromDB() {
  const all = DB.getAll();
  if (!all.length) { log('↩️  No jobs to resume'); return; }
  log(`🔁 Resuming ${all.length} job(s) from DB…`);
  const browser = await getBrowser();

  for (const row of all) {
    try {
      const channel = await client.channels.fetch(row.channel_id).catch(() => null);
      if (!channel?.isTextBased()) { DB.deleteByMessageId(row.message_id); continue; }

      let msg = await channel.messages.fetch(row.message_id).catch(() => null);
      if (!msg) {
        msg = await channel.send({
          embeds: [buildActiveEmbed({ statusLine: 'Resuming…' }, row.url, { serverIconURL: getGuildIconURL(channel.guild) })],
          components: [linkRow(row.url)],
        });
        DB.updateByMessageId(row.message_id, { message_id: msg.id });
        row.message_id = msg.id;
      } else {
        await msg.edit({
          embeds: [buildActiveEmbed({ statusLine: 'Resuming…' }, row.url, { serverIconURL: getGuildIconURL(channel.guild) })],
          components: [linkRow(row.url)],
        }).catch(() => {});
      }

      const page = await newTrackedPage(browser);
      pages.set(row.message_id, page);
      states.set(row.message_id, {
        assigneeUserId: row.assignee_user_id || null,
        staticName: row.static_name || null,
        lastPhase: row.last_phase || null,
      });

      await runOnceAndUpdate(row.message_id);
      const timer = setInterval(() => runOnceAndUpdate(row.message_id), POLL_INTERVAL_MS);
      timers.set(row.message_id, timer);
    } catch (e) {
      err('resume error:', e?.message || e);
    }
  }
}

/* ─────────────── Commands ─────────────── */
const commands = [
  new SlashCommandBuilder()
    .setName('track')
    .setDescription('Track an Uber Eats PUBLIC order page in this channel.')
    .addStringOption(o => o.setName('url').setDescription('Public Uber Eats order URL').setRequired(true))
    .toJSON(),
];
async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  const appId = process.env.DISCORD_APP_ID;
  const guildId = process.env.GUILD_ID;
  if (!appId) throw new Error('Missing DISCORD_APP_ID');
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: commands });
    log('✅ Slash commands registered (guild)');
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: commands });
    log('✅ Slash commands registered (global)');
  }
}
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    if (i.commandName !== 'track') return;

    const url = i.options.getString('url', true).trim();

    // Validate URL early
    if (!/^https?:\/\/(www\.)?ubereats\.com\/orders\//i.test(url)) {
      return ephemeralTo(i, '❌ Please provide a **public Uber Eats order link** like `https://www.ubereats.com/orders/...`');
    }

    await ephemeralTo(i, 'Starting tracker…');

    try {
      await startJob(i.channel, url, i.user.id);
    } catch (e) {
      await ephemeralTo(i, `❌ Could not start tracker: \`${String(e?.message || e)}\``);
      return;
    }

    await ephemeralTo(i, `✅ Started tracking: \`${url.split('/').pop()}\``);
  } catch (e) {
    await ephemeralTo(i, `❌ Error: \`${String(e?.message || e)}\``);
  }
});

/* ─────────────── HTTP / Boot / Restartable ─────────────── */
if (PORT) {
  const app = express();
  app.get('/health', (_req, res) => res.json({ ok: true, now: nowIso(), pid: process.pid }));
  app.listen(PORT, () => log(`🌐 HTTP on :${PORT}`));
}
process.on('unhandledRejection', (e) => {
  const msg = 'UNHANDLED REJECTION: ' + String(e?.stack || e);
  err(msg); notifyOps('⚠️ ' + msg);
});
process.on('uncaughtException',  (e) => {
  const msg = 'UNCAUGHT EXCEPTION: ' + String(e?.stack || e);
  err(msg); notifyOps('⚠️ ' + msg);
});

log('🚀 Boot', {
  node: process.version,
  DEBUG, GUILD_ID: process.env.GUILD_ID, APP_ID: process.env.DISCORD_APP_ID,
  PORT, POLL_INTERVAL_MS, DB_PATH, THEME, SCRAPE_DELAY_MS,
});

await (async () => {
  try { await registerCommands(); }
  catch (e) { err('registerCommands failed:', e); notifyOps('❌ registerCommands failed: ' + String(e?.message || e)); }
  try { await client.login(process.env.DISCORD_TOKEN); }
  catch (e) { err('client.login failed:', e); notifyOps('❌ client.login failed: ' + String(e?.message || e)); process.exit(1); }
})();

client.once('clientReady', async () => {
  log(`✅ Discord clientReady as ${client.user.tag}`);
  await resumeAllFromDB();
});
client.once('ready', async () => {
  log(`✅ Discord ready as ${client.user.tag}`);
});
process.on('SIGINT', async () => {
  log('Shutting down…');
  try {
    for (const [, t] of timers) clearInterval(t);
    timers.clear();
    for (const [, p] of pages) { try { await p.close({ runBeforeUnload: true }); } catch {} }
    pages.clear();
    if (_browser) await _browser.close();
  } finally { process.exit(0); }
});
