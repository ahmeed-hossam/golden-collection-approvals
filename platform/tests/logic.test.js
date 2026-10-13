// Run: node --test platform/tests
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Load Logic.gs the way Apps Script does (plain script), then read its exports.
const src = fs.readFileSync(path.join(__dirname, '../apps-script/Logic.gs'), 'utf8');
const ctx = { module: { exports: {} } };
vm.runInNewContext(src, ctx);
const L = ctx.module.exports;

// Mirrors the live Settings tab and config/approval-rules.yaml.
const settings = {
  bands: [
    { from: 0, band: 'A', l2: false, fpa: false, strategyCeo: false },
    { from: 25000, band: 'B', l2: true, fpa: true, strategyCeo: false },
    { from: 100000, band: 'C', l2: true, fpa: true, strategyCeo: false },
    { from: 500000, band: 'D', l2: true, fpa: true, strategyCeo: true }
  ],
  l2Types: ['Capex purchase', 'Trade promotion / discount', 'Hiring'],
  mediaCeiling: 100000,
  jointPaymentThreshold: 1500000
};
const none = {};

test('band edges follow "up to and including"', () => {
  assert.strictEqual(L.previewRoute(25000, 'Opex purchase', none, settings).band, 'A');
  assert.strictEqual(L.previewRoute(25001, 'Opex purchase', none, settings).band, 'B');
  assert.strictEqual(L.previewRoute(100000, 'Opex purchase', none, settings).band, 'B');
  assert.strictEqual(L.previewRoute(500000, 'Opex purchase', none, settings).band, 'C');
  assert.strictEqual(L.previewRoute(500001, 'Opex purchase', none, settings).band, 'D');
});

test('Band A opex goes to L1 only', () => {
  const r = L.previewRoute(10000, 'Opex purchase', none, settings);
  assert.deepStrictEqual(Array.from(r.steps), ['L1 Senior / Lead', 'Accounting (payment)']);
});

test('Band A capex always needs L2', () => {
  const r = L.previewRoute(10000, 'Capex purchase', none, settings);
  assert.strictEqual(r.l2, true);
  assert.strictEqual(r.fpa, false);
});

test('FP&A triggers force L2 and FP&A at any value', () => {
  const r = L.previewRoute(5000, 'Opex purchase', { newVendor: true }, settings);
  assert.strictEqual(r.l2, true);
  assert.strictEqual(r.fpa, true);
});

test('media top-up within ceiling skips FP&A, above ceiling does not', () => {
  assert.strictEqual(L.previewRoute(90000, 'Media plan / ad top-up', { mediaTopUp: true }, settings).fpa, false);
  assert.strictEqual(L.previewRoute(150000, 'Media plan / ad top-up', { mediaTopUp: true }, settings).fpa, true);
});

test('Band D adds Strategy then CEO; joint payment above 1.5M', () => {
  const r = L.previewRoute(2000000, 'Marketing campaign / activation', none, settings);
  assert.deepStrictEqual(Array.from(r.steps),
    ['L1 Senior / Lead', 'L2 Dept Manager', 'FP&A (2nd)', 'Strategy Analyst', 'CEO', 'Accounting (payment)']);
  assert.strictEqual(r.jointPayment, true);
  assert.strictEqual(r.quotes, 3);
});

test('working days skip Friday and Saturday', () => {
  // 2026-10-15 is a Thursday; next Sunday is 2026-10-18.
  assert.strictEqual(L.workingDaysBetween(new Date(2026, 9, 15), new Date(2026, 9, 18)), 1);
  assert.strictEqual(L.workingDaysBetween(new Date(2026, 9, 15), new Date(2026, 9, 15)), 0);
  assert.strictEqual(L.workingDaysBetween(new Date(2026, 9, 11), new Date(2026, 9, 18)), 5);
});

test('FP&A SLA comes from Settings per band, default 2', () => {
  const fpa = L.STEPS['Pending FP&A'];
  assert.strictEqual(L.slaDaysFor(fpa, 'B', { B: 1, C: 2 }), 1);
  assert.strictEqual(L.slaDaysFor(fpa, 'A', { A: 'Weekly' }), 2);
  assert.strictEqual(L.slaDaysFor(L.STEPS['Pending CEO'], 'D', {}), 3);
});

test('requester can never approve own request', () => {
  const me = { email: 'lead@gc.com', role: 'L1', department: 'Marketing' };
  const req = { requesterEmail: 'LEAD@gc.com', department: 'Marketing' };
  assert.strictEqual(L.canAct(me, req, L.STEPS['Pending L1']).ok, false);
});

test('L2 is department-scoped, FP&A is not', () => {
  const req = { requesterEmail: 'agent@gc.com', department: 'CX & Live Ops' };
  const mktL2 = { email: 'm@gc.com', role: 'L2', department: 'Marketing' };
  const opsL2 = { email: 'o@gc.com', role: 'L2', department: 'CX & Live Ops' };
  const fpa = { email: 'f@gc.com', role: 'FP&A', department: 'All' };
  assert.strictEqual(L.canAct(mktL2, req, L.STEPS['Pending L2']).ok, false);
  assert.strictEqual(L.canAct(opsL2, req, L.STEPS['Pending L2']).ok, true);
  assert.strictEqual(L.canAct(fpa, req, L.STEPS['Pending FP&A']).ok, true);
  assert.strictEqual(L.canAct(fpa, req, L.STEPS['Pending L2']).ok, false);
});

test('approversFor picks the right people', () => {
  const people = [
    { email: 's1@gc.com', role: 'Strategy', department: 'Marketing' },
    { email: 's2@gc.com', role: 'Strategy', department: 'CX & Live Ops' },
    { email: 'ceo@gc.com', role: 'CEO', department: 'All' }
  ];
  assert.deepStrictEqual(Array.from(L.approversFor(people, L.STEPS['Pending Strategy'], 'Marketing')), ['s1@gc.com']);
  assert.deepStrictEqual(Array.from(L.approversFor(people, L.STEPS['Pending CEO'], 'Marketing')), ['ceo@gc.com']);
});
