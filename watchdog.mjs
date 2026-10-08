// Сторож и ретранслятор алертов Pink Rivers — запускается в GitHub Actions раз в 5 минут
// (публичный репо arseniy2003/pink-rivers-watchdog; исходник — infra/watchdog в основном репо).
// Работает ВНЕ России и вне Yandex Cloud: Telegram отсюда не блокируется, а авария облака не мешает
// сообщить о ней. plans/2026-10-08-телеграм-алерты.md.
//
// За один запуск:
//  1. проверяет сайт снаружи (/api/v1/health и /): упал → «🔴», лежит → напоминание раз в час,
//     поднялся → «🟢 простой N мин»; раз в сутки — срок TLS-сертификата;
//  2. дочищает очередь outbox/ в бакете Yandex: туда api кладёт алерты, если Telegram из РФ не ответил;
//  3. раз в неделю (пн, 09:00 МСК) — «сторож на посту», чтобы молчание бота не путали с тишиной.
// Состояние — .state/state.json (между запусками переносится кэшем Actions; сохраняется при изменении).
// ⚠️ Репозиторий публичный, логи открыты: в лог — только счётчики и статусы, без текстов и chat id.
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import tls from "node:tls";

const TARGET = (process.env.TARGET_URL || "https://pink-rivers.ru").replace(/\/$/, "");
const HOST = new URL(TARGET).host;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_IDS = (process.env.TELEGRAM_CHAT_IDS || "").split(/[\s,]+/).filter(Boolean);
const OUTBOX_BUCKET = process.env.OUTBOX_BUCKET || "";
const S3_ENDPOINT = "https://storage.yandexcloud.net";

const STATE_DIR = ".state";
const STATE_FILE = `${STATE_DIR}/state.json`;
const PROBE_TIMEOUT_MS = 15_000;
const RECHECK_DELAY_MS = 30_000; // вторая попытка — разовый сбой сети не будит команду
const REMIND_EVERY_MS = 60 * 60_000;
const CERT_CHECK_EVERY_MS = 24 * 3_600_000;
const CERT_WARN_DAYS = 10; // Caddy продлевает сам задолго до этого — 10 дней = продление сломалось
const OUTBOX_MAX_PER_RUN = 20;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmtMinutes = (min) => (min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`);
const mskTime = (iso) =>
  new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });

// ---------- Telegram ----------
async function sendTo(chatId, text) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(15_000),
      });
      if (r.ok) return true;
      const body = await r.json().catch(() => ({}));
      if (r.status === 429 && body?.parameters?.retry_after) {
        await sleep((body.parameters.retry_after + 1) * 1000);
        continue;
      }
      console.log(`telegram: HTTP ${r.status}`);
      return false;
    } catch (e) {
      console.log(`telegram: ${e?.name || "error"}`);
    }
  }
  return false;
}

/** Всем получателям; true — дошло хотя бы до одного (иначе повторим на следующем запуске). */
async function telegram(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) return false;
  const results = [];
  for (const id of CHAT_IDS) results.push(await sendTo(id, text));
  return results.some(Boolean);
}

// ---------- проверка сайта ----------
async function probe(name, url) {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { "user-agent": "pink-rivers-watchdog/2" },
    });
    await r.arrayBuffer().catch(() => undefined);
    return { name, ok: r.status >= 200 && r.status < 400, detail: `HTTP ${r.status}` };
  } catch (e) {
    const code = e?.cause?.code || e?.name || "error";
    return { name, ok: false, detail: code === "TimeoutError" ? `нет ответа за ${PROBE_TIMEOUT_MS / 1000} с` : code };
  }
}

async function checkSite() {
  const run = () => Promise.all([probe("api", `${TARGET}/api/v1/health`), probe("сайт", `${TARGET}/`)]);
  let res = await run();
  if (res.some((r) => !r.ok)) {
    await sleep(RECHECK_DELAY_MS);
    res = await run();
  }
  return res;
}

function certDaysLeft(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host, port: 443, servername: host, timeout: PROBE_TIMEOUT_MS }, () => {
      const cert = sock.getPeerCertificate();
      sock.end();
      resolve(cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : null);
    });
    sock.on("error", () => resolve(null));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(null);
    });
  });
}

async function watchSite(st, now) {
  const res = await checkSite();
  const bad = res.filter((r) => !r.ok);
  if (bad.length > 0) {
    const problem = bad.map((r) => `${r.name}: ${r.detail}`).join("\n");
    if (!st.down) {
      st.down = true;
      st.downSince = now;
      st.lastAlertAt = 0;
    }
    const mins = Math.round((now - st.downSince) / 60_000);
    if (!st.lastAlertAt) {
      if (await telegram(`🔴 <b>${esc(HOST)} недоступен</b>\n${esc(problem)}`)) st.lastAlertAt = now;
    } else if (now - st.lastAlertAt >= REMIND_EVERY_MS) {
      const text = `🔴 <b>${esc(HOST)} всё ещё недоступен</b> (${fmtMinutes(mins)})\n${esc(problem)}`;
      if (await telegram(text)) st.lastAlertAt = now;
    }
  } else if (st.down) {
    // Простой считаем от первой неудачной проверки (+ до 5 мин между запусками — оценка «~»).
    const mins = Math.max(1, Math.round((now - st.downSince) / 60_000));
    if (await telegram(`🟢 <b>${esc(HOST)} снова работает</b>\nпростой ~${fmtMinutes(mins)}`)) {
      st.down = false;
      delete st.downSince;
      delete st.lastAlertAt;
    }
  }

  if (!st.down && now - (st.certCheckedAt || 0) >= CERT_CHECK_EVERY_MS) {
    const days = await certDaysLeft(HOST);
    if (days !== null) {
      st.certCheckedAt = now;
      if (days < CERT_WARN_DAYS && now - (st.certAlertAt || 0) >= 86_400_000) {
        const text = `🟡 <b>${esc(HOST)}: TLS-сертификат истекает через ${days} дн.</b>\nCaddy не продлил его сам — проверить логи caddy на ВМ`;
        if (await telegram(text)) st.certAlertAt = now;
      }
    }
  }
  return res.map((r) => `${r.name}=${r.ok ? "ok" : "FAIL"}`).join(" ");
}

// ---------- очередь алертов из РФ (outbox/ в Object Storage) ----------
function aws(args, input) {
  return execFileSync("aws", [...args, "--endpoint-url", S3_ENDPOINT], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, AWS_DEFAULT_REGION: "ru-central1", AWS_PAGER: "" },
  });
}

async function drainOutbox() {
  if (!OUTBOX_BUCKET || !process.env.AWS_ACCESS_KEY_ID) return "outbox=off";
  let keys;
  try {
    const out = aws(["s3api", "list-objects-v2", "--bucket", OUTBOX_BUCKET, "--prefix", "outbox/", "--max-items", String(OUTBOX_MAX_PER_RUN), "--output", "json"]);
    keys = (JSON.parse(out || "{}").Contents || []).map((o) => o.Key).sort();
  } catch {
    return "outbox=unreachable"; // Yandex недоступен — api тоже, а падение сайта ловит проверка выше
  }
  let sent = 0;
  for (const key of keys) {
    try {
      const item = JSON.parse(aws(["s3", "cp", `s3://${OUTBOX_BUCKET}/${key}`, "-"]));
      const footer = `\n<i>через ретранслятор (Telegram из РФ недоступен), создано ${esc(mskTime(item.createdAt))} МСК</i>`;
      if (!(await telegram(`${item.text}${footer}`))) break; // Telegram не ответил — оставим на следующий запуск
      aws(["s3", "rm", `s3://${OUTBOX_BUCKET}/${key}`]);
      sent += 1;
      await sleep(1_100); // ~1 сообщение/с в чат — лимит Telegram
    } catch {
      // битый объект не должен навсегда застопорить очередь — удаляем
      try {
        aws(["s3", "rm", `s3://${OUTBOX_BUCKET}/${key}`]);
      } catch {
        /* следующий запуск */
      }
    }
  }
  return `outbox=${sent}/${keys.length}`;
}

// ---------- еженедельный «я на посту» ----------
async function heartbeat(st, now) {
  const d = new Date(now);
  const week = `${d.getUTCFullYear()}-${Math.floor((now / 86_400_000 + 3) / 7)}`;
  // понедельник, 06:00–06:59 UTC = 09:00 МСК
  if (d.getUTCDay() !== 1 || d.getUTCHours() !== 6 || st.heartbeatWeek === week) return;
  const status = st.down ? "🔴 сайт сейчас недоступен" : "сайт доступен";
  if (await telegram(`🔵 <b>${esc(HOST)}: сторож на посту</b>\n${status}. Проверка раз в 5 минут.`)) st.heartbeatWeek = week;
}

// ---------- main ----------
let st = {};
try {
  st = JSON.parse(readFileSync(STATE_FILE, "utf8"));
} catch {
  /* первый запуск или кэш вытеснен */
}
const before = JSON.stringify(st);
const now = Date.now();

const site = await watchSite(st, now);
const outbox = await drainOutbox();
await heartbeat(st, now);

const changed = JSON.stringify(st) !== before;
if (changed) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(st));
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
console.log(`${site} ${outbox} down=${Boolean(st.down)} changed=${changed}`);
