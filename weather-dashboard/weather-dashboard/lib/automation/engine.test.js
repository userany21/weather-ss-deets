'use strict';
// Run: node --test lib/automation/
const test = require('node:test');
const assert = require('node:assert/strict');
const e = require('./engine.js');

const utc = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h, mi));

// ---- the clock ---------------------------------------------------------------------------

test('closing minute matches the schedule table for every cadence group', () => {
  const expected = {
    'san francisco': 45, seattle: 45, 'los angeles': 45, nyc: 45, atlanta: 45, miami: 45,
    'hong kong': 59,
    beijing: 30, shanghai: 30, tokyo: 30, seoul: 30, singapore: 30, madrid: 30, paris: 30,
    shenzhen: 0,
    london: 50, munich: 50, milan: 50,
    amsterdam: 55,
  };
  assert.equal(Object.keys(expected).length, Object.keys(e.CITY_SCHEDULE).length);
  for (const [city, minute] of Object.entries(expected)) {
    assert.equal(e.closingMinute(city), minute, city);
  }
});

test('ticks inside an hour', () => {
  assert.deepEqual(e.ticksInHour('hong kong'), [9, 19, 29, 39, 49, 59]);
  assert.deepEqual(e.ticksInHour('seoul'), [0, 30]);
  assert.deepEqual(e.ticksInHour('shenzhen'), [0]);
  assert.deepEqual(e.ticksInHour('london'), [20, 50]);
  assert.deepEqual(e.ticksInHour('amsterdam'), [25, 55]);
  assert.deepEqual(e.ticksInHour('nyc'), [0, 15, 30, 45]);
});

test('Seoul has no 11:45 tick, so its close is 11:30', () => {
  assert.ok(!e.ticksInHour('seoul').includes(45));
  assert.equal(e.closingMinute('seoul'), 30);
});

test('unknown city', () => {
  assert.equal(e.closingMinute('atlantis'), null);
  assert.equal(e.closingMinute('constructor'), null);
});

test('parsePacingTime', () => {
  assert.deepEqual(e.parsePacingTime('11:30 AM'), { hour24: 11, minute: 30 });
  assert.deepEqual(e.parsePacingTime('12:00 PM'), { hour24: 12, minute: 0 });
  assert.deepEqual(e.parsePacingTime('12:15 AM'), { hour24: 0, minute: 15 });
  assert.deepEqual(e.parsePacingTime('5:59 pm'), { hour24: 17, minute: 59 });
  assert.equal(e.parsePacingTime('25:00 AM'), null);
  assert.equal(e.parsePacingTime('nonsense'), null);
  assert.equal(e.parsePacingTime(null), null);
});

test('formatLabel round trips', () => {
  assert.equal(e.formatLabel(11, 30), '11:30 AM');
  assert.equal(e.formatLabel(12, 0), '12:00 PM');
  assert.equal(e.formatLabel(17, 59), '5:59 PM');
});

// ---- classification ----------------------------------------------------------------------

test('"Rank 1 before 12PM" decides on the 11AM bucket', () => {
  const cls = e.classifyBy(e.parseBy('rank_at_hour:4'));
  assert.deepEqual(cls, { kind: 'closing', bucket: 3 });
});

test('price_at_hour reads inside its own hour', () => {
  assert.deepEqual(e.classifyBy(e.parseBy('price_at_hour:4')), { kind: 'closing', bucket: 4 });
});

test('mixed dimensions use the latest bucket', () => {
  assert.deepEqual(e.classifyBy(e.parseBy('rank_at_hour:4,price_at_hour:4')), { kind: 'closing', bucket: 4 });
  assert.deepEqual(e.classifyBy(e.parseBy('lead_margin:6,rank_trend:4,city')), { kind: 'closing', bucket: 5 });
  assert.deepEqual(e.classifyBy(e.parseBy('rank_at_hour:6,price_at_hour:4')), { kind: 'closing', bucket: 5 });
});

test('every as-of dimension shifts by one hour', () => {
  for (const id of ['rank_at_hour', 'leader', 'lead_margin', 'rank_trend']) {
    assert.deepEqual(e.classifyBy(e.parseBy(`${id}:5`)), { kind: 'closing', bucket: 4 }, id);
  }
});

test('a missing number uses the same registry default as /api/scan', () => {
  assert.deepEqual(e.classifyBy(e.parseBy('rank_at_hour')), { kind: 'closing', bucket: 0 });
  assert.deepEqual(e.classifyBy(e.parseBy('price_at_hour')), { kind: 'closing', bucket: 2 });
  assert.deepEqual(e.classifyBy(e.parseBy('rank_trend')), { kind: 'closing', bucket: 3 });
  assert.deepEqual(e.classifyBy(e.parseBy('lead_margin:4')), { kind: 'closing', bucket: 3 });
});

test('end-of-day dimensions are never tradeable', () => {
  assert.equal(e.classifyBy(e.parseBy('final_rank')).kind, 'never');
  assert.equal(e.classifyBy(e.parseBy('rank_at_hour:4,final_tick_count')).kind, 'never');
});

test('untimed pins decide on the first tick', () => {
  assert.deepEqual(e.classifyBy(e.parseBy('city')), { kind: 'first_tick' });
  assert.deepEqual(e.classifyBy(e.parseBy('price:5,first_tick_hour')), { kind: 'first_tick' });
});

test('bad hours and unknown dimensions are rejected', () => {
  assert.equal(e.classifyBy(e.parseBy('rank_at_hour:0')).kind, 'never');
  assert.equal(e.classifyBy(e.parseBy('rank_at_hour:10')).kind, 'never');
  assert.equal(e.classifyBy(e.parseBy('rank_at_hour:4.5')).kind, 'never');
  assert.throws(() => e.parseBy('bogus:1'));
  assert.throws(() => e.parseBy(''));
});

// ---- gate --------------------------------------------------------------------------------

const closing11 = e.classifyBy(e.parseBy('rank_at_hour:4'));
const tick = (label, at) => ({ pacing_time: label, captured_at: at, bracket: '68-69°F', yes_price_cents: 40 });

test('Seoul: not yet at 11:15, ready at 11:31 on the 11:30 tick', () => {
  // Seoul is UTC+9: 11:15 local = 02:15Z
  assert.equal(e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 15), ticks: [] }).state, 'not_yet');
  const r = e.gate({
    cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 31),
    ticks: [tick('11:00 AM', utc(2026, 11, 4, 2, 1)), tick('11:30 AM', utc(2026, 11, 4, 2, 31))],
  });
  assert.equal(r.state, 'ready');
  assert.equal(r.label, '11:30 AM');
  assert.equal(r.localDate, '2026-11-04');
});

test('Seoul: the 11:00 tick alone is not the closing tick', () => {
  const r = e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 32), ticks: [tick('11:00 AM', utc(2026, 11, 4, 2, 1))] });
  assert.equal(r.state, 'missing');
});

test('Seoul never fires off an 11:45 label', () => {
  const r = e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 46), ticks: [tick('11:45 AM', utc(2026, 11, 4, 2, 46))] });
  assert.notEqual(r.state, 'ready');
});

test('a tick labelled 11:30 written at 11:36 still counts (label, not captured_at)', () => {
  const r = e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 37), ticks: [tick('11:30 AM', utc(2026, 11, 4, 2, 36))] });
  assert.equal(r.state, 'ready');
});

test('stale and expired', () => {
  // closing tick captured 13 minutes ago, limit 12 -> stale
  const stale = e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 2, 48), ticks: [tick('11:30 AM', utc(2026, 11, 4, 2, 35))] });
  assert.equal(stale.state, 'stale');
  // 12:00 local is 30 minutes after the label, past the 20 minute grace
  const expired = e.gate({ cls: closing11, city: 'seoul', now: utc(2026, 11, 4, 3, 0), ticks: [tick('11:30 AM', utc(2026, 11, 4, 2, 35))] });
  assert.equal(expired.state, 'expired');
});

test('US city closes at 11:45 Pacific', () => {
  // PST in November: UTC-8. 11:46 local = 19:46Z
  const ok = e.gate({ cls: closing11, city: 'san francisco', now: utc(2026, 11, 4, 19, 46), ticks: [tick('11:45 AM', utc(2026, 11, 4, 19, 46))] });
  assert.equal(ok.state, 'ready');
  const missing = e.gate({ cls: closing11, city: 'san francisco', now: utc(2026, 11, 4, 19, 46), ticks: [tick('11:30 AM', utc(2026, 11, 4, 19, 31))] });
  assert.equal(missing.state, 'missing');
});

test('Hong Kong closes at 11:59 and the window crosses into 12:0x', () => {
  // HKT is UTC+8. 12:02 local = 04:02Z
  const r = e.gate({ cls: closing11, city: 'hong kong', now: utc(2026, 11, 4, 4, 2), ticks: [tick('11:59 AM', utc(2026, 11, 4, 4, 1))] });
  assert.equal(r.state, 'ready');
  assert.equal(r.label, '11:59 AM');
});

test('Shenzhen has one 11AM tick and it is the close', () => {
  const r = e.gate({ cls: closing11, city: 'shenzhen', now: utc(2026, 11, 4, 3, 5), ticks: [tick('11:00 AM', utc(2026, 11, 4, 3, 2))] });
  assert.equal(r.state, 'ready');
});

test('London closes at 11:50', () => {
  const r = e.gate({ cls: closing11, city: 'london', now: utc(2026, 11, 4, 11, 52), ticks: [tick('11:50 AM', utc(2026, 11, 4, 11, 51))] });
  assert.equal(r.state, 'ready');
});

test('local date follows the city, not the server', () => {
  // 2026-11-04 02:31Z is still Nov 3 in San Francisco
  const r = e.gate({ cls: { kind: 'first_tick' }, city: 'san francisco', now: utc(2026, 11, 4, 2, 31), ticks: [] });
  assert.equal(r.localDate, '2026-11-03');
});

test('first-tick rules use the earliest tick of the day', () => {
  // Seoul 08:35 local = 23:35Z the day before
  const first = tick('8:30 AM', utc(2026, 11, 3, 23, 33));
  const later = tick('9:00 AM', utc(2026, 11, 4, 0, 1));
  const r = e.gate({ cls: { kind: 'first_tick' }, city: 'seoul', now: utc(2026, 11, 3, 23, 35), ticks: [later, first] });
  assert.equal(r.state, 'ready');
  assert.equal(r.label, '8:30 AM');
});

test('first-tick rules use the first VALID prediction window, not the first tick', () => {
  const first = { kind: 'first_tick' };
  // Shenzhen ticks at 8:00 but its first valid prediction is 9:00. Shenzhen is UTC+8.
  assert.equal(e.gate({ cls: first, city: 'shenzhen', now: utc(2026, 11, 4, 0, 5), ticks: [tick('8:00 AM', utc(2026, 11, 4, 0, 1))] }).state, 'not_yet');
  assert.equal(e.gate({ cls: first, city: 'shenzhen', now: utc(2026, 11, 4, 1, 2), ticks: [tick('8:00 AM', utc(2026, 11, 4, 0, 1))] }).state, 'missing');
  const ok = e.gate({ cls: first, city: 'shenzhen', now: utc(2026, 11, 4, 1, 2), ticks: [tick('8:00 AM', utc(2026, 11, 4, 0, 1)), tick('9:00 AM', utc(2026, 11, 4, 1, 1))] });
  assert.equal(ok.state, 'ready');
  assert.equal(ok.label, '9:00 AM');
  // US window is 8:15 to 8:25. PST is UTC-8, so 8:16 local = 16:16Z.
  assert.equal(e.gate({ cls: first, city: 'seattle', now: utc(2026, 11, 4, 16, 16), ticks: [tick('8:15 AM', utc(2026, 11, 4, 16, 16))] }).state, 'ready');
  assert.equal(e.gate({ cls: first, city: 'seattle', now: utc(2026, 11, 4, 16, 31), ticks: [tick('8:30 AM', utc(2026, 11, 4, 16, 31))] }).state, 'missing');
  // Window plus 20 minutes of grace is over at 8:46 local.
  assert.equal(e.gate({ cls: first, city: 'seattle', now: utc(2026, 11, 4, 16, 50), ticks: [tick('8:15 AM', utc(2026, 11, 4, 16, 16))] }).state, 'expired');
});

test('never-class rules never fire', () => {
  assert.equal(e.gate({ cls: { kind: 'never', reason: 'x' }, city: 'seoul', now: utc(2026, 11, 4, 2, 31), ticks: [] }).state, 'never');
});

test('unknown city does not throw', () => {
  assert.equal(e.gate({ cls: closing11, city: 'atlantis', now: utc(2026, 11, 4, 2, 31), ticks: [] }).state, 'unknown_city');
});

// ---- planning ----------------------------------------------------------------------------

test('intent ids are deterministic and bracket-specific', () => {
  const a = e.intentIdFor({ ruleId: 'r1', city: 'Seoul', localDate: '2026-11-04', bracket: '12°C' });
  const b = e.intentIdFor({ ruleId: 'r1', city: 'seoul', localDate: '2026-11-04', bracket: ' 12°C ' });
  const c = e.intentIdFor({ ruleId: 'r1', city: 'seoul', localDate: '2026-11-04', bracket: '13°C' });
  const d = e.intentIdFor({ ruleId: 'r2', city: 'seoul', localDate: '2026-11-04', bracket: '12°C' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[a-f0-9]{32}$/);
});

test('signal price comes from the closing tick only when it priced the matched bracket', () => {
  const docs = [
    { pacing_time: '11:30 AM', bracket: '12°C', yes_price_cents: 41 },
    { pacing_time: '11:00 AM', bracket: '13°C', yes_price_cents: 20 },
    { pacing_time: '11:30 AM', bracket: '14°C', yes_price: 0.07 },
  ];
  assert.equal(e.signalPriceFor({ bracket: '12°C', label: '11:30 AM', tickDocs: docs }), 41);
  assert.equal(e.signalPriceFor({ bracket: '13°C', label: '11:30 AM', tickDocs: docs }), null);
  assert.equal(e.signalPriceFor({ bracket: '14°C', label: '11:30 AM', tickDocs: docs }), 7);
});

test('planBuys dedupes by bracket and refuses an over-broad rule', () => {
  const base = { ruleId: 'r1', city: 'seoul', localDate: '2026-11-04', label: '11:30 AM', tickDocs: [] };
  const one = e.planBuys({ ...base, matches: [{ bracket: '12°C', method: 'linear' }, { bracket: '12°C ', method: 'reciprocal' }] });
  assert.equal(one.buys.length, 1);
  assert.equal(e.planBuys({ ...base, matches: [] }).reason, 'no_match');
  const many = ['1', '2', '3', '4'].map((b) => ({ bracket: b }));
  const broad = e.planBuys({ ...base, matches: many, maxBuys: 3 });
  assert.equal(broad.reason, 'too_broad');
  assert.equal(broad.buys.length, 0);
});

// ---- settlement --------------------------------------------------------------------------

test('P&L', () => {
  assert.equal(e.pnlFor({ shares: 2.5, spentUsd: 1, won: true }), 1.5);
  assert.equal(e.pnlFor({ shares: 2.5, spentUsd: 1, won: false }), -1);
  assert.equal(e.outcomeWon('12°C ', ' 12°C'), true);
  assert.equal(e.outcomeWon('12°C', '13°C'), false);
});
