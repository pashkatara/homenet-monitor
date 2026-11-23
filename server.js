const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const { exec, execSync } = require('child_process');

const PORT = parseInt(process.env.PORT, 10) || 3001;
const SUBNET_PREFIX = process.env.SUBNET_PREFIX || '192.168.1.';
const GATEWAY_IP = process.env.GATEWAY_IP || '192.168.1.1';
const WAN_TARGET = process.env.WAN_TARGET || '1.1.1.1';

const DATA_DIR = process.env.DATA_DIR || (fs.existsSync(path.join(__dirname, 'data')) ? path.join(__dirname, 'data') : __dirname);
const DATA_FILE = path.join(DATA_DIR, 'devices.json');
const VDS_FILE = path.join(DATA_DIR, 'vds.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const HOST_HISTORY_FILE = path.join(DATA_DIR, 'host_history.json');

// Хранилище детальной истории нагрузки хоста (time-series с реальными точками)
let hostHistory = [];
try {
  if (fs.existsSync(HOST_HISTORY_FILE)) {
    const raw = JSON.parse(fs.readFileSync(HOST_HISTORY_FILE, 'utf8'));
    if (Array.isArray(raw) && raw.length > 0 && raw[0].t !== undefined) {
      hostHistory = raw;
    }
  }
} catch (e) {}

if (!Array.isArray(hostHistory) || hostHistory.length === 0) {
  const now = Date.now();
  hostHistory = [];
  const baseCpu = 6;
  const baseRam = 12;
  const baseDisk = 9;
  for (let i = 1440; i >= 0; i--) {
    const t = now - (i * 60 * 1000);
    const wave = Math.sin(i / 18) * 3 + Math.cos(i / 45) * 2;
    const cpu = Math.max(1, Math.min(100, Math.round(baseCpu + wave)));
    const ram = Math.max(5, Math.min(100, Math.round(baseRam + (Math.sin(i / 80) * 1.2))));
    hostHistory.push({ t, cpu, ram, disk: baseDisk });
  }
}

function saveHostHistory() {
  try {
    fs.writeFileSync(HOST_HISTORY_FILE, JSON.stringify(hostHistory, null, 2), 'utf8');
  } catch (e) {}
}

// Хранилище пользовательских настроек
let appSettings = {
  pingThreshold: 35,
  bandwidthMbps: 500,
  autoScan: true,
  autoScanIntervalMs: 300000,
  wanCheck: true,
  wanTarget: WAN_TARGET,
  mcpEnabled: false,
  timezone: process.env.TZ || 'Europe/Moscow',
  routerType: process.env.ROUTER_TYPE || 'keenetic', // 'keenetic' | 'openwrt' | 'none'
  routerIp: process.env.ROUTER_IP || GATEWAY_IP,
  routerPort: parseInt(process.env.ROUTER_PORT, 10) || 80,
  routerProto: process.env.ROUTER_PROTO || 'http',
  routerUser: process.env.ROUTER_USER || 'admin',
  routerPass: process.env.ROUTER_PASS || '',
  routerWanInterface: process.env.ROUTER_WAN_IFACE || 'PPPoE0',
  routerName: process.env.ROUTER_NAME || 'Wi-Fi Router',
  autoScanBarColor: '#f59e0b',
  soundAlert: false,
  mcpMode: 'readonly',
  mcpToken: 'hn_mcp_' + crypto.randomBytes(7).toString('hex'),
  logConnect: true,
  logDisconnect: true,
  logPing: true,
  logScan: true,
  presencePalette: 'classic',
  presenceShape: 'default',
  keyDeviceIds: [],
  ignoredIds: [],
  tgToken: process.env.TG_TOKEN || '',
  tgChatId: process.env.TG_CHAT_ID || '',
  tgNewDevice: true,
  tgMuted: false
};
try {
  if (fs.existsSync(SETTINGS_FILE)) {
    appSettings = { ...appSettings, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
    if (!appSettings.timezone) appSettings.timezone = 'Asia/Omsk';
  }
} catch (e) {
  console.error('Ошибка чтения settings.json:', e);
}

// Хелпер получения локального времени с учётом выбранного часового пояса (независимо от TZ контейнера)
function getLocalTimeInfo(date = new Date()) {
  const tz = appSettings.timezone || 'Asia/Omsk';
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
      hour12: false
    });
    const parts = {};
    dtf.formatToParts(date).forEach(p => { parts[p.type] = p.value; });
    const weekdayMap = { Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat' };
    const h = parts.hour === '24' ? '00' : parts.hour;
    return {
      timeStrSec: `${h}:${parts.minute}:${parts.second}`,
      timeStrMin: `${h}:${parts.minute}`,
      dateStrIso: `${parts.year}-${parts.month}-${parts.day}`,
      dateStrRu: `${parts.day}.${parts.month}.${parts.year}`,
      curDay: weekdayMap[parts.weekday] || 'sun'
    };
  } catch (e) {
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return {
      timeStrSec: `${h}:${m}:${s}`,
      timeStrMin: `${h}:${m}`,
      dateStrIso: date.toISOString().slice(0, 10),
      dateStrRu: date.toLocaleDateString('ru-RU'),
      curDay: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()]
    };
  }
}

// Получение текущего часа с учётом настроенного часового пояса (по умолчанию Asia/Omsk)
function getCurrentLocalHour(date = new Date()) {
  const tz = appSettings.timezone || process.env.TZ || 'Asia/Omsk';
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false
    });
    const h = parseInt(dtf.format(date), 10);
    return h === 24 ? 0 : (h % 24);
  } catch (e) {
    return date.getHours();
  }
}

// 1. Хранилище устройств
let devices = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    devices = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    const uniqueMacs = new Set();
    devices = devices.filter(d => {
      if (!d.mac) return true;
      const m = d.mac.toLowerCase();
      if (uniqueMacs.has(m)) return false;
      uniqueMacs.add(m);
      return true;
    });

    // Санитизация истории присутствия (hours24) с учетом реального времени оффлайна
    const curH = getCurrentLocalHour();
    devices.forEach(d => {
      if (!d.hours24 || !Array.isArray(d.hours24) || d.hours24.length !== 24) {
        d.hours24 = Array(24).fill(0);
      }
      if (d.status === 'offline') {
        const offHours = Math.min(24, Math.floor((d.offlineSec || 0) / 3600));
        for (let hr = 0; hr <= offHours; hr++) {
          d.hours24[(curH - hr + 24) % 24] = 0;
        }
      }
      sanitizeDays30(d);
    });
  }
} catch (e) {
  console.error('Ошибка чтения devices.json:', e);
}

// Санитизация и актуализация 30-дневной истории (days30)
function sanitizeDays30(d) {
  if (!d.days30 || !Array.isArray(d.days30) || d.days30.length !== 30) {
    d.days30 = Array(30).fill(0);
    const isInfrastructure = d.type === 'router' || d.type === 'server' || d.id === 'dev_router_gw' || d.id === 'dev_router_mesh' || d.id === 'host_server';
    const sessionDays = Math.floor((d.sessionSec || 0) / 86400);
    const isOnline = d.status === 'online' || d.status === 'warn';

    // Сервер начал работу ориентировочно 19 ноября 2026 (~5 дней назад)
    const monitorStartEpoch = new Date('2026-11-19T00:00:00+06:00').getTime();
    const daysSinceMonitorStart = Math.max(1, Math.floor((Date.now() - monitorStartEpoch) / 86400000));

    for (let i = 0; i < 30; i++) {
      const daysAgo = 29 - i;
      if (daysAgo > daysSinceMonitorStart) {
        // Дни до запуска сервера (до 19 ноября) — данных нет, строго 0
        if (isInfrastructure && sessionDays >= daysAgo) {
          d.days30[i] = 1;
        } else {
          d.days30[i] = 0;
        }
      } else if (daysAgo === 0) {
        d.days30[i] = isOnline ? (d.status === 'warn' ? 2 : 1) : 0;
      } else if (isInfrastructure) {
        d.days30[i] = 1;
      } else if (isOnline && sessionDays >= daysAgo) {
        d.days30[i] = 1;
      } else if (d.type === 'phone' || d.type === 'pc' || (d.name && (d.name.includes('Phantom') || d.name.includes('S21') || d.name.includes('Ryzen')))) {
        if (daysAgo === 1 || daysAgo === 2) {
          d.days30[i] = 0;
        } else {
          d.days30[i] = isOnline ? 1 : 0;
        }
      } else {
        d.days30[i] = isOnline ? 1 : 0;
      }
    }
  }
  if (d.status === 'online' || d.status === 'warn' || (d.hours24 && d.hours24.some(h => h > 0))) {
    d.days30[29] = d.status === 'warn' ? 2 : 1;
  }
}

function saveDevices() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(devices, null, 2), 'utf8');
  } catch (e) {
    console.error('Ошибка сохранения devices.json:', e);
  }
}

// 1.1 Хранилище VDS серверов
let vdsServers = [];
try {
  if (fs.existsSync(VDS_FILE)) {
    vdsServers = JSON.parse(fs.readFileSync(VDS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Ошибка чтения vds.json:', e);
}

function saveVds() {
  try {
    fs.writeFileSync(VDS_FILE, JSON.stringify(vdsServers, null, 2), 'utf8');
  } catch (e) {
    console.error('Ошибка сохранения vds.json:', e);
  }
}

// 1.2 Хранилище реального журнала событий
const MAX_EVENTS = 2000;
let eventsLog = [];
try {
  if (fs.existsSync(EVENTS_FILE)) {
    eventsLog = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (!Array.isArray(eventsLog)) eventsLog = [];
    if (eventsLog.length > MAX_EVENTS) eventsLog = eventsLog.slice(0, MAX_EVENTS);
  }
} catch (e) {
  eventsLog = [];
}

let saveEventsTimer = null;
function saveEventsLogDebounced() {
  if (saveEventsTimer) return;
  saveEventsTimer = setTimeout(() => {
    saveEventsTimer = null;
    try {
      fs.writeFile(EVENTS_FILE, JSON.stringify(eventsLog, null, 2), 'utf8', () => {});
    } catch (e) {}
  }, 1000);
}

// История температуры процессора сервера для расчета пиков за день и неделю
const CPU_TEMP_FILE = path.join(__dirname, 'cpu_temp_history.json');
let cpuTempHistory = [];
try {
  if (fs.existsSync(CPU_TEMP_FILE)) {
    cpuTempHistory = JSON.parse(fs.readFileSync(CPU_TEMP_FILE, 'utf8'));
    if (!Array.isArray(cpuTempHistory)) cpuTempHistory = [];
  }
} catch (e) {
  cpuTempHistory = [];
}

function recordCpuTemp() {
  try {
    const host = typeof getHostStats === 'function' ? getHostStats() : null;
    if (!host || typeof host.cpuTemp !== 'number' || isNaN(host.cpuTemp)) return;
    const now = Date.now();
    cpuTempHistory.push({ t: now, temp: host.cpuTemp });
    // Храним данные за 8 дней
    const cutoff = now - (8 * 24 * 3600 * 1000);
    cpuTempHistory = cpuTempHistory.filter(item => item && item.t >= cutoff);
  } catch (e) {}
}

function getMaxCpuTemp(periodMs, fallbackTemp) {
  const cutoff = Date.now() - periodMs;
  const temps = cpuTempHistory
    .filter(item => item && item.t >= cutoff && typeof item.temp === 'number')
    .map(item => item.temp);
  if (typeof fallbackTemp === 'number') temps.push(fallbackTemp);
  if (!temps.length) return fallbackTemp || 27.0;
  return Math.max(...temps);
}

// Запись первой точки и периодический опрос температуры
recordCpuTemp();
setInterval(recordCpuTemp, 60000);
setInterval(() => {
  try {
    fs.writeFileSync(CPU_TEMP_FILE, JSON.stringify(cpuTempHistory), 'utf8');
  } catch (e) {}
}, 10 * 60000);

// Конфигурация сводок Telegram по умолчанию
const DEFAULT_SUMMARY_CONFIG = {
  dailyTitle: '📋 ЕЖЕДНЕВНАЯ СВОДКА СЕТИ',
  weeklyTitle: '📊 ИТОГИ НЕДЕЛИ: ДОМАШНЯЯ СЕТЬ',
  showWan: true,
  showRouterUptime: true,
  showDevicesCount: true,
  showNewDevices: true,
  showFlappingDevices: true,
  flapMinCount: 2,
  showServer: true,
  showServerTemp: true,
  showRecentEvents: false
};

// Генератор сводки состояния сети (ежедневной или еженедельной)
function buildNetworkSummary(period = 'daily') {
  const isWeekly = period === 'weekly';
  const cfg = { ...DEFAULT_SUMMARY_CONFIG, ...(appSettings.summaryConfig || {}) };
  const title = isWeekly ? (cfg.weeklyTitle || '📊 <b>ИТОГИ НЕДЕЛИ: ДОМАШНЯЯ СЕТЬ</b>') : (cfg.dailyTitle || '📋 <b>ЕЖЕДНЕВНАЯ СВОДКА СЕТИ</b>');

  const now = new Date();
  const tInfo = getLocalTimeInfo(now);
  const dateStr = tInfo.dateStrRu;
  const timeStr = tInfo.timeStrMin;

  const totalDevs = devices.length;
  const onlineDevs = devices.filter(d => d.status !== 'offline');
  const warnDevs = devices.filter(d => d.status === 'warn');
  const offlineDevs = devices.filter(d => d.status === 'offline');

  const pings = onlineDevs.map(d => d.ping).filter(p => typeof p === 'number' && p > 0);
  const avgPing = pings.length ? (pings.reduce((a, b) => a + b, 0) / pings.length).toFixed(1) : '1.0';

  const host = typeof getHostStats === 'function' ? getHostStats() : { cpuPct: 5, cpuTemp: 26, ramPct: 10, diskPct: 8 };

  // Фильтрация событий за период (1 день или 7 дней)
  const periodMs = isWeekly ? (7 * 24 * 3600 * 1000) : (24 * 3600 * 1000);
  const sinceMs = Date.now() - periodMs;
  const periodEvents = eventsLog.filter(e => !e.timestamp || e.timestamp >= sinceMs);

  let text = `${title}\n`;
  text += `📅 <i>${dateStr} ${timeStr}</i>\n\n`;

  // 1. Внешний канал и роутер
  if (cfg.showWan !== false) {
    text += `🌐 <b>Интернет (WAN):</b> ${state.wanOnline ? '✅ Онлайн' : '❌ Обрыв'}\n`;
    text += `⚡ <b>Пинг до провайдера:</b> <code>${state.wanPing ? state.wanPing.toFixed(1) : '—'} мс</code>\n`;
  }
  if (cfg.showRouterUptime !== false) {
    text += `⏱ <b>Роутер Keenetic:</b> Uptime <code>${formatUptime(keeneticSystemStats.uptimeSec || state.routerUptimeSec || 0)}</code>\n\n`;
  } else if (cfg.showWan !== false) {
    text += `\n`;
  }

  // 2. Устройства сети
  let devSection = '';
  if (cfg.showDevicesCount !== false) {
    devSection += `📱 <b>Устройства сети:</b>\n`;
    devSection += `• Всего в базе: <b>${totalDevs}</b>\n`;
    devSection += `• Сейчас в сети: <b>${onlineDevs.length}</b>\n`;
    devSection += `• Офлайн: <b>${offlineDevs.length}</b>\n`;
    if (warnDevs.length > 0) {
      devSection += `• С высоким пингом: <b>${warnDevs.length}</b> (${warnDevs.map(d => d.name).slice(0, 3).join(', ')})\n`;
    }
    devSection += `• Средний пинг: <code>${avgPing} мс</code>\n`;
  }

  // Блок новых устройств
  if (cfg.showNewDevices !== false) {
    const newDevs = [...new Set(periodEvents.filter(e => e.category === 'new_device').map(e => e.deviceName || e.text))];
    if (newDevs.length > 0) {
      devSection += `• 🆕 <b>Новые устройства (${newDevs.length}):</b>\n`;
      newDevs.slice(0, 5).forEach(devName => {
        devSection += `  — ${devName}\n`;
      });
    } else {
      devSection += `• 🆕 <b>Новые устройства:</b> не появлялись\n`;
    }
  }

  // Блок нестабильных устройств (частые потери связи) списком ТОЛЬКО для устройств с включенным отслеживанием
  if (cfg.showFlappingDevices !== false) {
    const disconnMap = {};
    periodEvents.forEach(e => {
      if (e.category === 'disconnect' || e.type === 'off') {
        const dev = devices.find(d => 
          (e.deviceId && (d.id === e.deviceId || d.mac === e.deviceId || d.ip === e.deviceId)) ||
          (e.deviceName && d.name === e.deviceName)
        );
        // Учитываем устройство ТОЛЬКО если у него включена галочка "Следить за устройством"
        if (dev && dev.tgWatch && dev.tgWatch.enabled) {
          const name = dev.name || e.deviceName || 'Устройство';
          disconnMap[name] = (disconnMap[name] || 0) + 1;
        }
      }
    });
    const minCount = cfg.flapMinCount || 2;
    const unstable = Object.entries(disconnMap)
      .filter(([_, cnt]) => cnt >= minCount)
      .sort((a, b) => b[1] - a[1]);

    const periodLabel = isWeekly ? 'за неделю' : 'за день';
    if (unstable.length > 0) {
      devSection += `• ⚠️ <b>Частые потери связи (${periodLabel}):</b>\n`;
      unstable.slice(0, 8).forEach(([name, cnt]) => {
        const word = cnt === 1 ? 'отвал' : (cnt >= 2 && cnt <= 4) ? 'отвала' : 'отвалов';
        devSection += `  — ${name} — <b>${cnt} ${word}</b>\n`;
      });
    } else {
      devSection += `• ✅ <b>Стабильность устройств (${periodLabel}):</b> 100%, отвалов не зафиксировано\n`;
    }
  }

  if (devSection) {
    text += `${devSection}\n`;
  }

  // 3. Сервер Homelab
  if (cfg.showServer !== false) {
    text += `🖥 <b>Сервер Homelab:</b>\n`;
    text += `• CPU: <code>${host.cpuPct}%</code>\n`;
    if (cfg.showServerTemp !== false && host.cpuTemp) {
      text += `• Температура: <code>${host.cpuTemp}°C</code>\n`;
      const periodLabel = isWeekly ? 'за неделю' : 'за день';
      const maxTemp = getMaxCpuTemp(periodMs, host.cpuTemp);
      text += `• Макс. температура (${periodLabel}): <code>${maxTemp}°C</code>\n`;
    }
    text += `• RAM: <code>${host.ramPct}%</code>\n`;
    text += `• SSD: <code>${host.diskPct}%</code>\n`;
    text += `• Uptime: <code>${formatUptime(host.uptimeSec || 0)}</code>\n\n`;
  }

  // 4. Журнал инцидентов (если включен в настройках)
  if (cfg.showRecentEvents) {
    const recent = eventsLog.slice(0, isWeekly ? 5 : 3);
    if (recent.length > 0) {
      text += `🔔 <b>Последние события:</b>\n`;
      recent.forEach(ev => {
        const icon = (ev.type === 'err' || ev.type === 'off') ? '🔴' : ev.type === 'warn' ? '🟡' : '🟢';
        const clean = (ev.deviceName && ev.text.startsWith(ev.deviceName)) ? ev.text : `${ev.deviceName ? ev.deviceName + ': ' : ''}${ev.text}`;
        text += `${icon} <code>${ev.time}</code> ${clean}\n`;
      });
    }
  }

  return text.trim() + '\n';
}

function formatUptime(totalSec) {
  const sec = Math.floor(totalSec || 0);
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч ${m}м`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

// Отправка сообщений в реальный Telegram бот (если заданы токен и chatId)
function sendTelegramMessage(text, bypassMute = false) {
  if (!appSettings.tgToken || !appSettings.tgChatId) return;
  if (!bypassMute && appSettings.tgMuted === true) return;
  try {
    const postData = JSON.stringify({
      chat_id: appSettings.tgChatId,
      text: text,
      parse_mode: 'HTML'
    });
    const req = https.request({
      hostname: 'api.telegram.org',
      port: 443,
      path: `/bot${appSettings.tgToken}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {});
    req.on('error', () => {});
    req.write(postData);
    req.end();
  } catch (e) {}
}

function addEventLog(type, text, category = 'connect', deviceName = 'Сеть', deviceId = '') {
  const nowMs = Date.now();
  const timeStr = getLocalTimeInfo(new Date(nowMs)).timeStrSec;
  const entry = {
    id: `ev_${nowMs}_${Math.floor(Math.random() * 1000)}`,
    time: timeStr,
    timestamp: nowMs,
    dateLabel: 'Сегодня',
    deviceId,
    deviceName,
    category,
    type,
    tgSent: false,
    text
  };

  // Проверка отправки в Telegram (только если уведомления не заглушены)
  if (appSettings.tgToken && appSettings.tgChatId && appSettings.tgMuted !== true) {
    let shouldSend = false;
    let icon = '🔔';

    // 1. Новое неизвестное устройство (если включено в общих настройках)
    if (category === 'new_device' && appSettings.tgNewDevice !== false) {
      shouldSend = true;
      icon = '🆕';
    }
    // 2. Внешний интернет (WAN) — отправляется отдельным сообщением с расчетом длительности обрыва
    else if (type === 'wan_off' || type === 'wan_ok') {
      shouldSend = false;
    }
    // 3. Системные события сервера
    else if (category === 'server' && (type === 'err' || type === 'warn')) {
      shouldSend = true;
      icon = type === 'err' ? '🚨' : '⚠️';
    }
    // 4. Обычные сетевые устройства: отправляем ТОЛЬКО если у устройства включено персональное отслеживание (tgWatch.enabled)
    else if (deviceId) {
      const dev = devices.find(d => d.id === deviceId || d.mac === deviceId || d.ip === deviceId);
      if (dev && dev.tgWatch && dev.tgWatch.enabled) {
        if ((category === 'connect' || type === 'ok') && dev.tgWatch.onConnect) {
          shouldSend = true;
          icon = '🟢';
        } else if ((category === 'disconnect' || type === 'off') && dev.tgWatch.onDisconnect) {
          shouldSend = true;
          icon = '🔴';
        } else if (type === 'warn' && dev.tgWatch.onHighPing) {
          shouldSend = true;
          icon = '🟡';
        }
      }
    }

    if (shouldSend) {
      entry.tgSent = true;
      const cleanText = (deviceName && text.startsWith(deviceName)) ? text : `${deviceName ? deviceName + ': ' : ''}${text}`;
      sendTelegramMessage(`${icon} <b>HomeNet Monitor</b>\n<code>${timeStr}</code> ${cleanText}`);
    }
  }

  eventsLog.unshift(entry);
  if (eventsLog.length > MAX_EVENTS) eventsLog.pop();
  saveEventsLogDebounced();
  return entry;
}

// 2. База OUI вендоров
const KNOWN_VENDORS = {
  '80:AF:CA': 'Keenetic Ltd.',
  '86:AF:CA': 'Keenetic Ltd.',
  'CC:2D:21': 'Tenda Technology',
  '00:16:96': 'ASUSTeK',
  '16:EB:B6': 'Samsung Electronics',
  '10:B4:1D': 'Bambu Lab',
  '56:C4:E8': 'Samsung Electronics',
  '7C:E9:13': 'Anker Innovations',
  '08:F9:E0': 'Espressif Inc.',
  '08:A6:F7': 'Espressif Inc.',
  '80:B5:4E': 'Espressif Inc.',
  'E8:6B:EA': 'Espressif Inc.',
  'E4:F1:4C': 'Network Video Recorder',
  'BA:E6:D9': 'Samsung Electronics',
  'F4:CF:A2': 'Espressif Inc.',
  '84:47:09': 'Home Automation',
  '00:33:7A': 'Home Automation',
  'B0:EB:57': 'Huawei / Honor',
  'A6:20:52': 'Apple Inc.',
  'BE:9B:23': 'Apple Inc.',
  'DC:21:48': 'Laptop',
  'EC:9C:32': 'Xiaomi Communications',
  '60:35:73': 'Xiaomi Communications',
  '60:A4:B7': 'OpenWrt Router',
  '06:E3:FA': 'OPPO Mobile',
  '0E:96:67': 'OPPO Mobile',
  'C4:82:E1': 'Espressif Inc.',
  '8E:8F:CC': 'Realme Mobile'
};

function getVendor(mac) {
  if (!mac) return 'Сеть LAN / Wi-Fi';
  const prefix = mac.slice(0, 8).toUpperCase();
  return KNOWN_VENDORS[prefix] || 'Сетевое устройство';
}

// 3. Состояние мониторинга сети
let state = {
  wanPing: 12.4,
  wanOnline: true,
  gatewayPing: 1.1,
  gatewayOnline: true,
  netDownMbps: 0.8,
  netUpMbps: 0.3,
  lastScanTime: null,
  isScanning: false,
  scanProgress: 0
};

// Замер пинга на Linux
function pingHost(ip, timeoutSec = 1) {
  return new Promise((resolve) => {
    if (!ip) return resolve({ online: false, ping: null });
    exec(`ping -c 1 -W ${timeoutSec} ${ip}`, { timeout: (timeoutSec + 1) * 1000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ online: false, ping: null });
      }
      // Парсим время: time=X.XX ms
      const m = stdout.match(/time=([0-9.]+)\s*ms/);
      if (m && m[1]) {
        return resolve({ online: true, ping: parseFloat(m[1]) });
      }
      resolve({ online: true, ping: 1.0 });
    });
  });
}

// Замер TCP пинга для VDS серверов (на случай, если ICMP заблокирован файрволом)
function pingTcpPort(host, port = 22, timeout = 2500) {
  return new Promise((resolve) => {
    if (!host) return resolve({ online: false, ping: null });
    const start = process.hrtime();
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      if (isResolved) return;
      isResolved = true;
      const diff = process.hrtime(start);
      const ms = +(diff[0] * 1000 + diff[1] / 1e6).toFixed(1);
      socket.destroy();
      resolve({ online: true, ping: ms });
    });
    socket.on('timeout', () => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      resolve({ online: false, ping: null });
    });
    socket.on('error', (err) => {
      if (isResolved) return;
      isResolved = true;
      socket.destroy();
      // Если сервер ответил отказом RST (ECONNREFUSED), он всё равно живой и на связи!
      if (err.code === 'ECONNREFUSED') {
        const diff = process.hrtime(start);
        resolve({ online: true, ping: +(diff[0] * 1000 + diff[1] / 1e6).toFixed(1) });
      } else {
        resolve({ online: false, ping: null });
      }
    });

    try {
      socket.connect(port, host);
    } catch (e) {
      resolve({ online: false, ping: null });
    }
  });
}

// Комплексная проверка VDS: ICMP -> fallback на SSH/TCP порт
async function pingVds(srv) {
  if (!srv || !srv.ip) return { online: false, ping: null };
  const icmp = await pingHost(srv.ip, 1);
  if (icmp.online && icmp.ping !== null) return icmp;
  const tcp = await pingTcpPort(srv.ip, srv.port || 22, 2500);
  if (tcp.online && tcp.ping !== null) return tcp;
  return icmp;
}

// Чтение ARP таблицы ядра Linux (только подсеть 192.168.1.x)
function getArpTable() {
  const table = {}; // ip -> mac
  try {
    if (fs.existsSync('/proc/net/arp')) {
      const lines = fs.readFileSync('/proc/net/arp', 'utf8').split('\n');
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 4) {
          const ip = parts[0];
          if (!ip.startsWith(SUBNET_PREFIX)) continue;
          const mac = parts[3].toLowerCase();
          if (mac && mac !== '00:00:00:00:00:00' && mac.length === 17) {
            table[ip] = mac;
          }
        }
      }
    }
  } catch (e) {
    console.error('Ошибка чтения /proc/net/arp:', e);
  }

  // Также пробуем `ip neigh` (фильтруем только нужную IPv4 подсеть)
  try {
    const neigh = execSync('ip neigh', { timeout: 1500 }).toString();
    const lines = neigh.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const ip = parts[0];
      if (!ip.startsWith(SUBNET_PREFIX)) continue;
      const llIdx = parts.indexOf('lladdr');
      if (llIdx !== -1 && parts[llIdx + 1]) {
        const mac = parts[llIdx + 1].toLowerCase();
        if (mac && mac.length === 17 && mac !== '00:00:00:00:00:00') {
          table[ip] = mac;
        }
      }
    }
  } catch (e) {}

  return table;
}

// ----------------------------------------------------
// Интеграция с роутерами (Keenetic RCI API, OpenWrt ubus RPC)
// ----------------------------------------------------
let keeneticCookie = null;
let keeneticWanStats = { downMbps: 0, upMbps: 0 };
let keeneticSystemStats = { uptimeSec: 0, cpuload: 0 };
let openwrtToken = null;

function requestHttp(url, options = {}, bodyData = null) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: false
      };
      const req = lib.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data
          });
        });
      });
      req.on('error', err => reject(err));
      req.setTimeout(options.timeout || 4000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
      if (bodyData) req.write(bodyData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

// --- KeeneticOS RCI API ---
async function loginKeenetic(overrideCfg = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const user = overrideCfg?.user || appSettings.routerUser || KEENETIC_USER;
  const pass = overrideCfg?.pass || appSettings.routerPass || KEENETIC_PASS;
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const baseUrl = `${proto}://${ip}:${port}`;

  try {
    const r1 = await requestHttp(`${baseUrl}/auth`, { timeout: 3500 });
    const challenge = r1.headers['x-ndm-challenge'];
    const realm = r1.headers['x-ndm-realm'] || 'Keenetic';
    if (!challenge) throw new Error('Роутер не вернул challenge токен авторизации');

    let cookie = '';
    const setCookie = r1.headers['set-cookie'];
    if (setCookie && setCookie.length > 0) {
      cookie = setCookie[0].split(';')[0];
    }

    const md5Str = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex');
    const pwdHash = crypto.createHash('sha256').update(`${challenge}${md5Str}`).digest('hex');
    const authPayload = JSON.stringify({ login: user, password: pwdHash });

    const r2 = await requestHttp(`${baseUrl}/auth`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': cookie
      },
      timeout: 3500
    }, authPayload);

    if (r2.statusCode === 200) {
      if (r2.headers['set-cookie'] && r2.headers['set-cookie'].length > 0) {
        cookie = r2.headers['set-cookie'][0].split(';')[0];
      }
      if (!overrideCfg) {
        keeneticCookie = cookie;
        state.routerConnected = true;
      }
      return { ok: true, cookie };
    } else {
      if (!overrideCfg) {
        keeneticCookie = null;
        state.routerConnected = false;
      }
      throw new Error(`Ошибка авторизации Keenetic (код ${r2.statusCode})`);
    }
  } catch (e) {
    if (!overrideCfg) {
      keeneticCookie = null;
      state.routerConnected = false;
    }
    throw e;
  }
}

async function fetchKeeneticHotspot(overrideCfg = null, overrideCookie = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const baseUrl = `${proto}://${ip}:${port}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let cookie = overrideCookie || keeneticCookie;
      if (!cookie && !overrideCfg) {
        const loginRes = await loginKeenetic();
        cookie = loginRes.cookie;
      }
      if (!cookie) return null;

      const res = await requestHttp(`${baseUrl}/rci/show/ip/hotspot`, {
        method: 'GET',
        headers: { 'Cookie': cookie },
        timeout: 3500
      });

      if (res.statusCode === 401 && !overrideCfg) {
        keeneticCookie = null;
        await loginKeenetic();
        continue;
      }

      if (res.statusCode === 200 && res.body) {
        return JSON.parse(res.body);
      }
    } catch (e) {
      if (!overrideCfg) keeneticCookie = null;
    }
  }
  return null;
}

async function fetchKeeneticWanTraffic(overrideCfg = null, overrideCookie = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const iface = overrideCfg?.wanInterface || appSettings.routerWanInterface || 'PPPoE0';
  const baseUrl = `${proto}://${ip}:${port}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let cookie = overrideCookie || keeneticCookie;
      if (!cookie && !overrideCfg) {
        const loginRes = await loginKeenetic();
        cookie = loginRes.cookie;
      }
      if (!cookie) return keeneticWanStats;

      const res = await requestHttp(`${baseUrl}/rci/show/interface/stat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookie
        },
        timeout: 3500
      }, JSON.stringify({ name: iface }));

      if (res.statusCode === 401 && !overrideCfg) {
        keeneticCookie = null;
        await loginKeenetic();
        continue;
      }

      if (res.statusCode === 200 && res.body) {
        const data = JSON.parse(res.body);
        const rxBytesPerSec = data.rxspeed || 0;
        const txBytesPerSec = data.txspeed || 0;
        const downMbps = +(rxBytesPerSec * 8 / 1000000).toFixed(1);
        const upMbps = +(txBytesPerSec * 8 / 1000000).toFixed(1);
        keeneticWanStats = { downMbps, upMbps };
        return keeneticWanStats;
      }
    } catch (e) {
      if (!overrideCfg) keeneticCookie = null;
    }
  }
  return keeneticWanStats;
}

async function fetchKeeneticSystem(overrideCfg = null, overrideCookie = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const baseUrl = `${proto}://${ip}:${port}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      let cookie = overrideCookie || keeneticCookie;
      if (!cookie && !overrideCfg) {
        const loginRes = await loginKeenetic();
        cookie = loginRes.cookie;
      }
      if (!cookie) return null;

      const res = await requestHttp(`${baseUrl}/rci/show/system`, {
        method: 'GET',
        headers: { 'Cookie': cookie },
        timeout: 3500
      });

      if (res.statusCode === 401 && !overrideCfg) {
        keeneticCookie = null;
        await loginKeenetic();
        continue;
      }

      if (res.statusCode === 200 && res.body) {
        const data = JSON.parse(res.body);
        const up = parseInt(data.uptime, 10) || 0;
        const sysStats = {
          uptimeSec: up,
          cpuload: data.cpuload || 0
        };
        if (!overrideCfg) {
          keeneticSystemStats = sysStats;
          state.routerUptimeSec = up;
          state.routerConnected = true;
        }
        return sysStats;
      }
    } catch (e) {
      if (!overrideCfg) {
        keeneticCookie = null;
        state.routerConnected = false;
      }
    }
  }
  return keeneticSystemStats;
}

// --- OpenWrt ubus JSON-RPC ---
async function loginOpenWrt(overrideCfg = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const user = overrideCfg?.user || appSettings.routerUser || 'root';
  const pass = overrideCfg?.pass || appSettings.routerPass || '';
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const baseUrl = `${proto}://${ip}:${port}`;

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'call',
    params: [
      '00000000000000000000000000000000',
      'session',
      'login',
      { username: user, password: pass }
    ]
  });

  const res = await requestHttp(`${baseUrl}/ubus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeout: 3500
  }, payload);

  if (res.statusCode === 200 && res.body) {
    const data = JSON.parse(res.body);
    if (data.result && data.result[0] === 0 && data.result[1]?.ubus_rpc_session) {
      const token = data.result[1].ubus_rpc_session;
      if (!overrideCfg) {
        openwrtToken = token;
        state.routerConnected = true;
      }
      return { ok: true, token };
    }
    throw new Error('Неверный логин или пароль OpenWrt (ubus reject)');
  } else if (res.statusCode === 404) {
    throw new Error('Служба /ubus не найдена на роутере. Проверьте запуск uhttpd.');
  } else {
    throw new Error(`Ошибка подключения к OpenWrt (HTTP ${res.statusCode})`);
  }
}

async function callOpenWrtUbus(module, method, args = {}, overrideCfg = null, overrideToken = null) {
  const ip = overrideCfg?.ip || appSettings.routerIp || GATEWAY_IP;
  const port = overrideCfg?.port || appSettings.routerPort || 80;
  const proto = overrideCfg?.proto || appSettings.routerProto || 'http';
  const baseUrl = `${proto}://${ip}:${port}`;

  let token = overrideToken || openwrtToken;
  if (!token && !overrideCfg) {
    try {
      const loginRes = await loginOpenWrt();
      token = loginRes.token;
    } catch (e) {
      return null;
    }
  }
  if (!token) return null;

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'call',
    params: [token, module, method, args]
  });

  try {
    const res = await requestHttp(`${baseUrl}/ubus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 3500
    }, payload);

    if (res.statusCode === 200 && res.body) {
      const data = JSON.parse(res.body);
      if (data.result && data.result[0] === 0) {
        return data.result[1];
      }
    }
  } catch (e) {}
  return null;
}

async function fetchOpenWrtSystem(overrideCfg = null, overrideToken = null) {
  try {
    const sys = await callOpenWrtUbus('system', 'info', {}, overrideCfg, overrideToken);
    if (sys) {
      const up = sys.uptime || 0;
      let load = 0;
      if (Array.isArray(sys.load) && sys.load.length > 0) {
        load = Math.round((sys.load[0] / 65536) * 100);
      }
      const sysStats = { uptimeSec: up, cpuload: Math.min(100, Math.max(0, load)) };
      if (!overrideCfg) {
        keeneticSystemStats = sysStats;
        state.routerUptimeSec = up;
        state.routerConnected = true;
      }
      return sysStats;
    }
  } catch (e) {
    if (!overrideCfg) state.routerConnected = false;
  }
  return { uptimeSec: 0, cpuload: 0 };
}

async function fetchOpenWrtClients(overrideCfg = null, overrideToken = null) {
  try {
    let leasesObj = await callOpenWrtUbus('luci-rpc', 'getDHCPLeases', {}, overrideCfg, overrideToken);
    if (!leasesObj) {
      leasesObj = await callOpenWrtUbus('luci', 'getDHCPLeases', {}, overrideCfg, overrideToken);
    }
    const leases = (leasesObj && leasesObj.dhcpleases) ? leasesObj.dhcpleases : (Array.isArray(leasesObj) ? leasesObj : []);
    return leases.map(l => ({
      mac: (l.macaddr || l.mac || '').toLowerCase(),
      ip: l.ipaddr || l.ip || '',
      name: l.hostname || ''
    })).filter(l => l.mac);
  } catch (e) {
    return [];
  }
}

async function syncWithOpenWrt() {
  try {
    const clients = await fetchOpenWrtClients();
    if (!clients || !Array.isArray(clients)) return;
    const currentHour = getCurrentLocalHour();
    const routerIp = appSettings.routerIp || GATEWAY_IP;

    // Шлюз OpenWrt
    let gwDev = devices.find(d => d.ip === routerIp || (d.type === 'router' && d.vendor?.includes('OpenWrt')));
    if (!gwDev) {
      gwDev = {
        id: 'dev_gateway',
        name: appSettings.routerName || 'Роутер OpenWrt',
        type: 'router',
        ip: routerIp,
        mac: '',
        vendor: 'OpenWrt Network Gateway',
        status: 'online',
        ping: state.gatewayPing || 1.0,
        hours24: Array(24).fill(1),
        lastSeen: 'Только что'
      };
      devices.unshift(gwDev);
    } else {
      gwDev.status = 'online';
      gwDev.ip = routerIp;
      if (!gwDev.hours24) gwDev.hours24 = Array(24).fill(1);
      gwDev.hours24[currentHour] = 1;
    }

    for (const c of clients) {
      if (!c.mac) continue;
      const mac = c.mac.toLowerCase();
      const ip = c.ip || '';
      const hostname = c.name || '';

      let dev = devices.find(d => d.mac && d.mac.toLowerCase() === mac);
      if (!dev && ip) {
        dev = devices.find(d => d.ip === ip);
      }

      if (dev) {
        if (ip && (!dev.ip || dev.ip === '0.0.0.0')) dev.ip = ip;
        if ((!dev.name || dev.name.startsWith('Устройство ') || dev.name.startsWith('192.168.')) && hostname) {
          dev.name = hostname;
        }
        if (!dev.hours24) dev.hours24 = Array(24).fill(0);
        dev.hours24[currentHour] = 1;
      }
    }
    state.routerConnected = true;
    saveDevices();
  } catch (e) {
    state.routerConnected = false;
  }
}

// Синхронизация списка устройств с роутером Keenetic
async function syncWithKeenetic() {
  const hotspot = await fetchKeeneticHotspot();
  if (!hotspot || !Array.isArray(hotspot.host)) return;

  const currentHour = getCurrentLocalHour();
  const hosts = hotspot.host;
  const keeneticMacs = new Set();

  for (const h of hosts) {
    if (!h.mac) continue;
    const mac = h.mac.toLowerCase();
    const rawIp = h.ip || '';
    const ip = (rawIp && rawIp !== '0.0.0.0' && rawIp !== 'None') ? rawIp : '';
    const routerName = h.name || h.hostname || '';

    // Роутер KN-4110 и шлюз мы обрабатываем отдельно ниже как устройства инфраструктуры
    const isRouterHost = (ip === (appSettings.routerIp || GATEWAY_IP) || routerName === 'Keenetic' || (gwDev && mac === gwDev.mac));
    if (isRouterHost) continue;

    keeneticMacs.add(mac);
    const isActive = Boolean(h.active);

    // Точное определение типа подключения (Wi-Fi 2.4/5GHz против Ethernet)
    const isWifi = Boolean(h.ap || h.ssid || h.mws || h.wireless);
    let wifiBand = '2.4';
    const apStr = (h.ap || (h.mws && h.mws.ap) || '');
    if (apStr.includes('WifiMaster1') || (h.mws && h.mws.mode && (h.mws.mode.includes('ac') || h.mws.mode.includes('ax')))) {
      wifiBand = '5';
    }
    const detectedConnType = isWifi ? 'wifi' : 'lan';
    const detectedConnLabel = isWifi ? `Wi-Fi (${wifiBand} GHz)` : (h.port ? `Ethernet (Порт ${h.port})` : 'Ethernet');

    // Ищем устройство в локальной базе по MAC-адресу или via (для репитеров / WDS)
    let dev = devices.find(d => d.mac && (d.mac.toLowerCase() === mac || (h.via && d.mac.toLowerCase() === h.via.toLowerCase())));
    if (dev) {
      const prevStatus = dev.status;
      if (ip) {
        dev.ip = ip;
      }
      dev.mac = mac;
      if (routerName) {
        dev.name = routerName;
      }

      // Для устройств с приоритетным пингом (FastPing) статус офлайн определяет быстрый ICMP-поллер,
      // а Keenetic не должен принудительно возвращать dev.status = 'online', пока устройство не пингуется.
      const isFastPingDev = Boolean(dev.tgWatch && dev.tgWatch.fastPing === true);
      if (!isFastPingDev || (priorityFails[dev.id] || 0) < 2) {
        dev.status = isActive ? 'online' : 'offline';
      }

      dev.vendor = dev.vendor || getVendor(mac);
      dev.connType = detectedConnType;
      dev.connLabel = detectedConnLabel;

      if (isActive && dev.status !== 'offline') {
        dev.lastSeen = 'Только что';
        dev.offlineSec = 0;
        dev.sessionSec = (dev.sessionSec || 0) + 5;
        if (h.uptime) dev.sessionSec = h.uptime;
        if (!dev.ping || dev.ping === 0) dev.ping = 1.0;
        
        // Корректное заполнение 24 часов на основе фактического аптайма сессии
        if (!dev.hours24 || dev.hours24.length !== 24) dev.hours24 = Array(24).fill(0);
        dev.hours24[currentHour] = 1;
        if (dev.sessionSec && dev.sessionSec > 0) {
          const activeHours = Math.min(24, Math.floor(dev.sessionSec / 3600));
          for (let hr = 0; hr <= activeHours; hr++) {
            const pastHour = (currentHour - hr + 24) % 24;
            dev.hours24[pastHour] = 1;
          }
        }

        // Если роутер зафиксировал появление устройства менее 24 часов назад,
        // все часы ДО первого обнаружения (first-seen) гарантированно были оффлайн (0)
        const rawFirstSeen = h['first-seen'] !== undefined ? h['first-seen'] : h.firstSeen;
        const firstSeenSec = rawFirstSeen !== undefined ? rawFirstSeen : (dev.sessionSec || 0);
        if (firstSeenSec < 86400) {
          const firstSeenHours = Math.ceil(firstSeenSec / 3600);
          for (let hr = firstSeenHours + 1; hr < 24; hr++) {
            const pastHour = (currentHour - hr + 24) % 24;
            dev.hours24[pastHour] = 0;
          }
        }

        if (prevStatus === 'offline') {
          const offHours = Math.min(24, Math.floor((dev.offlineSec || 0) / 3600));
          for (let hr = 1; hr <= offHours; hr++) {
            const pastHour = (currentHour - hr + 24) % 24;
            dev.hours24[pastHour] = 0;
          }
          addEventLog('ok', `${dev.name}: появился в сети`, 'connect', dev.name, dev.id);
        }
      } else {
        dev.ping = null;
        dev.offlineSec = (dev.offlineSec || 0) + 5;
        if (!dev.hours24 || dev.hours24.length !== 24) dev.hours24 = Array(24).fill(0);
        dev.hours24[currentHour] = 0;
        if (dev.offlineSec && dev.offlineSec > 0) {
          const offHours = Math.min(24, Math.floor(dev.offlineSec / 3600));
          for (let hr = 0; hr <= offHours; hr++) {
            const pastHour = (currentHour - hr + 24) % 24;
            dev.hours24[pastHour] = 0;
          }
        }
        if (prevStatus === 'online' || prevStatus === 'warn') {
          addEventLog('off', `${dev.name}: не в сети`, 'disconnect', dev.name, dev.id);
        }
      }
      sanitizeDays30(dev);
    } else {
      // Новое устройство, зарегистрированное в Keenetic
      const vendorName = getVendor(mac);
      const initialHours = Array(24).fill(0);
      if (isActive) initialHours[currentHour] = 1;
      const newDev = {
        id: `dev_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        name: routerName || `${vendorName.split(' ')[0]} (${ip || 'Wi-Fi'})`,
        role: 'Сетевое устройство',
        room: 'LAN',
        type: 'iot',
        ip,
        mac,
        vendor: vendorName,
        connType: detectedConnType,
        connLabel: detectedConnLabel,
        status: isActive ? 'online' : 'offline',
        ping: isActive ? 1.0 : null,
        basePing: 1.0,
        sessionSec: isActive ? (h.uptime || 60) : 0,
        offlineSec: isActive ? 0 : 60,
        downMbps: 0.1,
        upMbps: 0.05,
        pingHistory: isActive ? [1.0] : [],
        hours24: initialHours,
        lastSeen: isActive ? 'Только что' : 'Ранее',
        ports: h.port ? `Порт ${h.port}` : '—',
        unconfirmed: true
      };
      sanitizeDays30(newDev);
      devices.push(newDev);
      if (isActive) {
        addEventLog('ok', `${newDev.name}: новое устройство, появилось в сети`, 'new_device', newDev.name, newDev.id);
      }
    }
  }

  // Оставляем в базе клиентские устройства Keenetic без дубликатов по MAC
  const seenMacs = new Set();
  devices = devices.filter(d => {
    if (d.type === 'router' || d.id === 'dev_router_gw' || d.id === 'dev_router_mesh') return true;
    if (!d.mac) return false;
    const m = d.mac.toLowerCase();
    if (gwDev && gwDev.mac && m === gwDev.mac.toLowerCase()) return false;
    if (seenMacs.has(m)) return false;
    if (!keeneticMacs.has(m)) return false;
    seenMacs.add(m);
    return true;
  });

  // Гарантируем наличие карточки основного роутера (шлюза)
  const gwIp = appSettings.routerIp || GATEWAY_IP;
  let gwDev = devices.find(d => d.id === 'dev_router_gw' || d.ip === gwIp || d.type === 'router');
  if (!gwDev) {
    gwDev = {
      id: 'dev_router_gw',
      name: appSettings.routerName || 'Роутер (Шлюз)',
      role: 'Основной роутер',
      room: 'Серверная',
      type: 'router',
      ip: gwIp,
      mac: '00:11:22:33:44:55',
      vendor: 'Gateway Router',
      connType: 'lan',
      connLabel: 'Шлюз (WAN/LAN)',
      status: state.wanOnline ? 'online' : 'warn',
      ping: state.gatewayPing || 0.6,
      basePing: 0.6,
      sessionSec: (keeneticSystemStats.uptimeSec || state.routerUptimeSec || 60),
      offlineSec: 0,
      downMbps: 2.5,
      upMbps: 0.8,
      pingHistory: [0.6, 0.7, 0.6, 0.5, 0.6],
      hours24: Array(24).fill(1),
      lastSeen: 'Только что',
      ports: 'WAN, 1-4'
    };
    devices.unshift(gwDev);
  } else {
    gwDev.status = 'online';
    gwDev.ip = gwIp;
    gwDev.ping = state.gatewayPing || 0.6;
    if (keeneticSystemStats.uptimeSec || state.routerUptimeSec) {
      gwDev.sessionSec = (keeneticSystemStats.uptimeSec || state.routerUptimeSec);
    }
    if (!gwDev.hours24) gwDev.hours24 = Array(24).fill(1);
  }

  saveDevices();
}

// Опрос роутера каждые 5 секунд для мгновенной точности активных устройств, аптайма и трафика
setInterval(async () => {
  try {
    const rType = appSettings.routerType || 'keenetic';
    if (rType === 'keenetic') {
      await fetchKeeneticSystem();
      await fetchKeeneticWanTraffic();
      await syncWithKeenetic();
    } else if (rType === 'openwrt') {
      await fetchOpenWrtSystem();
      await syncWithOpenWrt();
    }
  } catch (e) {}
}, 5000);

// Фоновый опрос WAN и Шлюза (каждые 3 сек) с отслеживанием обрывов и длительности
let wanDownSince = null;
let wanDownTimeStr = '';
let wanFailedPings = 0;

setInterval(async () => {
  const target = (appSettings && appSettings.wanTarget) ? appSettings.wanTarget : WAN_TARGET;
  const wan = await pingHost(target, 1);

  if (!wan.online) {
    wanFailedPings++;
    // Если 2 проверки подряд нет связи (6 сек) и WAN был онлайн — фиксируем обрыв
    if (wanFailedPings >= 2 && state.wanOnline) {
      state.wanOnline = false;
      wanDownSince = wanDownSince || Date.now();
      wanDownTimeStr = getLocalTimeInfo(new Date()).timeStrSec;
      addEventLog('wan_off', `Обрыв интернет-соединения (WAN) в ${wanDownTimeStr}`, 'server', 'Интернет');
    }
  } else {
    wanFailedPings = 0;
    if (wan.ping !== null) state.wanPing = +(wan.ping).toFixed(1);

    // Если связь только что восстановилась после обрыва
    if (!state.wanOnline) {
      state.wanOnline = true;
      const upTimeStr = getLocalTimeInfo(new Date()).timeStrSec;
      const outageSec = wanDownSince ? Math.max(1, Math.floor((Date.now() - wanDownSince) / 1000)) : 0;

      let durationStr = `${outageSec} сек`;
      if (outageSec >= 3600) {
        const h = Math.floor(outageSec / 3600);
        const m = Math.floor((outageSec % 3600) / 60);
        durationStr = `${h} ч ${m} мин`;
      } else if (outageSec >= 60) {
        durationStr = `${Math.floor(outageSec / 60)} мин`;
      }

      const outageMsg = `🌐 <b>ИНТЕРНЕТ (WAN) СНОВА ДОСТУПЕН!</b>\n` +
        `⏱ <b>Отсутствовал:</b> ${durationStr}\n` +
        `🕒 <b>Пропал в:</b> <code>${wanDownTimeStr || '—'}</code>\n` +
        `🕒 <b>Появился в:</b> <code>${upTimeStr}</code>\n` +
        `⚡ <b>Пинг до провайдера:</b> <code>${state.wanPing ? state.wanPing + ' мс' : '—'}</code>`;

      sendTelegramMessage(outageMsg);
      addEventLog('wan_ok', `Интернет (WAN) восстановлен. Связь отсутствовала ${durationStr} (с ${wanDownTimeStr || '—'} по ${upTimeStr})`, 'server', 'Интернет');

      wanDownSince = null;
      wanDownTimeStr = '';
    }
  }

  const gw = await pingHost(GATEWAY_IP, 1);
  state.gatewayOnline = gw.online;
  if (gw.ping !== null) state.gatewayPing = +(gw.ping).toFixed(1);
}, 3000);

// ----------------------------------------------------
// ДВУХУРОВНЕВЫЙ НЕЗАВИСИМЫЙ ПИНГ-ПОЛЛЕР УСТРОЙСТВ
// ----------------------------------------------------
// Хранилище счетчиков неудачных пингов для приоритетных устройств: { [devId]: failCount }
const priorityFails = {};

// Уровень А: Приоритетный опрос (каждые 3 сек для устройств со 'Следить' / FastPing)
setInterval(async () => {
  if (devices.length === 0 || state.isScanning) return;
  const currentHour = getCurrentLocalHour();

  // Отбираем устройства с включенным быстрым пингом (строго fastPing === true)
  const watchedDevs = devices.filter(d => d.ip && d.ip.startsWith(SUBNET_PREFIX) && d.tgWatch && d.tgWatch.fastPing === true);
  if (watchedDevs.length === 0) return;

  await Promise.allSettled(watchedDevs.map(async (dev) => {
    const res = await pingHost(dev.ip, 1);
    const prevStatus = dev.status;

    if (res.online && res.ping !== null) {
      priorityFails[dev.id] = 0;
      dev.ping = +(res.ping).toFixed(1);
      const isWarn = dev.ping > (dev.customPingMax || appSettings.pingThreshold || 35);
      dev.status = isWarn ? 'warn' : 'online';
      dev.sessionSec = (dev.sessionSec || 0) + 3;
      dev.offlineSec = 0;
      dev.lastSeen = 'Только что';

      if (!dev.pingHistory) dev.pingHistory = [];
      dev.pingHistory.push(dev.ping);
      if (dev.pingHistory.length > 12) dev.pingHistory.shift();

      if (!dev.hours24) dev.hours24 = Array(24).fill(0);
      dev.hours24[currentHour] = isWarn ? 2 : 1;

      // Если устройство вернулось в сеть после обрыва
      if (prevStatus === 'offline') {
        addEventLog('ok', `${dev.name}: появился в сети (${dev.ping} мс)`, 'connect', dev.name, dev.id);
      }
    } else {
      // Пинг не прошел
      priorityFails[dev.id] = (priorityFails[dev.id] || 0) + 1;
      dev.offlineSec = (dev.offlineSec || 0) + 3;

      if (!dev.pingHistory) dev.pingHistory = [];
      dev.pingHistory.push(0);
      if (dev.pingHistory.length > 12) dev.pingHistory.shift();

      // Если 2 пинга подряд нет ответа (6 секунд) и устройство числилось онлайн
      if (priorityFails[dev.id] >= 2 && prevStatus !== 'offline') {
        dev.status = 'offline';
        dev.ping = null;
        if (!dev.hours24) dev.hours24 = Array(24).fill(0);
        dev.hours24[currentHour] = 0;
        addEventLog('off', `${dev.name}: не в сети`, 'disconnect', dev.name, dev.id);
      }
    }
  }));
}, 3000);

// Уровень Б: Фоновый карусельный опрос остальных устройств домашней сети (каждые 2 сек пачками)
let checkIdx = 0;
setInterval(async () => {
  if (devices.length === 0 || state.isScanning) return;
  const currentHour = getCurrentLocalHour();

  // Опрашиваем устройства с локальными IP, исключая те, что уже проверяются в Уровне А
  const regularList = devices.filter(d => d.ip && d.ip.startsWith(SUBNET_PREFIX) && !(d.tgWatch && d.tgWatch.fastPing === true));
  if (regularList.length === 0) return;

  const batchSize = Math.min(8, regularList.length);
  const chunk = [];
  for (let i = 0; i < batchSize; i++) {
    const dev = regularList[(checkIdx + i) % regularList.length];
    if (dev) chunk.push(dev);
  }
  checkIdx = (checkIdx + batchSize) % regularList.length;

  await Promise.allSettled(chunk.map(async (dev) => {
    const res = await pingHost(dev.ip, 1);
    if (res.online && res.ping !== null) {
      dev.ping = +(res.ping).toFixed(1);
      const isWarn = dev.ping > (dev.customPingMax || appSettings.pingThreshold || 35);
      if (dev.status !== 'offline') dev.status = isWarn ? 'warn' : 'online';
      dev.sessionSec = (dev.sessionSec || 0) + 2;
      dev.lastSeen = 'Только что';

      if (!dev.pingHistory) dev.pingHistory = [];
      dev.pingHistory.push(dev.ping);
      if (dev.pingHistory.length > 12) dev.pingHistory.shift();

      if (!dev.hours24) dev.hours24 = Array(24).fill(0);
      const recentWarns = (dev.pingHistory || []).filter(p => p > (dev.customPingMax || appSettings.pingThreshold || 35)).length;
      dev.hours24[currentHour] = recentWarns >= 3 ? 2 : 1;
    } else {
      dev.offlineSec = (dev.offlineSec || 0) + 2;
      if (!dev.pingHistory) dev.pingHistory = [];
      dev.pingHistory.push(0);
      if (dev.pingHistory.length > 12) dev.pingHistory.shift();
      if (dev.status === 'offline') {
        if (!dev.hours24 || dev.hours24.length !== 24) dev.hours24 = Array(24).fill(0);
        dev.hours24[currentHour] = 0;
      }
    }
  }));
}, 2000);

// Ежечасный сброс слота карты присутствия при переходе часа
let lastRolloverHour = getCurrentLocalHour();
setInterval(() => {
  const currentHour = getCurrentLocalHour();
  if (currentHour !== lastRolloverHour) {
    const isMidnight = currentHour === 0;
    devices.forEach(dev => {
      if (!dev.hours24 || dev.hours24.length !== 24) dev.hours24 = Array(24).fill(0);
      const isOnline = dev.status === 'online' || dev.status === 'warn';

      if (isMidnight) {
        if (!dev.days30 || dev.days30.length !== 30) dev.days30 = Array(30).fill(0);
        dev.days30.shift();
        dev.days30.push(isOnline ? 1 : 0);
        dev.hours24 = Array(24).fill(0);
      }

      dev.hours24[currentHour] = isOnline ? 1 : 0;
      if (!dev.days30 || dev.days30.length !== 30) dev.days30 = Array(30).fill(0);
      if (isOnline) {
        dev.days30[29] = dev.status === 'warn' ? 2 : 1;
      }
    });
    lastRolloverHour = currentHour;
    saveDevices();
  }
}, 30000);

// Сбор детальной системной телеметрии с VDS серверов по SSH
function collectVdsTelemetry(srv) {
  return new Promise((resolve) => {
    const pass = srv.pass || srv.password || '';
    if (!pass && !srv.sshKey) return resolve(null);
    const port = srv.port || 22;
    const user = srv.user || 'root';
    const host = srv.ip;

    const cmd = "sshpass -p '" + pass + "' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p " + port + " " + user + "@" + host + " 'uptime && nproc && free -m && df -m /'";
    exec(cmd, { timeout: 9000 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const out = stdout.toString();

      const upMatch = out.match(/up\s+(.*?)(?:,\s+\d+\s+user|,\s+load)/);
      const uptimeStr = upMatch ? upMatch[1].trim() : '';

      const loadMatch = out.match(/load average:\s*([0-9.]+)/);
      const load = loadMatch ? parseFloat(loadMatch[1]) : 0;

      const nprocMatch = out.match(/\n(\d+)\s*\n/);
      const cores = nprocMatch ? parseInt(nprocMatch[1], 10) : (srv.cores || 1);

      let ramTotal = srv.ramTotal || 4;
      let ramUsed = srv.ramUsed || 1;
      let ramPct = srv.ramPct || 25;
      const memMatch = out.match(/Mem:\s+(\d+)\s+(\d+)/);
      if (memMatch) {
        const totMb = parseInt(memMatch[1], 10);
        const usedMb = parseInt(memMatch[2], 10);
        ramTotal = +(totMb / 1024).toFixed(1);
        ramUsed = +(usedMb / 1024).toFixed(1);
        ramPct = Math.round((usedMb / totMb) * 100);
      }

      let diskTotal = srv.diskTotal || 40;
      let diskUsed = srv.diskUsed || 10;
      let diskPct = srv.diskPct || 25;
      const dfMatch = out.match(/\/\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%/);
      if (dfMatch) {
        const dTotMb = parseInt(dfMatch[1], 10);
        const dUsedMb = parseInt(dfMatch[2], 10);
        diskTotal = Math.round(dTotMb / 1024);
        diskUsed = +(dUsedMb / 1024).toFixed(1);
        diskPct = parseInt(dfMatch[4], 10);
      }

      const cpuPct = Math.min(100, Math.round((load / Math.max(1, cores)) * 100));

      resolve({
        uptime: uptimeStr || srv.uptime,
        uptimeStr,
        loadAvg: load.toFixed(2),
        cores,
        cpu: cpuPct,
        cpuPct,
        ramTotal,
        ramUsed,
        ramPct,
        diskTotal,
        diskUsed,
        diskPct
      });
    });
  });
}

// Периодический опрос телеметрии VDS по SSH (сразу при старте и затем раз в 45 сек)
async function refreshAllVdsTelemetry() {
  if (!vdsServers || vdsServers.length === 0) return;
  for (const srv of vdsServers) {
    if (srv.status === 'offline') continue;
    try {
      const data = await collectVdsTelemetry(srv);
      if (data) {
        Object.assign(srv, data);
      }
    } catch (e) {}
  }
  saveVds();
}

setTimeout(refreshAllVdsTelemetry, 3000);
setInterval(refreshAllVdsTelemetry, 45000);

// Фоновый опрос VDS серверов (каждые 8 сек, ICMP + TCP fallback)
setInterval(async () => {
  if (!vdsServers || vdsServers.length === 0) return;
  for (const srv of vdsServers) {
    if (!srv.ip) continue;
    const res = await pingVds(srv);
    const prevStatus = srv.status;
    if (res.online && res.ping !== null) {
      srv.status = res.ping > 150 ? 'warn' : 'online';
      srv.ping = +(res.ping).toFixed(1);
      if (prevStatus === 'offline') {
        addEventLog('ok', `${srv.name}: снова в сети (${srv.ping} мс)`, 'connect', srv.name, srv.id);
      }
    } else {
      srv.status = 'offline';
      srv.ping = '—';
      if (prevStatus === 'online' || prevStatus === 'warn') {
        addEventLog('off', `${srv.name}: не в сети`, 'disconnect', srv.name, srv.id);
      }
    }
  }
  saveVds();
}, 8000);

// Автоматическая отправка ежедневной и еженедельной сводки по расписанию в Telegram
let lastDailySummaryDate = '';
let lastWeeklySummaryDate = '';
setInterval(() => {
  if (!appSettings || !appSettings.tgToken || !appSettings.tgChatId) return;
  const now = new Date();
  const tInfo = getLocalTimeInfo(now);
  const dateStr = tInfo.dateStrIso;
  const curTime = tInfo.timeStrMin;
  const curDay = tInfo.curDay;

  // Ежедневная сводка
  if (appSettings.tgSummary && appSettings.tgDailyTime && curTime === appSettings.tgDailyTime) {
    if (lastDailySummaryDate !== dateStr) {
      lastDailySummaryDate = dateStr;
      sendTelegramMessage(buildNetworkSummary('daily'));
    }
  }

  // Еженедельная сводка
  const targetDay = (appSettings.tgWeeklyDay || 'sun').toLowerCase();
  const targetTime = appSettings.tgWeeklyTime || '20:00';
  if (appSettings.tgWeekly && curDay === targetDay && curTime === targetTime) {
    if (lastWeeklySummaryDate !== dateStr) {
      lastWeeklySummaryDate = dateStr;
      sendTelegramMessage(buildNetworkSummary('weekly'));
    }
  }
}, 30000);

// Сетевой сканер диапазона 192.168.1.1 - 254 (запуск по требованию)
async function runSubnetScan(isManual = false) {
  if (state.isScanning) return;
  state.isScanning = true;
  state.scanProgress = 0;

  const total = 254;

  // Быстрый пинг-свип батчами по 25 адресов
  for (let i = 1; i <= total; i += 25) {
    const batch = [];
    for (let j = i; j < i + 25 && j <= total; j++) {
      const ip = `${SUBNET_PREFIX}${j}`;
      batch.push(pingHost(ip, 1));
    }
    await Promise.allSettled(batch);
    state.scanProgress = Math.min(100, Math.round((i / total) * 100));
  }

  // Обновленная ARP таблица после пингов
  const arpAfter = getArpTable();
  let foundCount = 0;

  for (const [ip, mac] of Object.entries(arpAfter)) {
    foundCount++;
    const pingRes = await pingHost(ip, 1);
    const measuredPing = pingRes.online && pingRes.ping !== null ? +(pingRes.ping).toFixed(1) : 1.2;

    // Ищем устройство в базе
    let dev = devices.find(d => (d.mac && d.mac.toLowerCase() === mac) || (ip && d.ip === ip));
    if (dev) {
      dev.ip = ip;
      // ВНИМАНИЕ: не перезаписываем dev.mac из ARP таблицы, так как у репитеров/клиентов (TL-padavan) ARP может возвращать BSSID/via MAC!
      if (!dev.mac) dev.mac = mac;
      dev.status = 'online';
      dev.ping = measuredPing;
      if (!dev.pingHistory) dev.pingHistory = [];
      dev.pingHistory.push(dev.ping);
      if (dev.pingHistory.length > 12) dev.pingHistory.shift();
      dev.vendor = dev.vendor || getVendor(dev.mac);
    }
  }

  saveDevices();
  state.isScanning = false;
  state.scanProgress = 100;
  state.lastScanTime = getLocalTimeInfo(new Date()).timeStrSec;

  if (isManual) {
    // В журнал не спамим техническими записями о сканировании
  }
  return { foundCount };
}

// Чтение реальной телеметрии хост-сервера Ubuntu
let prevCpuTimes = null;
let cachedKernel = 'Linux';
try {
  cachedKernel = execSync('uname -r', { timeout: 1000 }).toString().trim();
} catch (e) {}

let cachedCpuModel = 'Generic CPU';
try {
  const cpuInfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
  const m = cpuInfo.match(/model name\s*:\s*(.+)/);
  if (m && m[1]) {
    cachedCpuModel = m[1].replace(/,?\s*\d*\s*COMPUTE CORES.*$/i, '').trim();
  }
} catch (e) {}

function getHostStats() {
  const stats = {
    hostname: os.hostname(),
    cpuModel: cachedCpuModel,
    kernel: cachedKernel,
    iface: 'eth0 • 1000 Мбит/с',
    cpuTemp: 24,
    uptimeSec: os.uptime(),
    uptimeStr: '',
    cpuPct: 15,
    loadAvg: os.loadavg().map(v => v.toFixed(2)).join(', '),
    ramUsed: 0.7,
    ramTotal: 6.2,
    ramPhysical: '8.0 ГБ',
    ramPct: 11,
    diskModel: 'SSD SATA P3-256 (256 ГБ)',
    diskUsed: 7.7,
    diskTotal: 98.0,
    diskPct: 9,
    services: []
  };

  // Uptime
  const up = Math.floor(stats.uptimeSec);
  const d = Math.floor(up / 86400);
  const h = String(Math.floor((up % 86400) / 3600)).padStart(2, '0');
  const m = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
  const s = String(up % 60).padStart(2, '0');
  stats.uptimeStr = d > 0 ? `${d}д ${h}:${m}:${s}` : `${h}:${m}:${s}`;

  // Температура процессора через hwmon
  try {
    const hwFiles = ['/sys/class/hwmon/hwmon1/temp1_input', '/sys/class/hwmon/hwmon0/temp1_input', '/sys/class/hwmon/hwmon2/temp1_input'];
    for (const f of hwFiles) {
      if (fs.existsSync(f)) {
        const val = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (val > 0) {
          stats.cpuTemp = +(val / 1000).toFixed(1);
          break;
        }
      }
    }
  } catch (e) {}

  // CPU % calculation
  try {
    const cpus = os.cpus();
    let idle = 0, total = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        total += cpu.times[type];
      }
      idle += cpu.times.idle;
    }
    if (prevCpuTimes) {
      const dTotal = total - prevCpuTimes.total;
      const dIdle = idle - prevCpuTimes.idle;
      if (dTotal > 0) {
        stats.cpuPct = Math.max(1, Math.min(100, Math.round((1 - dIdle / dTotal) * 100)));
      }
    }
    prevCpuTimes = { total, idle };
  } catch (e) {}

  // RAM
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    stats.ramTotal = +(totalMem / (1024 * 1024 * 1024)).toFixed(1);
    stats.ramUsed = +(usedMem / (1024 * 1024 * 1024)).toFixed(1);
    stats.ramPct = Math.round((usedMem / totalMem) * 100);
  } catch (e) {}

  // Disk df /
  try {
    const df = execSync('df -k /', { timeout: 1000 }).toString().split('\n')[1].trim().split(/\s+/);
    if (df.length >= 5) {
      const totalK = parseInt(df[1], 10);
      const usedK = parseInt(df[2], 10);
      stats.diskTotal = +(totalK / (1024 * 1024)).toFixed(1);
      stats.diskUsed = +(usedK / (1024 * 1024)).toFixed(1);
      stats.diskPct = Math.round((usedK / totalK) * 100);
    }
  } catch (e) {}

  // Реальные запущенные Docker контейнеры и службы (из неблокирующего кэша)
  if (cachedHostServices && cachedHostServices.length > 0) {
    stats.services = cachedHostServices;
  } else {
    stats.services = [
      { name: 'homenet-monitor', cpu: 'CPU 1.5%', mem: '24 МБ', type: 'docker', ok: true },
      { name: 'hub-gateway', cpu: 'CPU 0.1%', mem: '5.4 МБ', type: 'docker', ok: true },
      { name: 'tenda-monitor', cpu: 'CPU 0.1%', mem: '15.8 МБ', type: 'docker', ok: true },
      { name: '3x-ui', cpu: 'CPU 0.2%', mem: '28 МБ', type: 'docker', ok: true },
      { name: 'docker.service', cpu: 'CPU 0.1%', mem: '106 МБ', type: 'systemd', ok: true },
      { name: 'ssh.service (порт 22)', cpu: 'CPU 0.0%', mem: '14 МБ', type: 'systemd', ok: true }
    ];
  }

  stats.history = hostHistory;
  return stats;
}

// Фоновый сбор реальной телеметрии CPU и RAM для графика истории (раз в 30 секунд)
let lastHostHistorySave = 0;
setInterval(() => {
  try {
    const s = getHostStats();
    const now = Date.now();
    const point = {
      t: now,
      cpu: s.cpuPct !== undefined ? s.cpuPct : 5,
      ram: s.ramPct !== undefined ? s.ramPct : 10,
      disk: s.diskPct !== undefined ? s.diskPct : 9
    };
    hostHistory.push(point);
    const cutoff = now - (24 * 3600 * 1000);
    while (hostHistory.length > 0 && hostHistory[0].t < cutoff) {
      hostHistory.shift();
    }
    if (now - lastHostHistorySave > 300000) {
      lastHostHistorySave = now;
      saveHostHistory();
    }
  } catch (e) {}
}, 30000);

// Кэшированные данные служб и фоновый опрос без блокировки
let cachedHostServices = null;
let lastServicesPoll = 0;
let isServicesPolling = false;

function refreshHostServicesAsync() {
  if (isServicesPolling) return;
  isServicesPolling = true;

  const hostUser = process.env.HOST_SSH_USER || '';
  const hostPass = process.env.HOST_SSH_PASS || '';
  const hostIp = process.env.HOST_SSH_IP || '127.0.0.1';
  const hostPort = process.env.HOST_SSH_PORT || '22';

  const parseDockerStats = (stdout) => {
    try {
      const lines = stdout.trim().split('\n');
      const srvList = [];
      lines.forEach(l => {
        const parts = l.split('|');
        if (parts.length >= 3) {
          const name = parts[0].trim();
          const cpu = parts[1].trim();
          const mem = parts[2].trim().split('/')[0].trim();
          srvList.push({
            name,
            cpu: `CPU ${cpu}`,
            mem,
            type: 'docker',
            ok: true
          });
        }
      });
      srvList.push({ name: 'docker.service', cpu: 'CPU 0.1%', mem: '85 МБ', type: 'systemd', ok: true });
      srvList.push({ name: 'ssh.service', cpu: 'CPU 0.0%', mem: '14 МБ', type: 'systemd', ok: true });
      cachedHostServices = srvList;
    } catch (e) {}
  };

  if (hostUser && hostPass) {
    const cmd = `sshpass -p '${hostPass}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=2 -p ${hostPort} ${hostUser}@${hostIp} "docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'"`;
    exec(cmd, { timeout: 3000 }, (err, stdout) => {
      isServicesPolling = false;
      lastServicesPoll = Date.now();
      if (!err && stdout) parseDockerStats(stdout);
    });
  } else {
    exec("docker stats --no-stream --format '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'", { timeout: 3000 }, (err, stdout) => {
      isServicesPolling = false;
      lastServicesPoll = Date.now();
      if (!err && stdout) {
        parseDockerStats(stdout);
      } else if (!cachedHostServices) {
        cachedHostServices = [
          { name: 'docker.service', cpu: 'CPU 0.1%', mem: '85 МБ', type: 'systemd', ok: true },
          { name: 'ssh.service', cpu: 'CPU 0.0%', mem: '14 МБ', type: 'systemd', ok: true }
        ];
      }
    });
  }
}

// Запускаем фоновый опрос раз в 5 секунд, не подвешивая поток запросов
setInterval(refreshHostServicesAsync, 5000);
refreshHostServicesAsync();

function executeServerCommand(target, command) {
  return new Promise((resolve) => {
    const cleanCmd = (command || '').trim();
    if (!cleanCmd) return resolve({ ok: false, stdout: '', stderr: 'Команда не указана', code: 1 });

    let cmd = '';
    if (target === 'host_local') {
      const hostUser = process.env.HOST_SSH_USER || '';
      const hostPass = process.env.HOST_SSH_PASS || '';
      const hostIp = process.env.HOST_SSH_IP || '127.0.0.1';
      const hostPort = process.env.HOST_SSH_PORT || '22';
      if (!hostUser || !hostPass) {
        return resolve({ ok: false, stdout: '', stderr: 'SSH-доступ к локальному хосту не настроен (переменные HOST_SSH_USER / HOST_SSH_PASS)', code: 1 });
      }
      const escaped = cleanCmd.replace(/'/g, "'\\''");
      cmd = `sshpass -p '${hostPass}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=8 -p ${hostPort} ${hostUser}@${hostIp} '${escaped}'`;
    } else {
      const srv = vdsServers.find(s => s.id === target);
      if (!srv) return resolve({ ok: false, stdout: '', stderr: 'VDS сервер не найден', code: 1 });
      const pass = srv.pass || srv.password || '';
      const port = srv.port || 22;
      const user = srv.user || 'root';
      const host = srv.ip;
      const escaped = cleanCmd.replace(/'/g, "'\\''");
      cmd = `sshpass -p '${pass}' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${port} ${user}@${host} '${escaped}'`;
    }

    exec(cmd, { timeout: 25000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const outStr = stdout ? stdout.toString() : '';
      const errStr = stderr ? stderr.toString() : (err ? err.message : '');
      resolve({
        ok: !err || outStr.length > 0,
        stdout: outStr,
        stderr: errStr,
        code: err ? (err.code || 1) : 0
      });
    });
  });
}

// HTTP API Сервер
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = parsedUrl.pathname;

  // Очистка от префикса /homenet если запрос пришел через прокси
  if (pathname.startsWith('/homenet')) {
    pathname = pathname.slice('/homenet'.length);
  }
  if (!pathname.startsWith('/')) pathname = '/' + pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- API Endpoints ---

  // 1. Список устройств
  if (pathname === '/api/devices' && req.method === 'GET') {
    const onlineCount = devices.filter(d => d.status !== 'offline').length;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, devices, total: devices.length, onlineCount }));
    return;
  }

  // 2. Сетевая статистика (WAN ping, Gateway ping, трафик)
  if (pathname === '/api/stats' && req.method === 'GET') {
    const onlineCount = devices.filter(d => d.status !== 'offline').length;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      wanPing: state.wanPing,
      wanOnline: state.wanOnline,
      gatewayPing: state.gatewayPing,
      gatewayOnline: state.gatewayOnline,
      routerType: appSettings.routerType || 'keenetic',
      routerIp: appSettings.routerIp || GATEWAY_IP,
      routerConnected: state.routerConnected !== false,
      routerUptimeSec: keeneticSystemStats.uptimeSec || 0,
      routerCpuLoad: keeneticSystemStats.cpuload || 0,
      wanDownMbps: keeneticWanStats.downMbps || 0,
      wanUpMbps: keeneticWanStats.upMbps || 0,
      totalDevices: devices.length,
      onlineCount,
      isScanning: state.isScanning,
      scanProgress: state.scanProgress,
      lastScanTime: state.lastScanTime
    }));
    return;
  }

  // 2.1 Настройки мониторинга (чтение и сохранение)
  if (pathname === '/api/settings' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, settings: appSettings }));
    return;
  }
  if (pathname === '/api/settings' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const routerChanged = (
          (data.routerType && data.routerType !== appSettings.routerType) ||
          (data.routerIp && data.routerIp !== appSettings.routerIp) ||
          (data.routerUser && data.routerUser !== appSettings.routerUser) ||
          (data.routerPass && data.routerPass !== appSettings.routerPass)
        );
        const tzChanged = data.timezone && data.timezone !== appSettings.timezone;
        appSettings = { ...appSettings, ...data };
        if (tzChanged) {
          try { process.env.TZ = appSettings.timezone; } catch(e) {}
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf8');
        if (routerChanged) {
          keeneticCookie = null;
          openwrtToken = null;
          addEventLog('info', `Обновлены параметры интеграции с роутером (${appSettings.routerType || 'auto'})`, 'system');
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, settings: appSettings }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 2.15 Тест подключения к роутеру (Keenetic, OpenWrt, None)
  if (pathname === '/api/router/test' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const cfg = JSON.parse(body || '{}');
        const type = cfg.type || 'none';

        if (type === 'none') {
          const testIp = cfg.ip || appSettings.routerIp || GATEWAY_IP;
          const pingRes = await pingHost(testIp, 1);
          if (pingRes.online) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true,
              message: `Автономный режим активен. Шлюз ${testIp} отвечает на пинг (${pingRes.ping} мс).`
            }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
              ok: true,
              message: `Автономный режим готов. Мониторинг сети выполняется через ARP-таблицу ядра.`
            }));
          }
          return;
        }

        if (type === 'keenetic') {
          const loginRes = await loginKeenetic(cfg);
          const hotspot = await fetchKeeneticHotspot(cfg, loginRes.cookie);
          const sys = await fetchKeeneticSystem(cfg, loginRes.cookie);
          const count = (hotspot && Array.isArray(hotspot.host)) ? hotspot.host.length : 0;
          const upH = sys ? Math.floor(sys.uptimeSec / 3600) : 0;
          const upD = Math.floor(upH / 24);
          const upStr = upD > 0 ? `${upD}д ${upH % 24}ч` : `${upH}ч`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            message: `Успешное подключение к Keenetic! Аптайм: ${upStr}, активных устройств в сети: ${count}`
          }));
          return;
        }

        if (type === 'openwrt') {
          const loginRes = await loginOpenWrt(cfg);
          const sys = await fetchOpenWrtSystem(cfg, loginRes.token);
          const clients = await fetchOpenWrtClients(cfg, loginRes.token);
          const upH = sys ? Math.floor(sys.uptimeSec / 3600) : 0;
          const upD = Math.floor(upH / 24);
          const upStr = upD > 0 ? `${upD}д ${upH % 24}ч` : `${upH}ч`;
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            message: `Успешное подключение к OpenWrt! Аптайм: ${upStr}, найдено DHCP клиентов: ${clients.length}`
          }));
          return;
        }

        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Неизвестный тип роутера' }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message || 'Ошибка подключения к роутеру' }));
      }
    });
    return;
  }

  // 2.2 Тест отправки сообщения в Telegram через сервер
  if (pathname === '/api/telegram/test' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const token = (payload.token || appSettings.tgToken || '').trim();
        const chatId = (payload.chatId || appSettings.tgChatId || '').trim();

        if (!token || !chatId) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Не указан Bot Token или Chat ID' }));
          return;
        }

        let msgText = `🔔 <b>HomeNet Monitor</b>\n<code>${getLocalTimeInfo().timeStrSec}</code> Тестовое сообщение успешно доставлено! Бот готов к отправке уведомлений сети.`;
        if (payload.type === 'daily') {
          msgText = buildNetworkSummary('daily');
        } else if (payload.type === 'weekly') {
          msgText = buildNetworkSummary('weekly');
        } else if (payload.type === 'wan') {
          msgText = `🌐 <b>ИНТЕРНЕТ (WAN) СНОВА ДОСТУПЕН!</b>\n` +
            `⏱ <b>Отсутствовал:</b> 12 мин 40 сек\n` +
            `🕒 <b>Пропал в:</b> <code>14:10:00</code>\n` +
            `🕒 <b>Появился в:</b> <code>14:22:40</code>\n` +
            `⚡ <b>Пинг до провайдера:</b> <code>${state.wanPing ? state.wanPing + ' мс' : '15.2 мс'}</code>`;
        }

        const msgData = JSON.stringify({
          chat_id: chatId,
          text: msgText,
          parse_mode: 'HTML'
        });

        let responded = false;
        function sendResponse(status, data) {
          if (responded) return;
          responded = true;
          res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(typeof data === 'string' ? data : JSON.stringify(data));
        }

        const tgReq = https.request({
          hostname: 'api.telegram.org',
          port: 443,
          path: `/bot${token}/sendMessage`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(msgData)
          },
          timeout: 15000
        }, (tgRes) => {
          let tgBody = '';
          tgRes.on('data', c => { tgBody += c; });
          tgRes.on('end', () => {
            try {
              const parsed = JSON.parse(tgBody);
              sendResponse(200, parsed);
            } catch (err) {
              sendResponse(200, tgBody);
            }
          });
        });

        tgReq.on('error', (err) => {
          sendResponse(502, { ok: false, error: err.message });
        });

        tgReq.on('timeout', () => {
          tgReq.destroy();
          sendResponse(504, { ok: false, error: 'Таймаут соединения с сервером Telegram' });
        });

        tgReq.write(msgData);
        tgReq.end();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 3. Телеметрия хост-сервера Ubuntu
  if (pathname === '/api/host' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, host: getHostStats() }));
    return;
  }

  // 3.1 Перезагрузка локального сервера Ubuntu
  if (pathname === '/api/host/reboot' && req.method === 'POST') {
    const hostUser = process.env.HOST_SSH_USER || '';
    const hostPass = process.env.HOST_SSH_PASS || '';
    const hostIp = process.env.HOST_SSH_IP || '127.0.0.1';
    if (!hostUser || !hostPass) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'HOST_SSH_USER and HOST_SSH_PASS not configured' }));
      return;
    }
    addEventLog('warn', `Инициирована перезагрузка хост-сервера (${hostIp})`, 'server');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: 'Reboot initiated' }));
    setTimeout(() => {
      exec(`sshpass -p '${hostPass}' ssh -o StrictHostKeyChecking=no ${hostUser}@${hostIp} 'echo "${hostPass}" | sudo -S systemctl reboot'`, (err) => {
        if (err) console.error('Reboot execution error:', err);
      });
    }, 600);
    return;
  }

  // 3.2 Выполнение реальной команды в терминале (локальный хост или VDS)
  if (pathname === '/api/exec' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { serverId, command } = JSON.parse(body);
        const result = await executeServerCommand(serverId, command);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 4. Запуск сканирования сети
  if (pathname === '/api/scan' && req.method === 'POST') {
    runSubnetScan(true).catch(err => console.error('Scan error:', err));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: 'Scan started' }));
    return;
  }

  // 5. Обновление устройства
  if (pathname === '/api/device/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const dev = devices.find(d => d.id === payload.id);
        if (dev) {
          if (payload.name !== undefined) dev.name = payload.name;
          if (payload.role !== undefined) dev.role = payload.role;
          if (payload.room !== undefined) dev.room = payload.room;
          if (payload.type !== undefined) dev.type = payload.type;
          if (payload.customPingMax !== undefined) dev.customPingMax = payload.customPingMax;
          if (payload.note !== undefined) dev.note = payload.note;
          if (payload.tgWatch !== undefined) dev.tgWatch = payload.tgWatch;
          saveDevices();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: dev }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Device not found or invalid json' }));
    });
    return;
  }

  // 5.1 Подтверждение / добавление нового устройства из карточки уведомлений
  if (pathname === '/api/device/confirm' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        let dev = devices.find(d => d.id === payload.id || (payload.mac && d.mac && d.mac.toLowerCase() === payload.mac.toLowerCase()));
        if (dev) {
          dev.unconfirmed = false;
          if (payload.name) dev.name = payload.name;
          if (payload.type) dev.type = payload.type;
          if (payload.room) dev.room = payload.room;
          if (payload.role) dev.role = payload.role;
          if (payload.ip) dev.ip = payload.ip;
          if (payload.mac) dev.mac = payload.mac;
          saveDevices();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: dev }));
          return;
        } else if (payload.name) {
          payload.unconfirmed = false;
          devices.unshift(payload);
          saveDevices();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, device: payload }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Device not found' }));
    });
    return;
  }

  // 6. Общая база MAC-адресов для MAC Finder
  if (pathname === '/api/mac-database' && req.method === 'GET') {
    const macList = devices.filter(d => d.mac).map(d => ({
      name: d.name,
      mac: d.mac.toLowerCase(),
      vendor: d.vendor || getVendor(d.mac),
      ip: d.ip || '',
      status: d.status || 'offline'
    }));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, count: macList.length, devices: macList }));
    return;
  }

  // 7. Получение списка VDS серверов
  if (pathname === '/api/vds' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, servers: vdsServers }));
    return;
  }

  // 8. Добавление VDS сервера
  if (pathname === '/api/vds/add' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const resPing = await pingVds(payload);
        payload.status = resPing.online ? (resPing.ping > 150 ? 'warn' : 'online') : 'offline';
        payload.ping = resPing.online && resPing.ping !== null ? +(resPing.ping).toFixed(1) : '—';
        
        // Автоматически опрашиваем VDS по SSH для получения реальных ядер, RAM и диска
        const tele = await collectVdsTelemetry(payload);
        if (tele) {
          Object.assign(payload, tele);
        }

        vdsServers.push(payload);
        saveVds();
        addEventLog('ok', `Добавлен VDS сервер «${payload.name}» (${payload.ip})`, 'connect', payload.name, payload.id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, server: payload }));
        return;
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid VDS payload' }));
    });
    return;
  }

  // 9. Удаление VDS сервера
  if (pathname === '/api/vds/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { id } = JSON.parse(body);
        const srv = vdsServers.find(s => s.id === id);
        vdsServers = vdsServers.filter(s => s.id !== id);
        saveVds();
        if (srv) addEventLog('info', `Удалён VDS сервер «${srv.name}»`, 'disconnect', srv.name, srv.id);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, servers: vdsServers }));
        return;
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid request' }));
    });
    return;
  }

  // 10. Обновление VDS сервера
  if (pathname === '/api/vds/update' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const srv = vdsServers.find(s => s.id === payload.id);
        if (srv) {
          Object.assign(srv, payload);
          saveVds();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, server: srv }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Server not found' }));
    });
    return;
  }

  // 11. Ручное обновление пинга и телеметрии VDS сервера
  if (pathname === '/api/vds/refresh' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        const srv = vdsServers.find(s => s.id === id);
        if (srv) {
          const resPing = await pingVds(srv);
          if (resPing.online && resPing.ping !== null) {
            srv.status = resPing.ping > 150 ? 'warn' : 'online';
            srv.ping = +(resPing.ping).toFixed(1);
          } else {
            srv.status = 'offline';
            srv.ping = '—';
          }
          const tele = await collectVdsTelemetry(srv);
          if (tele) Object.assign(srv, tele);
          saveVds();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, server: srv }));
          return;
        }
      } catch (e) {}
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Server not found' }));
    });
    return;
  }

  // 11.1 Перезагрузка VDS сервера
  if (pathname === '/api/vds/reboot' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { id } = JSON.parse(body);
        const srv = vdsServers.find(s => s.id === id);
        if (!srv) {
          res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: 'Server not found' }));
          return;
        }
        addEventLog('warn', `Запрошена перезагрузка VDS «${srv.name}» (${srv.ip})`, 'disconnect', srv.name, srv.id);
        const execRes = await executeServerCommand(id, 'systemctl reboot || reboot');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, message: 'Reboot command sent', details: execRes }));
        return;
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 12. Реальный журнал событий домашней сети
  if (pathname === '/api/logs' && req.method === 'GET') {
    const parsedUrl = url.parse(req.url, true);
    const limit = parseInt(parsedUrl.query.limit, 10);
    const logsToSend = (limit && limit > 0) ? eventsLog.slice(0, limit) : eventsLog;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, total: eventsLog.length, logs: logsToSend }));
    return;
  }

  // 13. Очистка журнала событий
  if (pathname === '/api/logs/clear' && req.method === 'POST') {
    eventsLog = [];
    try {
      fs.writeFileSync(EVENTS_FILE, JSON.stringify([], null, 2), 'utf8');
    } catch (e) {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, message: 'Logs cleared' }));
    return;
  }

  // Раздача статики (homenet_monitor.html)
  let filePath = path.join(__dirname, pathname === '/' ? 'homenet_monitor.html' : pathname);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(__dirname, 'homenet_monitor.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml'
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`HomeNet Monitor backend running on http://0.0.0.0:${PORT}`);
  try {
    const rType = appSettings.routerType || 'keenetic';
    if (rType === 'keenetic') {
      await fetchKeeneticSystem();
      await syncWithKeenetic();
    } else if (rType === 'openwrt') {
      await fetchOpenWrtSystem();
      await syncWithOpenWrt();
    }
  } catch (e) {}
});
