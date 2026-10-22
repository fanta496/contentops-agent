'use strict';
// 无状态的小工具。这里只放不碰业务状态的纯函数，方便任何模块直接引用。

const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function finiteNumber(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, min, max) : fallback;
}
function safeText(value, max = 500) { return String(value ?? '').trim().slice(0, max); }
function promptText(value, max = 6000) { return String(value ?? '').slice(0, max); }

function localDay(date = new Date()) { return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }); }
function localClock(date = new Date()) { return date.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }); }
function normalizeClock(value, fallback) {
  const match = String(value || '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1].padStart(2, '0')}:${match[2]}` : fallback;
}

function normalizeKeywords(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n,，]+/);
  return [...new Set(source.map((item) => safeText(item, 60)).filter(Boolean))].slice(0, 30);
}
function normalizeTextList(value, maxItems = 30, maxLength = 300) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\r\n]+/);
  return [...new Set(source.map((item) => safeText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

module.exports = {
  now, uid, clamp, sleep,
  finiteNumber, safeText, promptText,
  localDay, localClock, normalizeClock,
  normalizeKeywords, normalizeTextList
};
