/**
 * Golden Collection approvals platform (Google Apps Script web app).
 *
 * Bound to the "Golden Collection – Approval Requests" Google Sheet:
 *   Requests  - one row per request; formulas decide band, route and status
 *   Settings  - bands and rules (must match config/approval-rules.yaml)
 *   People    - created by setup(): who holds which role in which department
 *   History   - created by setup(): every submission, decision, reminder and comment
 *
 * The app writes only the requester columns (B to O), the decision columns (T to X),
 * Paid on (AA) and Notes (AB). It never overwrites a formula.
 */

var APP_NAME = 'Golden Collection approvals';

// ---------------------------------------------------------------- web app

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('Index');
  t.openId = (e && e.parameter && e.parameter.id) || '';
  return t.evaluate()
    .setTitle(APP_NAME)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Everything the page needs on load. */
function getBootstrap() {
  var me = currentPerson_();
  var settings = readSettings_();
  return {
    me: me,
    email: currentEmail_(),
    departments: settings.departments,
    requestTypes: settings.requestTypes,
    appUrl: ScriptApp.getService().getUrl(),
    sheetUrl: SpreadsheetApp.getActive().getUrl()
  };
}

function previewRouteFor(value, type, flags) {
  return previewRoute(value, type, flags, readSettings_());
}

/** Requests this user can see, newest first, with who acts next and SLA state. */
function listRequests() {
  var me = currentPerson_();
  if (!me) return [];
  var settings = readSettings_();
  var history = readHistory_();
  return readRequests_(history).filter(function (r) { return canSee(me, r); })
    .map(function (r) { return decorate_(r, me, settings, history); })
    .reverse();
}

function getRequest(id) {
  var me = currentPerson_();
  var settings = readSettings_();
  var history = readHistory_();
  var r = findRequest_(id, history);
  if (!r || !canSee(me, r)) throw new Error('Request ' + id + ' not found.');
  var out = decorate_(r, me, settings, history);
  out.history = history.filter(function (h) { return h.id === id; }).map(function (h) {
    return { at: fmtDateTime_(h.at), actor: h.actor, action: h.action, step: h.step, comment: h.comment };
  });
  return out;
}

/** Requester submits a new request. form: fields of the request form. */
function submitRequest(form) {
  var me = requirePerson_();
  validateForm_(form);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var sh = requestsSheet_();
    var row = firstEmptyRow_(sh);
    ensureFormulas_(sh, row);
    sh.getRange(row, COL.dateRaised, 1, 14).setValues([[
      new Date(), me.name || me.email, form.department, form.type, form.description,
      form.vendor, Number(form.value), form.budgetLine,
      yn(form.outOfBudget), yn(form.newVendor), yn(form.longContract),
      yn(form.hiring), yn(form.discount), yn(form.mediaTopUp)
    ]]);
    if (form.notes) sh.getRange(row, COL.notes).setValue(form.notes);
    SpreadsheetApp.flush();
    var id = sh.getRange(row, COL.id).getDisplayValue();
    logHistory_(id, row, me.email, 'Submitted', '', form.businessCase || '');
    var r = findRequest_(id, readHistory_());
    notifyNextStep_(r, 'New request ' + id);
    return { id: id, status: r.status };
  } finally {
    lock.releaseLock();
  }
}

/** Approver decision on the current step: 'Approved' | 'Rejected' | 'Returned'. */
function decide(id, decision, comment) {
  if (['Approved', 'Rejected', 'Returned'].indexOf(decision) === -1) throw new Error('Unknown decision.');
  if (decision !== 'Approved' && !String(comment || '').trim()) {
    throw new Error('Give a written reason when rejecting or returning.');
  }
  var me = requirePerson_();
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var r = findRequest_(id, readHistory_());
    if (!r) throw new Error('Request ' + id + ' not found.');
    var step = stepForStatus(r.status);
    if (!step || step.key === 'payment') throw new Error(id + ' is not waiting on an approval (' + r.status + ').');
    var check = canAct(me, r, step);
    if (!check.ok) throw new Error(check.reason);

    requestsSheet_().getRange(r.row, COL[step.key]).setValue(decision);
    SpreadsheetApp.flush();
    logHistory_(id, r.row, me.email, decision, step.label, comment || '');

    var after = findRequest_(id, readHistory_());
    var ea = emailsWithRole_('CEO EA');
    if (decision === 'Approved') {
      notifyNextStep_(after, id + ' approved by ' + step.label);
    } else {
      sendMail_([after.requesterEmail], ea,
        id + ' ' + decision.toLowerCase() + ' at ' + step.label,
        decision + ' by ' + (me.name || me.email) + ' (' + step.label + ').\n\nReason: ' + comment +
        (decision === 'Returned' ? '\n\nEdit and resubmit from the app; it restarts at ' + step.label + ', not at the beginning.' : ''),
        after);
    }
    return { id: id, status: after.status };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Requester resubmits a returned request. Clears the "Returned" decision so the
 * request restarts at the step that returned it. If the edit moves the request to a
 * different band, every decision is cleared and it restarts at L1.
 */
function resubmitRequest(id, form) {
  var me = requirePerson_();
  validateForm_(form);
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var r = findRequest_(id, readHistory_());
    if (!r) throw new Error('Request ' + id + ' not found.');
    if (r.status !== 'Returned to requester') throw new Error(id + ' has not been returned.');
    if (!sameEmail(r.requesterEmail, me.email)) throw new Error('Only the requester can resubmit.');
    if (form.department !== r.department) throw new Error('Department cannot change on resubmission (it sets the ID).');

    var sh = requestsSheet_();
    sh.getRange(r.row, COL.type, 1, 11).setValues([[
      form.type, form.description, form.vendor, Number(form.value), form.budgetLine,
      yn(form.outOfBudget), yn(form.newVendor), yn(form.longContract),
      yn(form.hiring), yn(form.discount), yn(form.mediaTopUp)
    ]]);
    SpreadsheetApp.flush();
    var newBand = sh.getRange(r.row, COL.band).getDisplayValue();
    var restart = newBand !== r.band;
    DECISION_FIELDS.forEach(function (k) {
      if (restart || r.decisions[k] === 'Returned') sh.getRange(r.row, COL[k]).clearContent();
    });
    SpreadsheetApp.flush();
    logHistory_(id, r.row, me.email, 'Resubmitted', '',
      (restart ? 'Band moved ' + r.band + ' → ' + newBand + '; all approvals cleared. ' : '') + (form.businessCase || ''));
    var after = findRequest_(id, readHistory_());
    notifyNextStep_(after, id + ' resubmitted');
    return { id: id, status: after.status };
  } finally {
    lock.releaseLock();
  }
}

/** Accounting records payment once all approvals are in. */
function markPaid(id, paymentRef, ceoCoSigned) {
  var me = requirePerson_();
  if (me.role !== 'Accounting') throw new Error('Only Accounting records payments.');
  var lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    var r = findRequest_(id, readHistory_());
    if (!r || r.status !== 'Approved, with Accounting') throw new Error(id + ' is not ready for payment.');
    if (r.jointPayment === 'Y' && !ceoCoSigned) throw new Error('Above the joint payment threshold: the CEO must co-sign the payment.');
    var sh = requestsSheet_();
    sh.getRange(r.row, COL.paidOn).setValue(new Date());
    if (paymentRef) {
      var notes = sh.getRange(r.row, COL.notes).getValue();
      sh.getRange(r.row, COL.notes).setValue((notes ? notes + ' | ' : '') + 'Payment ref ' + paymentRef);
    }
    SpreadsheetApp.flush();
    logHistory_(id, r.row, me.email, 'Paid', 'Accounting', (paymentRef ? 'Ref ' + paymentRef : '') +
      (r.jointPayment === 'Y' ? ' (CEO co-signed)' : ''));
    var after = findRequest_(id, readHistory_());
    sendMail_([after.requesterEmail], emailsWithRole_('CEO EA'), id + ' paid',
      'Accounting released payment' + (paymentRef ? ' (ref ' + paymentRef + ')' : '') + '.', after);
    return { id: id, status: after.status };
  } finally {
    lock.releaseLock();
  }
}

/** Comment on a request. The CEO EA can also flag it for the CEO's attention. */
function addComment(id, comment, flagForCeo) {
  var me = requirePerson_();
  var r = findRequest_(id, readHistory_());
  if (!r || !canSee(me, r)) throw new Error('Request ' + id + ' not found.');
  if (!String(comment || '').trim()) throw new Error('Write a comment first.');
  if (flagForCeo && me.role !== 'CEO EA') throw new Error('Only the CEO Executive Assistant flags requests for the CEO.');
  logHistory_(id, r.row, me.email, flagForCeo ? 'Flagged for CEO' : 'Comment', '', comment);
  if (flagForCeo) {
    sendMail_(emailsWithRole_('CEO'), emailsWithRole_('CEO EA'), id + ' flagged for CEO attention', comment, r);
  }
  return true;
}

// ---------------------------------------------------------------- SLA reminders

/** Daily trigger (installed by setup()). Reminds overdue approvers and informs the CEO EA. */
function sendSlaReminders() {
  var settings = readSettings_();
  var history = readHistory_();
  var people = readPeople_();
  var ea = emailsWithRole_('CEO EA');
  var today = new Date();
  if (WEEKEND_DAYS.indexOf(today.getDay()) !== -1) return;
  var todayKey = fmtDate_(today);

  readRequests_(history).forEach(function (r) {
    var step = stepForStatus(r.status);
    var sla = slaDaysFor(step, r.band, settings.fpaSlaByBand);
    if (!sla) return;
    var waited = workingDaysBetween(r.waitingSince, today);
    if (waited <= sla) return;
    var remindedToday = history.some(function (h) {
      return h.id === r.id && h.action === 'Reminder' && fmtDate_(h.at) === todayKey;
    });
    if (remindedToday) return;

    var to = approversFor(people, step, r.department);
    var note = step.label + ' has waited ' + waited + ' working days against an SLA of ' + sla + '.';
    // Policy: a missed L1 SLA auto-escalates to the L2 Dept Manager.
    if (step.key === 'l1') {
      to = to.concat(approversFor(people, STEPS['Pending L2'], r.department));
      note += ' Escalated to the L2 Dept Manager.';
    }
    sendMail_(to, ea, 'Overdue: ' + r.id + ' waiting on ' + step.label, note, r);
    logHistory_(r.id, r.row, 'system', 'Reminder', step.label, note);
  });
}

// ---------------------------------------------------------------- setup

/** Run once from the Apps Script editor: adds People and History tabs and the daily trigger. */
function setup() {
  var ss = SpreadsheetApp.getActive();
  if (!ss.getSheetByName('People')) {
    var p = ss.insertSheet('People');
    p.getRange(1, 1, 1, 4).setValues([['Email', 'Name', 'Role', 'Department']]).setFontWeight('bold');
    p.getRange(2, 1, 1, 4).setValues([[Session.getEffectiveUser().getEmail(), 'Ahmed', 'Admin', 'All']]);
    p.getRange('C2:C200').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(ROLES, true).build());
    p.getRange('D2:D200').setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList(['Marketing', 'CX & Live Ops', 'All'], true).build());
    p.setFrozenRows(1);
  }
  if (!ss.getSheetByName('History')) {
    var h = ss.insertSheet('History');
    h.getRange(1, 1, 1, 7).setValues([['Timestamp', 'Request ID', 'Row', 'Actor', 'Action', 'Step', 'Comment']])
      .setFontWeight('bold');
    h.setFrozenRows(1);
  }
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendSlaReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendSlaReminders').timeBased().everyDays(1).atHour(9).create();
}

// ---------------------------------------------------------------- data access

function requestsSheet_() { return SpreadsheetApp.getActive().getSheetByName('Requests'); }

function readSettings_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('Settings');
  var v = sh.getRange('A1:H40').getValues();
  var bands = [];
  var fpaSlaByBand = {};
  for (var i = 4; i <= 7; i++) {
    var b = v[i];
    if (b[2] === '') continue;
    bands.push({ from: Number(b[0]), band: b[2], l2: b[3] === 'Y', fpa: b[4] === 'Y', strategyCeo: b[5] === 'Y' });
    fpaSlaByBand[b[2]] = b[7];
  }
  var requestTypes = [], l2Types = [];
  for (var j = 13; j <= 19; j++) {
    if (!v[j][0]) continue;
    requestTypes.push(v[j][0]);
    if (v[j][1] === 'Y') l2Types.push(v[j][0]);
  }
  var departments = [];
  for (var k = 22; k <= 23; k++) if (v[k][0]) departments.push(v[k][0]);
  return {
    bands: bands, fpaSlaByBand: fpaSlaByBand, requestTypes: requestTypes, l2Types: l2Types,
    departments: departments, jointPaymentThreshold: Number(v[9][1]), mediaCeiling: Number(v[10][1])
  };
}

function readPeople_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('People');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(function (r) { return r[0]; })
    .map(function (r) {
      return { email: String(r[0]).trim().toLowerCase(), name: r[1], role: r[2], department: r[3] };
    });
}

function emailsWithRole_(role) {
  return readPeople_().filter(function (p) { return p.role === role; }).map(function (p) { return p.email; });
}

function readHistory_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('History');
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().map(function (r) {
    return { at: new Date(r[0]), id: r[1], row: r[2], actor: r[3], action: r[4], step: r[5], comment: r[6] };
  });
}

function logHistory_(id, row, actor, action, step, comment) {
  SpreadsheetApp.getActive().getSheetByName('History')
    .appendRow([new Date(), id, row, actor, action, step, comment]);
}

function readRequests_(history) {
  var sh = requestsSheet_();
  var last = sh.getLastRow();
  if (last < FIRST_DATA_ROW) return [];
  var n = last - FIRST_DATA_ROW + 1;
  var values = sh.getRange(FIRST_DATA_ROW, 1, n, LAST_COL).getValues();
  var display = sh.getRange(FIRST_DATA_ROW, 1, n, LAST_COL).getDisplayValues();
  var out = [];
  for (var i = 0; i < n; i++) {
    var v = values[i], d = display[i];
    if (!v[COL.requester - 1] || !v[COL.value - 1]) continue;
    out.push(toRequest_(FIRST_DATA_ROW + i, v, d, history));
  }
  return out;
}

function findRequest_(id, history) {
  var all = readRequests_(history);
  for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
  return null;
}

function toRequest_(row, v, d, history) {
  var g = function (k) { return v[COL[k] - 1]; };
  var gd = function (k) { return d[COL[k] - 1]; };
  var id = gd('id');
  var mine = history.filter(function (h) { return h.id === id; });
  var submitted = mine.filter(function (h) { return h.action === 'Submitted'; })[0];
  var lastMove = mine.filter(function (h) { return ['Reminder', 'Comment', 'Flagged for CEO'].indexOf(h.action) === -1; }).pop();
  var flags = {};
  FLAG_FIELDS.forEach(function (f) { flags[f] = g(f) === 'Y'; });
  var decisions = {};
  DECISION_FIELDS.forEach(function (k) { decisions[k] = g(k); });
  return {
    row: row, id: id, dateRaised: gd('dateRaised'), requester: g('requester'),
    requesterEmail: submitted ? String(submitted.actor).toLowerCase() : '',
    department: g('department'), type: g('type'), description: g('description'), vendor: g('vendor'),
    value: Number(g('value')), budgetLine: g('budgetLine'), flags: flags,
    band: gd('band'), l2Required: gd('l2Required'), fpaRequired: gd('fpaRequired'),
    strategyCeoRequired: gd('strategyCeoRequired'), decisions: decisions,
    status: gd('status'), jointPayment: gd('jointPayment'), paidOn: gd('paidOn'), notes: g('notes'),
    waitingSince: lastMove ? lastMove.at : (g('dateRaised') instanceof Date ? g('dateRaised') : new Date())
  };
}

/** Adds what the UI needs: next step, whether I can act, SLA state. Strips Date objects. */
function decorate_(r, me, settings, history) {
  var step = stepForStatus(r.status);
  var sla = slaDaysFor(step, r.band, settings.fpaSlaByBand);
  var waited = step ? workingDaysBetween(r.waitingSince, new Date()) : null;
  var act = step && step.key !== 'payment' ? canAct(me, r, step) : { ok: false, reason: '' };
  var out = JSON.parse(JSON.stringify(r));
  out.waitingSince = fmtDate_(r.waitingSince);
  out.nextStep = step ? step.label : '';
  out.waitedDays = waited;
  out.slaDays = sla;
  out.overdue = !!(sla && waited > sla);
  out.canAct = act.ok;
  out.actReason = act.reason;
  out.canPay = !!(me && me.role === 'Accounting' && r.status === 'Approved, with Accounting');
  out.canResubmit = !!(me && r.status === 'Returned to requester' && sameEmail(r.requesterEmail, me.email));
  out.isMine = !!(me && sameEmail(r.requesterEmail, me.email));
  return out;
}

function firstEmptyRow_(sh) {
  var n = Math.max(sh.getMaxRows() - FIRST_DATA_ROW + 1, 1);
  var col = sh.getRange(FIRST_DATA_ROW, COL.requester, n, 1).getValues();
  for (var i = 0; i < col.length; i++) if (!col[i][0]) return FIRST_DATA_ROW + i;
  sh.insertRowsAfter(sh.getMaxRows(), 50);
  return FIRST_DATA_ROW + col.length;
}

/** Copies the ID, routing and status formulas from row 5 if the target row has none. */
function ensureFormulas_(sh, row) {
  if (sh.getRange(row, COL.id).getFormula()) return;
  [[COL.id, 1], [COL.band, 4], [COL.status, 2]].forEach(function (c) {
    sh.getRange(FIRST_DATA_ROW, c[0], 1, c[1]).copyTo(sh.getRange(row, c[0], 1, c[1]));
  });
}

function currentEmail_() {
  return String(Session.getActiveUser().getEmail() || '').toLowerCase();
}

function currentPerson_() {
  var email = currentEmail_();
  if (!email) return null;
  return readPeople_().filter(function (p) { return p.email === email; })[0] || null;
}

function requirePerson_() {
  var me = currentPerson_();
  if (!me) throw new Error('Your Google account (' + (currentEmail_() || 'unknown') +
    ') is not on the People tab. Ask FP&A to add you.');
  return me;
}

function validateForm_(f) {
  var missing = ['department', 'type', 'description', 'vendor', 'value', 'budgetLine']
    .filter(function (k) { return !String(f[k] || '').trim(); });
  if (missing.length) throw new Error('Missing: ' + missing.join(', '));
  if (!(Number(f.value) > 0)) throw new Error('Value must be a positive EGP amount including VAT.');
  if (f.outOfBudget && !String(f.businessCase || '').trim()) {
    throw new Error('Out-of-budget requests must name the offset in the business case.');
  }
}

// ---------------------------------------------------------------- email

function notifyNextStep_(r, subject) {
  var step = stepForStatus(r.status);
  var ea = emailsWithRole_('CEO EA');
  var people = readPeople_();
  if (!step) {
    sendMail_([r.requesterEmail], ea, subject + ' — ' + r.status, 'Status: ' + r.status, r);
    return;
  }
  var to = approversFor(people, step, r.department)
    .filter(function (e) { return !sameEmail(e, r.requesterEmail); });
  sendMail_(to, ea.concat([r.requesterEmail]), subject + ' — waiting on ' + step.label,
    'Your action is needed: ' + step.label + '.', r);
}

function sendMail_(to, cc, subject, message, r) {
  to = uniq_(to);
  cc = uniq_(cc).filter(function (e) { return to.indexOf(e) === -1; });
  if (!to.length) { to = cc; cc = []; }
  if (!to.length) return;
  var url = ScriptApp.getService().getUrl();
  var body = message + '\n\n' +
    r.id + ' · ' + r.department + ' · ' + r.type + '\n' +
    r.description + '\nVendor: ' + r.vendor + '\nValue: EGP ' + fmtMoney_(r.value) + ' incl. VAT · Band ' + r.band +
    '\nBudget line: ' + r.budgetLine + '\nStatus: ' + r.status +
    (url ? '\n\nOpen the approvals app: ' + url + '?id=' + encodeURIComponent(r.id) : '');
  MailApp.sendEmail({ to: to.join(','), cc: cc.join(','), subject: '[' + r.id + '] ' + subject, body: body, name: APP_NAME });
}

function uniq_(list) {
  var seen = {};
  return (list || []).map(function (e) { return String(e || '').trim().toLowerCase(); })
    .filter(function (e) { if (!e || seen[e]) return false; seen[e] = true; return true; });
}

function fmtMoney_(n) { return Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtDate_(d) { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function fmtDateTime_(d) { return Utilities.formatDate(new Date(d), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm'); }
