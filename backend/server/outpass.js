/**
 * Outpasses: a warden lets a student leave, and the parent is emailed.
 *
 * Lifecycle: issued -> returned | cancelled | declined. One open pass per
 * student at a time, so a double click can never email a parent twice.
 *
 * Approval: each pass carries a private token. The email's Approve / Decline
 * buttons carry it back, and only the holder of the email can answer. The token
 * never leaves this process through the dashboard API (see present()).
 */

const crypto = require('crypto');
const db = require('./db');
const mailer = require('./mailer');

const EMAIL_RE = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]{2,}$/;
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BEHIND_MS = 24 * 60 * 60 * 1000;
const approvalTtlMs = () => (Number(process.env.APPROVAL_TTL_HOURS) || 72) * 60 * 60 * 1000;

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}


function sameToken(a, b) {
   if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function fail(status, code, error) {
  return { error, code, status };
}

/** One line, no control characters (stops header and layout tricks), trimmed. */
function line(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function checkEmail(raw) {
  const email = line(raw, 254).toLowerCase();
  if (!email) return fail(400, 'no_email', "Enter the parent's email address.");
  if (!EMAIL_RE.test(email)) return fail(400, 'bad_email', 'That email address does not look right.');
  return { email };
}

/** Validate a new outpass request. Returns { value } or { error, code, status }. */
function validate(body, { guests, now = new Date(), openPasses = [] } = {}) {
  const b = body || {};

  const guest = guests.find((g) => g.id === b.guest_id && g.active);
  if (!guest) return fail(400, 'bad_guest', 'Choose a student from the guest list.');

  if (openPasses.some((p) => p.guest_id === guest.id)) {
    return fail(
      409,
      'already_open',
      `${guest.name} already has an open outpass. Mark it returned or cancel it first.`
    );
  }

  const mail = checkEmail(b.parent_email);
  if (mail.error) return mail;

  const reason = line(b.reason, 200);
  if (reason.length < 2) return fail(400, 'no_reason', 'Say why the student is leaving.');

  const leaveAt = b.leave_at ? new Date(b.leave_at) : now;
  if (Number.isNaN(leaveAt.getTime())) return fail(400, 'bad_leave', 'The leaving time is not a valid date.');
  if (leaveAt.getTime() < now.getTime() - MAX_BEHIND_MS) {
    return fail(400, 'leave_past', 'The leaving time is more than a day ago.');
  }
  if (leaveAt.getTime() > now.getTime() + MAX_AHEAD_MS) {
    return fail(400, 'leave_far', 'The leaving time is more than 30 days away.');
  }

  let returnBy = null;
  if (b.return_by) {
    returnBy = new Date(b.return_by);
    if (Number.isNaN(returnBy.getTime())) return fail(400, 'bad_return', 'The return time is not a valid date.');
    if (returnBy.getTime() <= leaveAt.getTime()) {
      return fail(400, 'return_before_leave', 'The return time must be after the leaving time.');
    }
  }

  return {
    value: {
      guest,
      parent_email: mail.email,
      parent_name: line(b.parent_name, 80),
      reason,
      destination: line(b.destination, 100) || 'Home',
      leave_at: leaveAt.toISOString(),
      return_by: returnBy ? returnBy.toISOString() : null,
      note: line(b.note, 300),
      issued_by: line(b.issued_by, 60),
      remember: b.remember_parent !== false,
    },
  };
}

function newId(rows, now) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');
  let n = rows.filter((r) => r.id.startsWith(`OP-${stamp}-`)).length + 1;
  let id = `OP-${stamp}-${String(n).padStart(3, '0')}`;
  while (rows.some((r) => r.id === id)) {
    n += 1;
    id = `OP-${stamp}-${String(n).padStart(3, '0')}`;
  }
  return id;
}

function emailRecord(result, to, now) {
  return { status: result.status, detail: result.detail, to, at: now.toISOString() };
}

/**
 * What the dashboard may see. The approval token is removed here: anyone who
 * could read it from GET /api/outpasses could approve on the parent's behalf.
 */
function present(pass, now = new Date()) {
  // eslint-disable-next-line no-unused-vars
  const { token, ...approval } = pass.approval || { status: 'not_requested' };
  const overdue = pass.status === 'issued' && pass.return_by
    && new Date(pass.return_by).getTime() < now.getTime();
  return { ...pass, approval, overdue: Boolean(overdue) };
}

function list({ status = null, guest_id = null, limit = 200, now = new Date() } = {}) {
  return db.readOutpasses()
    .filter((p) => !status || p.status === status)
    .filter((p) => !guest_id || p.guest_id === guest_id)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, Number(limit) || 200)
    .map((p) => present(p, now));
}

/**
 * Issue a pass, remember the parent's contact, and send the email.
 * Resolves to { outpass } or { error, code, status }. Never rejects.
 */
async function create(body, options = {}) {
  const now = options.now || new Date();
  const rows = db.readOutpasses();
  const checked = validate(body, {
    guests: db.readGuests(),
    now,
    openPasses: rows.filter((p) => p.status === 'issued'),
  });
  if (checked.error) return checked;
  const v = checked.value;

  const pass = {
    id: newId(rows, now),
    guest_id: v.guest.id,
    guest_name: v.guest.name,
    room_no: v.guest.room_no,
    parent_name: v.parent_name,
    parent_email: v.parent_email,
    destination: v.destination,
    reason: v.reason,
    leave_at: v.leave_at,
    return_by: v.return_by,
    note: v.note,
    issued_by: v.issued_by,
    status: 'issued',
    created_at: now.toISOString(),
    email: { status: 'pending', detail: '', to: v.parent_email, at: null },
    approval: {
      status: 'pending',
      token: newToken(),
      expires_at: new Date(now.getTime() + approvalTtlMs()).toISOString(),
      decided_at: null,
      comment: '',
    },
  };

  // Written before the email goes out: if the mail server hangs and the
  // process dies, the pass still exists and can be re-sent.
  db.writeOutpasses([...rows, pass]);

  if (v.remember) {
    const parents = db.readParents();
    parents[v.guest.id] = {
      parent_name: v.parent_name,
      parent_email: v.parent_email,
      updated_at: now.toISOString(),
    };
    db.writeParents(parents);
  }

  const result = await mailer.send(pass, v.parent_email, options.mail);
  return { outpass: setEmail(pass.id, emailRecord(result, v.parent_email, new Date()), pass) };
}

/** Re-read before writing: the send can take seconds and the file may have moved on. */
function setEmail(id, record, fallback) {
  const rows = db.readOutpasses();
  const i = rows.findIndex((p) => p.id === id);
  if (i === -1) return present({ ...fallback, email: record });
  rows[i] = { ...rows[i], email: record };
  db.writeOutpasses(rows);
  return present(rows[i]);
}

async function resend(id, options = {}) {
  const now = options.now || new Date();
  const rows = db.readOutpasses();
  const i = rows.findIndex((p) => p.id === id);
  if (i === -1) return fail(404, 'not_found', 'That outpass was not found.');
  if (rows[i].status !== 'issued') {
    return fail(409, 'already_closed', `That outpass is already ${rows[i].status}, so there is nothing to resend.`);
  }

  // Still waiting on the parent: give the links a fresh window. Passes from
  // before approval existed are upgraded so they get the buttons too.
  const a = rows[i].approval;
  if (!a || a.status === 'pending') {
    rows[i] = {
      ...rows[i],
      approval: {
        status: 'pending',
        token: (a && a.token) || newToken(),
        expires_at: new Date(now.getTime() + approvalTtlMs()).toISOString(),
        decided_at: null,
        comment: '',
      },
    };
    db.writeOutpasses(rows);
  }

  const pass = rows[i];
  const result = await mailer.send(pass, pass.parent_email, options.mail);
  return { outpass: setEmail(id, emailRecord(result, pass.parent_email, new Date()), pass) };
}

/** Mark a pass returned or cancelled. */
function close(id, status, now = new Date()) {
  if (status !== 'returned' && status !== 'cancelled') {
    return fail(400, 'bad_status', 'Status must be returned or cancelled.');
  }
  const rows = db.readOutpasses();
  const i = rows.findIndex((p) => p.id === id);
  if (i === -1) return fail(404, 'not_found', 'That outpass was not found.');
  if (rows[i].status !== 'issued') {
    return fail(409, 'already_closed', `That outpass is already ${rows[i].status}.`);
  }
  rows[i] = { ...rows[i], status, [`${status}_at`]: now.toISOString() };
  db.writeOutpasses(rows);
  return { outpass: present(rows[i], now) };
}

// --------------------------------------------------------------------------
// The parent's answer
// --------------------------------------------------------------------------

/**
 * Where does this link stand? Never changes anything, so it is safe for a GET:
 * mail scanners and link previews open links before any human does.
 *
 * state: invalid | decided | closed | expired | pending
 */
function lookup(id, token, now = new Date()) {
  const pass = db.readOutpasses().find((p) => p.id === id);
  if (!pass || !pass.approval || !sameToken(pass.approval.token, token)) {
    return { state: 'invalid' };
  }
  const a = pass.approval;
  if (a.status === 'approved' || a.status === 'declined') {
    return { state: 'decided', decision: a.status, outpass: present(pass, now) };
  }
  if (pass.status !== 'issued') return { state: 'closed', outpass: present(pass, now) };
  if (a.expires_at && new Date(a.expires_at).getTime() < now.getTime()) {
    return { state: 'expired', outpass: present(pass, now) };
  }
  return { state: 'pending', outpass: present(pass, now) };
}

/** Record the parent's decision. choice: "approve" | "decline". The first answer is final. */
function respond(id, token, choice, comment, now = new Date()) {
  const found = lookup(id, token, now);
  if (found.state !== 'pending') return found;
  if (choice !== 'approve' && choice !== 'decline') return { state: 'invalid_choice' };

  const rows = db.readOutpasses();
  const i = rows.findIndex((p) => p.id === id);
  const approved = choice === 'approve';
  rows[i] = {
    ...rows[i],
    status: approved ? rows[i].status : 'declined',
    ...(approved ? {} : { declined_at: now.toISOString() }),
    approval: {
      ...rows[i].approval,
      status: approved ? 'approved' : 'declined',
      decided_at: now.toISOString(),
      comment: line(comment, 300),
    },
  };
  db.writeOutpasses(rows);
  return { state: 'done', decision: rows[i].approval.status, outpass: present(rows[i], now) };
}

function getParent(guestId) {
  const p = db.readParents()[guestId];
  return { guest_id: guestId, parent_name: (p && p.parent_name) || '', parent_email: (p && p.parent_email) || '' };
}

function saveParent(guestId, body, now = new Date()) {
  if (!db.readGuests().some((g) => g.id === guestId)) return fail(404, 'bad_guest', 'Guest not found.');
  const mail = checkEmail(body && body.parent_email);
  if (mail.error) return mail;
  const parents = db.readParents();
  parents[guestId] = {
    parent_name: line(body && body.parent_name, 80),
    parent_email: mail.email,
    updated_at: now.toISOString(),
  };
  db.writeParents(parents);
  return getParent(guestId);
}

module.exports = { validate, create, resend, close, list, lookup, respond, getParent, saveParent, checkEmail };
