const state = {
  meta: { universityName: 'Lecture attendance', policyVersion: '1.0' },
  user: null,
  offerings: [],
  departments: [],
  session: null,
  records: [],
  roster: [],
  code: null,
  expiresIn: 0,
  lastScan: null,
  report: null,
  attendance: null,
  notifications: [],
  disputes: [],
  face: null,
  analytics: null,
  audit: [],
  devices: [],
  view: 'home',
  stream: null,
};

let pollTimer = 0;
let tickTimer = 0;
let refreshing = false;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function showError(message) {
  const banner = document.querySelector('#banner');
  banner.hidden = !message;
  banner.textContent = message || '';
}

function showNotice(message) {
  const notice = document.querySelector('#notice');
  notice.hidden = !message;
  notice.textContent = message || '';
}

async function refreshTokens() {
  const refreshToken = sessionStorage.getItem('refresh');
  if (!refreshToken) return false;
  const response = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!response.ok) {
    sessionStorage.clear();
    return false;
  }
  const data = await response.json();
  sessionStorage.setItem('access', data.accessToken);
  sessionStorage.setItem('refresh', data.refreshToken);
  state.user = data.user;
  return true;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem('access');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.json);
  }
  let response = await fetch(path, { method: options.method || 'GET', headers, body });
  if (response.status === 401 && !options.retried && sessionStorage.getItem('refresh') && !path.startsWith('/api/auth/login')) {
    const ok = await refreshTokens();
    if (ok) return api(path, { ...options, retried: true });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function stopLive() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  pollTimer = 0;
  tickTimer = 0;
}

function stopCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
}

function pill(status) {
  return `<span class="pill ${esc(status)}">${esc(status)}</span>`;
}

function renderAccount() {
  const slot = document.querySelector('#account');
  if (!state.user) {
    slot.innerHTML = '';
    return;
  }
  const unread = state.notifications.filter((item) => !item.read).length;
  slot.innerHTML = `<div class="account"><span>${esc(state.user.profile?.firstName || state.user.email)} · ${esc(state.user.role)}${unread ? ` · ${unread} new` : ''}</span><button id="sign-out" class="ghost" type="button">Sign out</button></div>`;
  document.querySelector('#sign-out').addEventListener('click', signOut);
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST', json: { refreshToken: sessionStorage.getItem('refresh') } }).catch(() => {});
  sessionStorage.clear();
  stopLive();
  stopCamera();
  document.body.classList.remove('projector');
  state.user = null;
  state.view = 'home';
  state.session = null;
  showError('');
  showNotice('');
  render();
}

function render() {
  renderAccount();
  if (!state.user) renderSignedOut();
  else if (state.view === 'session') renderSession();
  else if (state.user.role === 'student') renderStudent();
  else renderStaff();
}

function renderSignedOut() {
  document.querySelector('#main').innerHTML = `
    <section class="auth-card stack">
      <div>
        <p class="eyebrow">Sign in</p>
        <h2>Mark the lecture, then get back to teaching.</h2>
      </div>
      <form id="login-form" class="stack">
        <input name="identifier" autocomplete="username" placeholder="Email, index number, or staff ID" required />
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" required />
        <button type="submit">Sign in</button>
      </form>
      <button id="show-register" class="ghost" type="button">Create a student account</button>
      <form id="register-form" class="stack" hidden>
        <input name="signupKey" placeholder="Signup key" required />
        <input name="firstName" placeholder="First name" required />
        <input name="lastName" placeholder="Last name" required />
        <input name="indexNumber" placeholder="Index number" required />
        <input name="email" type="email" placeholder="Email" required />
        <input name="programme" placeholder="Programme" />
        <input name="level" placeholder="Level" />
        <input name="password" type="password" placeholder="Password (8 or more characters)" required />
        <button type="submit">Register</button>
      </form>
    </section>`;
  document.querySelector('#login-form').addEventListener('submit', onLogin);
  document.querySelector('#show-register').addEventListener('click', () => {
    document.querySelector('#register-form').hidden = false;
  });
  document.querySelector('#register-form').addEventListener('submit', onRegister);
}

async function onLogin(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      json: { identifier: data.get('identifier'), password: data.get('password') },
    });
    sessionStorage.setItem('access', result.accessToken);
    sessionStorage.setItem('refresh', result.refreshToken);
    state.user = result.user;
    showError('');
    await loadHome();
  } catch (error) {
    showError(error.message);
  }
}

async function onRegister(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    const result = await api('/api/auth/register', {
      method: 'POST',
      json: Object.fromEntries(data.entries()),
    });
    sessionStorage.setItem('access', result.accessToken);
    sessionStorage.setItem('refresh', result.refreshToken);
    state.user = result.user;
    showError('');
    await loadHome();
  } catch (error) {
    showError(error.message);
  }
}

async function loadHome() {
  stopLive();
  stopCamera();
  state.view = 'home';
  state.session = null;
  showError('');
  const notes = await api('/api/notifications');
  state.notifications = notes.notifications;
  if (state.user.role === 'student') {
    state.attendance = await api(`/api/students/${state.user.id}/attendance`);
    state.face = await api(`/api/students/${state.user.id}/face`);
    state.disputes = (await api('/api/disputes')).disputes;
  } else {
    state.offerings = (await api('/api/offerings')).offerings;
    if (state.user.role === 'admin') {
      state.departments = (await api('/api/departments')).departments;
      state.audit = (await api('/api/audit')).logs;
      state.devices = (await api('/api/devices')).devices;
    }
    if (state.user.role === 'hod' && state.user.profile?.departmentId) {
      state.analytics = await api(`/api/analytics/department/${state.user.profile.departmentId}`);
    }
  }
  render();
}

function renderStaff() {
  const canTake = state.user.role === 'lecturer' || state.user.role === 'admin';
  const cards = state.offerings.map((offering) => `
    <article class="card stack">
      <div>
        <p class="eyebrow">${esc(offering.course?.code || 'Course')}</p>
        <h2>${esc(offering.course?.title || 'Untitled course')}</h2>
        <p class="muted">${esc(offering.academicYear)} · semester ${esc(offering.semester)} · ${esc(offering.studentCount)} students</p>
      </div>
      <div class="row">
        ${canTake ? `<button type="button" data-start="${esc(offering.id)}">Take attendance</button>` : ''}
        <button type="button" class="ghost" data-report="${esc(offering.id)}">Report</button>
        <button type="button" class="ghost" data-pdf="${esc(offering.id)}">PDF</button>
        <button type="button" class="ghost" data-xlsx="${esc(offering.id)}">Excel</button>
      </div>
      ${canTake ? `<form data-enroll="${esc(offering.id)}" class="row"><input name="indexes" placeholder="Index numbers, comma separated" /><button type="submit">Add</button></form>` : ''}
    </article>`).join('');
  const report = state.report ? reportTable(state.report) : '';
  const admin = state.user.role === 'admin' ? adminPanel() : '';
  const analytics = state.analytics ? analyticsBlock(state.analytics) : '';
  document.querySelector('#main').innerHTML = `
    <section class="stack">
      <div class="grid">${cards || '<p>No courses yet.</p>'}</div>
      ${report}
      ${analytics}
      ${notesBlock()}
      ${admin}
    </section>`;
  document.querySelectorAll('[data-start]').forEach((button) => button.addEventListener('click', () => startSession(button.dataset.start)));
  document.querySelectorAll('[data-report]').forEach((button) => button.addEventListener('click', () => loadReport(button.dataset.report)));
  document.querySelectorAll('[data-pdf]').forEach((button) => button.addEventListener('click', () => downloadReport(button.dataset.pdf, 'pdf').catch((error) => showError(error.message))));
  document.querySelectorAll('[data-xlsx]').forEach((button) => button.addEventListener('click', () => downloadReport(button.dataset.xlsx, 'xlsx').catch((error) => showError(error.message))));
  document.querySelectorAll('[data-enroll]').forEach((form) => form.addEventListener('submit', (event) => enroll(event, form.dataset.enroll)));
  bindAdmin();
}

function reportTable(report) {
  const rows = report.students.map((student) => `
    <tr>
      <td>${esc(student.name)}</td>
      <td>${esc(student.indexNumber)}</td>
      <td>${esc(student.present)}</td>
      <td>${esc(student.late)}</td>
      <td>${esc(student.absent)}</td>
      <td>${student.percentage === null ? '—' : `${esc(student.percentage)}%`}</td>
      <td>${student.eligible === null ? '—' : student.eligible ? 'Yes' : 'No'}</td>
    </tr>`).join('');
  return `<article class="card"><h2>${esc(report.course?.code)} report</h2><p class="muted">${esc(report.closedSessions)} closed lectures · minimum ${esc(report.minAttendancePercent)}%</p><table><thead><tr><th>Student</th><th>Index</th><th>Present</th><th>Late</th><th>Absent</th><th>%</th><th>Eligible</th></tr></thead><tbody>${rows || '<tr><td colspan="7">No students enrolled.</td></tr>'}</tbody></table></article>`;
}

function notesBlock() {
  if (!state.notifications.length) return '';
  const items = state.notifications.slice(0, 6).map((item) => `<li>${esc(item.message)}</li>`).join('');
  return `<article class="card"><h2>Notices</h2><ul>${items}</ul><button id="read-notes" class="ghost" type="button">Mark as read</button></article>`;
}

function analyticsBlock(analytics) {
  const rows = (analytics.offerings || []).map((item) => `<tr><td>${esc(item.course?.code)} ${esc(item.course?.title)}</td><td>${item.average === null ? '—' : esc(item.average)}</td><td>${esc(item.belowThreshold)}</td><td>${esc(item.enrolled)}</td></tr>`).join('');
  return `<article class="card"><h2>Department attendance</h2><table><thead><tr><th>Course</th><th>Average %</th><th>Below threshold</th><th>Enrolled</th></tr></thead><tbody>${rows || '<tr><td colspan="4">No offerings yet.</td></tr>'}</tbody></table></article>`;
}

function adminPanel() {
  const logs = state.audit.slice(0, 12).map((log) => `<li>${esc(log.action)} · ${esc(log.entity)} · ${esc(new Date(log.createdAt).toLocaleString())}</li>`).join('');
  const devices = state.devices.map((device) => `<li>${esc(device.name)} · ${esc(device.type)}</li>`).join('');
  const departments = state.departments.map((department) => `<option value="${esc(department._id)}">${esc(department.code)} · ${esc(department.name)}</option>`).join('');
  return `
    <article class="card stack">
      <h2>Department analytics</h2>
      <form id="analytics-form" class="row">
        <select name="departmentId">${departments}</select>
        <button type="submit">Load</button>
      </form>
    </article>
    <article class="card stack">
      <h2>Classroom device</h2>
      <form id="device-form" class="row">
        <input name="name" placeholder="Device name" required />
        <select name="type"><option value="tablet">Tablet</option><option value="phone">Phone</option><option value="camera">Camera</option></select>
        <button type="submit">Register</button>
      </form>
      <ul>${devices}</ul>
    </article>
    <article class="card"><h2>Audit log</h2><ul>${logs || '<li>No audit entries yet.</li>'}</ul></article>`;
}

function bindAdmin() {
  document.querySelector('#read-notes')?.addEventListener('click', async () => {
    await api('/api/notifications/read-all', { method: 'POST', json: {} });
    state.notifications = [];
    render();
  });
  document.querySelector('#analytics-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const departmentId = new FormData(event.target).get('departmentId');
    try {
      state.analytics = await api(`/api/analytics/department/${departmentId}`);
      render();
    } catch (error) {
      showError(error.message);
    }
  });
  document.querySelector('#device-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      const result = await api('/api/devices', { method: 'POST', json: { name: data.get('name'), type: data.get('type') } });
      showNotice(`Copy this device key now. It will not be shown again: ${result.apiKey}`);
      state.devices = (await api('/api/devices')).devices;
      render();
    } catch (error) {
      showError(error.message);
    }
  });
}

async function enroll(event, offeringId) {
  event.preventDefault();
  const indexNumbers = String(new FormData(event.target).get('indexes') || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  try {
    await api(`/api/offerings/${offeringId}/students`, { method: 'POST', json: { indexNumbers } });
    showNotice('Students added.');
    await loadHome();
  } catch (error) {
    showError(error.message);
  }
}

async function loadReport(offeringId) {
  try {
    state.report = await api(`/api/offerings/${offeringId}/report`);
    render();
  } catch (error) {
    showError(error.message);
  }
}

async function downloadReport(offeringId, format) {
  const path = `/api/offerings/${offeringId}/report?format=${format}`;
  let response = await fetch(path, { headers: { Authorization: `Bearer ${sessionStorage.getItem('access')}` } });
  if (response.status === 401 && await refreshTokens()) {
    response = await fetch(path, { headers: { Authorization: `Bearer ${sessionStorage.getItem('access')}` } });
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not download the report');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = format === 'pdf' ? 'attendance.pdf' : 'attendance.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function startSession(offeringId) {
  try {
    const result = await api('/api/sessions', { method: 'POST', json: { offeringId } });
    state.lastScan = null;
    await openSession(result.session.id);
  } catch (error) {
    showError(error.message);
  }
}

async function openSession(id) {
  stopLive();
  stopCamera();
  state.view = 'session';
  state.session = { id };
  const detail = await api(`/api/sessions/${id}`);
  state.session = detail.session;
  state.records = detail.records;
  state.roster = (await api(`/api/offerings/${detail.session.offeringId}/roster`)).students;
  if (detail.session.status === 'open') {
    state.code = await api(`/api/sessions/${id}/code`);
    state.expiresIn = state.code.expiresIn;
  }
  render();
  if (state.session.status === 'open') {
    startLive();
    startCamera();
  }
}

function startLive() {
  stopLive();
  pollTimer = setInterval(() => refreshLive().catch((error) => showError(error.message)), 4000);
  tickTimer = setInterval(() => {
    if (state.expiresIn > 0) state.expiresIn -= 1;
    const label = document.querySelector('[data-expires]');
    if (label) label.textContent = `${state.expiresIn}s`;
    if (state.expiresIn <= 0) {
      state.expiresIn = 3;
      refreshLive().catch(() => {});
    }
  }, 1000);
}

async function refreshLive() {
  if (!state.session || refreshing) return;
  refreshing = true;
  try {
    const detail = await api(`/api/sessions/${state.session.id}`);
    state.session = detail.session;
    state.records = detail.records;
    const list = document.querySelector('[data-records]');
    if (list) list.innerHTML = recordRows(detail.records);
    const stats = document.querySelector('[data-stats]');
    if (stats) stats.innerHTML = statsLine(detail.session.stats);
    if (detail.session.status === 'open') {
      state.code = await api(`/api/sessions/${state.session.id}/code`);
      state.expiresIn = state.code.expiresIn;
      const code = document.querySelector('[data-code]');
      if (code) code.textContent = state.code.rotatingCode;
    } else {
      stopLive();
      stopCamera();
      document.body.classList.remove('projector');
      render();
    }
  } finally {
    refreshing = false;
  }
}

function statsLine(stats = {}) {
  return `<span class="stat">${esc(stats.present || 0)}</span> present · <span class="stat">${esc(stats.late || 0)}</span> late · <span class="stat">${esc(stats.absent || 0)}</span> absent`;
}

function recordRows(records) {
  if (!records.length) return '<tr><td colspan="4">Nobody marked yet.</td></tr>';
  return records.map((record) => `<tr><td>${esc(record.name || 'Student')}</td><td>${esc(record.indexNumber)}</td><td>${pill(record.status)}</td><td>${esc(record.method)}</td></tr>`).join('');
}

function renderSession() {
  const open = state.session.status === 'open';
  const options = state.roster.map((student) => `<option value="${esc(student.id)}">${esc(student.name)} · ${esc(student.indexNumber)}${student.embeddingCount ? '' : ' · no face photos'}</option>`).join('');
  const scan = state.lastScan ? scanBlock(state.lastScan) : '';
  document.querySelector('#main').innerHTML = `
    <section class="session">
      <article class="card stack">
        <p class="eyebrow">${esc(state.code?.course?.code || 'Session')}</p>
        <h2>${esc(state.code?.course?.title || (open ? 'Check-in code' : 'Session closed'))}</h2>
        ${open ? `<p class="code-value" data-code>${esc(state.code?.rotatingCode || '')}</p><p class="muted">Changes in <span data-expires>${esc(state.expiresIn)}s</span>. Backup code ${esc(state.code?.sessionCode || '')}.</p>` : '<p>This lecture is closed.</p>'}
        <div class="row">
          <button id="back" class="ghost" type="button">Back</button>
          ${open ? '<button id="projector" class="ghost" type="button">Projector</button><button id="close-session" class="danger" type="button">Close session</button>' : ''}
        </div>
      </article>
      <div class="stack session-tools">
        ${open ? `<article class="card stack"><video id="camera" autoplay playsinline muted></video><div class="row"><button id="capture" type="button">Scan frame</button><input id="frame-file" type="file" accept="image/*" /><button id="use-file" class="ghost" type="button">Scan photo</button></div><div data-scan>${scan}</div></article>` : ''}
        <article class="card record-card">
          <p data-stats>${statsLine(state.session.stats)}</p>
          <table><thead><tr><th>Student</th><th>Index</th><th>Status</th><th>Method</th></tr></thead><tbody data-records>${recordRows(state.records)}</tbody></table>
        </article>
        <article class="card stack record-card">
          <h3>Manual mark</h3>
          <form id="manual-form" class="stack">
            <select name="studentId">${options}</select>
            <select name="status"><option value="present">Present</option><option value="late">Late</option><option value="absent">Absent</option><option value="excused">Excused</option></select>
            <input name="reason" placeholder="Reason" required />
            <button type="submit">Save mark</button>
          </form>
        </article>
      </div>
    </section>`;
  document.querySelector('#back').addEventListener('click', () => {
    document.body.classList.remove('projector');
    loadHome().catch((error) => showError(error.message));
  });
  document.querySelector('#projector')?.addEventListener('click', () => document.body.classList.toggle('projector'));
  document.querySelector('#close-session')?.addEventListener('click', closeSession);
  document.querySelector('#capture')?.addEventListener('click', captureFrame);
  document.querySelector('#use-file')?.addEventListener('click', scanFile);
  document.querySelector('#manual-form')?.addEventListener('submit', saveManual);
}

function scanBlock(scan) {
  const marked = (scan.marked || []).map((item) => `<li>${esc(item.name)} ${pill(item.status)}${item.duplicate ? ' already marked' : ''}</li>`).join('');
  const unmatched = (scan.unmatched || []).map((item) => `<li>${esc(item.reason)}</li>`).join('');
  return `<p>Marked</p><ul>${marked || '<li>No enrolled face matched.</li>'}</ul><p>Needs a look</p><ul>${unmatched || '<li>None.</li>'}</ul>`;
}

async function startCamera() {
  const video = document.querySelector('#camera');
  if (!video || !navigator.mediaDevices?.getUserMedia) return;
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    video.srcObject = state.stream;
  } catch {
    // A file upload still works when the browser has no camera.
  }
}

async function captureFrame() {
  const video = document.querySelector('#camera');
  if (!video?.videoWidth) {
    showError('Allow the camera, or choose a photo instead.');
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  await sendFrame(blob);
}

async function scanFile() {
  const file = document.querySelector('#frame-file')?.files?.[0];
  if (!file) {
    showError('Choose a photo first.');
    return;
  }
  await sendFrame(file);
}

async function sendFrame(blob) {
  const button = document.querySelector('#capture');
  if (button) button.disabled = true;
  try {
    const form = new FormData();
    form.append('image', blob, 'frame.jpg');
    state.lastScan = await api(`/api/sessions/${state.session.id}/recognize`, { method: 'POST', body: form });
    const slot = document.querySelector('[data-scan]');
    if (slot) slot.innerHTML = scanBlock(state.lastScan);
    showError('');
    await refreshLive();
  } catch (error) {
    showError(error.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function saveManual(event) {
  event.preventDefault();
  const data = new FormData(event.target);
  try {
    await api(`/api/sessions/${state.session.id}/manual`, {
      method: 'POST',
      json: { studentId: data.get('studentId'), status: data.get('status'), reason: data.get('reason') },
    });
    showNotice('Mark saved.');
    await refreshLive();
  } catch (error) {
    showError(error.message);
  }
}

async function closeSession() {
  if (!window.confirm('Close this lecture and mark everyone not seen as absent?')) return;
  try {
    await api(`/api/sessions/${state.session.id}/close`, { method: 'POST', json: {} });
    document.body.classList.remove('projector');
    showNotice('Session closed. Devices can still upload marks taken during the lecture.');
    await openSession(state.session.id);
  } catch (error) {
    showError(error.message);
  }
}

function renderStudent() {
  const courses = (state.attendance?.courses || []).map((course) => `
    <article class="card">
      <p class="eyebrow">${esc(course.course?.code || '')}</p>
      <h2>${esc(course.course?.title || 'Course')}</h2>
      <p class="stat">${course.percentage === null ? '—' : `${esc(course.percentage)}%`}</p>
      <p class="muted">${esc(course.present)} present · ${esc(course.late)} late · ${esc(course.absent)} absent · minimum ${esc(course.minAttendancePercent)}%${course.eligible === false ? ' · below the exam threshold' : ''}</p>
    </article>`).join('');
  const recent = (state.attendance?.recent || []).map((record) => `
    <tr>
      <td>${esc(record.course?.code)}</td>
      <td>${pill(record.status)}</td>
      <td>${esc(new Date(record.markedAt).toLocaleString())}</td>
      <td><button type="button" class="ghost" data-dispute="${esc(record.id)}">Dispute</button></td>
    </tr>`).join('');
  document.querySelector('#main').innerHTML = `
    <section class="stack">
      <article class="card stack">
        <h2>Check in</h2>
        <p class="muted">Type the code on the lecture screen.</p>
        <form id="check-in" class="row">
          <input name="code" placeholder="6-character code" maxlength="6" required />
          <button type="submit">Check in</button>
        </form>
      </article>
      <div class="grid">${courses || '<p>You are not enrolled in a course yet.</p>'}</div>
      <article class="card">
        <h2>Recent lectures</h2>
        <table><thead><tr><th>Course</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>${recent || '<tr><td colspan="4">No attendance yet.</td></tr>'}</tbody></table>
        <form id="dispute-form" class="stack" hidden>
          <input type="hidden" name="recordId" />
          <textarea name="reason" placeholder="What should be corrected?" required></textarea>
          <button type="submit">Submit dispute</button>
        </form>
      </article>
      <article class="card stack">
        <h2>Face photos</h2>
        <p class="muted">${state.face?.enrolled ? `${esc(state.face.count)} photo template${state.face.count === 1 ? '' : 's'} stored.` : 'No face template yet.'} Five clear photos from different angles work best.</p>
        <form id="face-form" class="stack">
          <label><input id="consent" type="checkbox" /> I agree to the university storing my face template for lecture attendance, under the Data Protection Act, 2012 (Act 843). Policy ${esc(state.meta.policyVersion)}.</label>
          <input id="face-files" type="file" accept="image/*" multiple />
          <label><input id="head-turn" type="checkbox" /> These include a head-turn liveness check</label>
          <div class="row"><button type="submit">Save photos</button><button id="delete-face" class="danger" type="button">Delete my face data</button></div>
        </form>
      </article>
      ${notesBlock()}
    </section>`;
  document.querySelector('#check-in').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/api/check-in', { method: 'POST', json: { code: new FormData(event.target).get('code') } });
      const name = result.course?.code || 'the lecture';
      showNotice(result.duplicate ? `You were already marked ${result.status} for ${name}.` : `Marked ${result.status} for ${name}.`);
      showError('');
      await loadHome();
    } catch (error) {
      showError(error.message);
    }
  });
  document.querySelectorAll('[data-dispute]').forEach((button) => button.addEventListener('click', () => {
    const form = document.querySelector('#dispute-form');
    form.hidden = false;
    form.elements.recordId.value = button.dataset.dispute;
  }));
  document.querySelector('#dispute-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(event.target);
    try {
      await api('/api/disputes', { method: 'POST', json: { recordId: data.get('recordId'), reason: data.get('reason'), requestedStatus: 'present' } });
      showNotice('Dispute submitted.');
      await loadHome();
    } catch (error) {
      showError(error.message);
    }
  });
  document.querySelector('#face-form').addEventListener('submit', saveFace);
  document.querySelector('#delete-face').addEventListener('click', deleteFace);
  document.querySelector('#read-notes')?.addEventListener('click', async () => {
    await api('/api/notifications/read-all', { method: 'POST', json: {} });
    state.notifications = [];
    render();
  });
}

async function saveFace(event) {
  event.preventDefault();
  if (!document.querySelector('#consent').checked) {
    showError('Consent is required before face photos can be stored.');
    return;
  }
  const files = document.querySelector('#face-files').files;
  if (!files.length) {
    showError('Choose at least one photo.');
    return;
  }
  const form = new FormData();
  form.append('consent', 'true');
  form.append('policyVersion', state.meta.policyVersion || '1.0');
  if (document.querySelector('#head-turn').checked) form.append('challenge', 'head-turn');
  for (const file of files) form.append('images', file);
  try {
    const result = await api(`/api/students/${state.user.id}/face`, { method: 'POST', body: form });
    const rejected = (result.rejected || []).map((item) => item.reason).join(' ');
    showNotice(`Stored ${result.stored} templates.${rejected ? ` Some photos were skipped: ${rejected}` : ''}`);
    showError('');
    await loadHome();
  } catch (error) {
    showError(error.message);
  }
}

async function deleteFace() {
  if (!window.confirm('Delete your stored face template?')) return;
  try {
    await api(`/api/students/${state.user.id}/face`, { method: 'DELETE' });
    showNotice('Face template deleted.');
    await loadHome();
  } catch (error) {
    showError(error.message);
  }
}

async function boot() {
  try {
    state.meta = await api('/api/meta');
  } catch {
    // The page still renders if metadata cannot be loaded.
  }
  document.querySelector('#uni-name').textContent = state.meta.universityName;
  document.title = `${state.meta.universityName} attendance`;
  if (sessionStorage.getItem('access')) {
    try {
      state.user = (await api('/api/auth/me')).user;
      await loadHome();
      return;
    } catch {
      sessionStorage.clear();
    }
  }
  render();
}

boot();
