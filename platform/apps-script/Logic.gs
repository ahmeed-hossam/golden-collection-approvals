/**
 * Pure approval logic: no SpreadsheetApp, MailApp or Session calls, so it can be
 * unit-tested in Node (platform/tests/logic.test.js) as well as run in Apps Script.
 *
 * The Requests tab formulas stay the routing engine (Band, L2/FP&A/Strategy+CEO
 * required, Status). This file only maps those results to people, steps and SLAs.
 */

// Requests tab layout (1-based columns). Header is row 4, data starts row 5.
var COL = {
  id: 1, dateRaised: 2, requester: 3, department: 4, type: 5, description: 6,
  vendor: 7, value: 8, budgetLine: 9,
  outOfBudget: 10, newVendor: 11, longContract: 12, hiring: 13, discount: 14, mediaTopUp: 15,
  band: 16, l2Required: 17, fpaRequired: 18, strategyCeoRequired: 19,
  l1: 20, l2: 21, fpa: 22, strategy: 23, ceo: 24,
  status: 25, jointPayment: 26, paidOn: 27, notes: 28
};
var HEADER_ROW = 4;
var FIRST_DATA_ROW = 5;
var LAST_COL = 28;

var FLAG_FIELDS = ['outOfBudget', 'newVendor', 'longContract', 'hiring', 'discount', 'mediaTopUp'];
var DECISION_FIELDS = ['l1', 'l2', 'fpa', 'strategy', 'ceo'];

// Status text (from the Requests!Y formula) -> the step that must act next.
var STEPS = {
  'Pending L1':       { key: 'l1',       label: 'L1 Senior / Lead',  role: 'L1',         deptScoped: true,  slaDays: 1 },
  'Pending L2':       { key: 'l2',       label: 'L2 Dept Manager',   role: 'L2',         deptScoped: true,  slaDays: 2 },
  'Pending FP&A':     { key: 'fpa',      label: 'FP&A (2nd)',        role: 'FP&A',       deptScoped: false, slaDays: 2 },
  'Pending Strategy': { key: 'strategy', label: 'Strategy Analyst',  role: 'Strategy',   deptScoped: true,  slaDays: 2 },
  'Pending CEO':      { key: 'ceo',      label: 'CEO',               role: 'CEO',        deptScoped: false, slaDays: 3 },
  'Approved, with Accounting': { key: 'payment', label: 'Accounting (payment)', role: 'Accounting', deptScoped: false, slaDays: null }
};

// Roles on the People tab.
var ROLES = ['Requester', 'L1', 'L2', 'FP&A', 'Strategy', 'CEO', 'CEO EA', 'Accounting', 'Admin'];
// Roles that see every request, not just their department's.
var SEE_ALL_ROLES = ['FP&A', 'CEO', 'CEO EA', 'Accounting', 'Admin'];

// Egypt weekend: Friday (5) and Saturday (6).
var WEEKEND_DAYS = [5, 6];

function stepForStatus(status) {
  return STEPS[status] || null;
}

/** Whole working days elapsed between two dates (start day not counted). */
function workingDaysBetween(start, end) {
  var s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  var e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  var days = 0;
  while (s < e) {
    s.setDate(s.getDate() + 1);
    if (WEEKEND_DAYS.indexOf(s.getDay()) === -1) days++;
  }
  return days;
}

/**
 * SLA in working days for a step. FP&A takes its SLA from the Settings tab per band
 * (1 for Band B, 2 for C and D). Band A has no FP&A sign-off unless a trigger fires,
 * in which case the standard 2 days applies.
 */
function slaDaysFor(step, band, fpaSlaByBand) {
  if (!step || step.slaDays === null) return null;
  if (step.key === 'fpa') {
    var v = Number(fpaSlaByBand && fpaSlaByBand[band]);
    return v > 0 ? v : 2;
  }
  return step.slaDays;
}

/** Can this person sign the current step of this request? Returns {ok, reason}. */
function canAct(person, request, step) {
  if (!person) return { ok: false, reason: 'You are not on the People tab.' };
  if (!step) return { ok: false, reason: 'Nothing is pending on this request.' };
  if (request.requesterEmail && sameEmail(request.requesterEmail, person.email)) {
    return { ok: false, reason: 'Requesters never approve their own request.' };
  }
  if (person.role !== step.role) return { ok: false, reason: 'Waiting on ' + step.label + '.' };
  if (step.deptScoped && !deptMatches(person.department, request.department)) {
    return { ok: false, reason: 'Waiting on ' + step.label + ' for ' + request.department + '.' };
  }
  return { ok: true, reason: '' };
}

function deptMatches(personDept, requestDept) {
  return !personDept || personDept === 'All' || personDept === requestDept;
}

function sameEmail(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

/** People who should sign a step for a request (emails). */
function approversFor(people, step, department) {
  if (!step) return [];
  return people.filter(function (p) {
    return p.role === step.role && (!step.deptScoped || deptMatches(p.department, department));
  }).map(function (p) { return p.email; });
}

function canSee(person, request) {
  if (!person) return false;
  if (SEE_ALL_ROLES.indexOf(person.role) !== -1) return true;
  if (sameEmail(request.requesterEmail, person.email)) return true;
  if (person.role === 'Requester') return false;
  return deptMatches(person.department, request.department);
}

/**
 * Mirrors the Requests tab routing formulas (P to S) so the request form can show
 * the route before submitting. The Sheet remains the authority once the row exists.
 * settings: { bands: [{from, band, l2, fpa, strategyCeo}], l2Types: [..], mediaCeiling }
 */
function previewRoute(value, type, flags, settings) {
  value = Number(value);
  if (!(value > 0)) return null;
  var row = null;
  settings.bands.forEach(function (b) { if (value - 0.01 >= b.from) row = b; });
  if (!row) row = settings.bands[0];
  var anyTrigger = ['outOfBudget', 'newVendor', 'longContract', 'hiring', 'discount']
    .some(function (f) { return flags && flags[f]; });
  var l2 = row.l2 || settings.l2Types.indexOf(type) !== -1 || anyTrigger;
  var fpa;
  if (anyTrigger) fpa = true;
  else if (flags && flags.mediaTopUp && value <= settings.mediaCeiling) fpa = false;
  else fpa = row.fpa;
  var strategyCeo = row.strategyCeo;
  var steps = ['L1 Senior / Lead'];
  if (l2) steps.push('L2 Dept Manager');
  if (fpa) steps.push('FP&A (2nd)');
  if (strategyCeo) { steps.push('Strategy Analyst'); steps.push('CEO'); }
  steps.push('Accounting (payment)');
  return {
    band: row.band, l2: l2, fpa: fpa, strategyCeo: strategyCeo, steps: steps,
    jointPayment: value > settings.jointPaymentThreshold,
    quotes: value <= 25000 ? 1 : (value <= 100000 ? 2 : 3)
  };
}

function yn(v) { return v ? 'Y' : 'N'; }

if (typeof module !== 'undefined') {
  module.exports = {
    COL: COL, STEPS: STEPS, stepForStatus: stepForStatus, workingDaysBetween: workingDaysBetween,
    slaDaysFor: slaDaysFor, canAct: canAct, approversFor: approversFor, canSee: canSee,
    previewRoute: previewRoute, deptMatches: deptMatches
  };
}
