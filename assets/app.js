/* 구파발 출근길 — 3호선 출근 도우미
 *
 * 계산 방식
 *   집에서 나갈 시각 = 열차 출발 시각 − (집→구파발 도보 + 여유 버퍼)
 *   사무실 도착 시각 = 열차 출발 시각 + (구파발→도착역 소요 + 도착역→사무실 도보)
 *   여유 = 목표 도착 시각 − 사무실 도착 시각
 */
'use strict';

const DATA_URL = 'data/line3-gupabal.json';
const LS_SETTINGS = 'gupabal.settings.v1';
const LS_FAVS = 'gupabal.favorites.v1';

/** 새벽 4시 이전은 '전날 운행일'로 봅니다. (24:02 같은 막차 표기를 맞추기 위함) */
const DAY_START_HOUR = 4;
/** 다음 열차를 몇 개까지 보여줄지 */
const TRAIN_COUNT = 5;
/** 카운트다운 링이 꽉 차는 기준 시간 */
const RING_FULL_SEC = 60 * 60;
/** 시간표를 다시 받아오는 주기 */
const REFRESH_MS = 6 * 60 * 60 * 1000;

const DAY_LABEL = { weekday: '평일', saturday: '토요일', holiday: '휴일' };

// ------------------------------------------------------------------ 상태

let data = null;
let dataError = null;
let lastFetch = 0;

let settings = { homeWalk: 15, buffer: 0, dayType: 'auto', activeFav: null };
let favs = [];
let editingId = null;

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ 저장소

function loadStore() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_SETTINGS) || 'null');
    if (s && typeof s === 'object') settings = { ...settings, ...s };
  } catch { /* 저장소를 못 읽어도 기본값으로 동작합니다 */ }
  try {
    const f = JSON.parse(localStorage.getItem(LS_FAVS) || 'null');
    if (Array.isArray(f)) favs = f.filter((x) => x && x.station);
  } catch { /* 위와 동일 */ }
}

function saveStore() {
  try {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings));
    localStorage.setItem(LS_FAVS, JSON.stringify(favs));
  } catch { /* 시크릿 모드 등에서 저장이 막혀도 이번 세션은 정상 동작합니다 */ }
}

// ------------------------------------------------------------------ 시간 유틸

const pad2 = (n) => String(n).padStart(2, '0');

/** "07:42" → 자정 기준 분 (24:02 처럼 24시 이후 표기도 그대로 1442분이 됩니다) */
function hhmmToMin(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 자정 기준 분 → "HH:MM" (24시 이후는 00시대로 되돌립니다) */
function minToHHMM(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}`;
}

const secToHHMM = (sec) => minToHHMM(sec / 60);

/** 지금이 운행일 기준 몇 초째인지 */
function serviceSec(now) {
  const s = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  return now.getHours() < DAY_START_HOUR ? s + 86400 : s;
}

/** 새벽 시간대를 전날로 되돌린 '운행일' 날짜 */
function serviceDate(now) {
  const d = new Date(now);
  if (now.getHours() < DAY_START_HOUR) d.setDate(d.getDate() - 1);
  return d;
}

/** 목표 시각도 같은 기준(운행일 초)으로 맞춥니다 */
function targetSec(hhmm) {
  const min = hhmmToMin(hhmm);
  if (min === null) return null;
  const sec = min * 60;
  return sec < DAY_START_HOUR * 3600 ? sec + 86400 : sec;
}

/** 1830 → "30분 30초" 같은 사람이 읽는 표기 */
function humanDur(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}시간 ${m}분`;
  if (m > 0) return `${m}분 ${s % 60}초`;
  return `${s}초`;
}

/** 여유 시간을 "+12분" / "−5분" 으로 */
function signedMin(sec) {
  const m = Math.round(sec / 60);
  if (m === 0) return '딱 맞음';
  return m > 0 ? `${m}분 여유` : `${Math.abs(m)}분 지각`;
}

// ------------------------------------------------------------------ 데이터

async function fetchData() {
  try {
    const res = await fetch(`${DATA_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`시간표 파일을 불러오지 못했습니다 (HTTP ${res.status})`);
    const json = await res.json();
    if (!json?.stations?.length || !json?.timetable) throw new Error('시간표 파일 형식이 올바르지 않습니다');
    data = json;
    dataError = null;
    lastFetch = Date.now();
    fillStationSelect();
  } catch (err) {
    dataError = err.message;
    if (!data) console.error(err);
  }
  render();
}

const stationByName = (name) => data?.stations.find((s) => s.name === name) || null;

function resolveDayType(now) {
  if (settings.dayType !== 'auto') return settings.dayType;
  const d = serviceDate(now).getDay();
  if (d === 0) return 'holiday';
  if (d === 6) return 'saturday';
  return 'weekday';
}

/** 열차 한 편에 대한 모든 계산 */
function planTrain(train, station, fav, nowSec) {
  const depSec = hhmmToMin(train.t) * 60;
  const ride = train.x && station.rideExpress != null ? station.rideExpress : station.ride;
  const walkOut = Number(fav.officeWalk) || 0;

  const leaveSec = depSec - (settings.homeWalk + settings.buffer) * 60;
  const arriveSec = ride == null ? null : depSec + (ride + walkOut) * 60;
  const goal = targetSec(fav.target);
  const slackSec = arriveSec != null && goal != null ? goal - arriveSec : null;

  return {
    train,
    ride,
    depSec,
    leaveSec,
    arriveSec,
    slackSec,
    totalSec: arriveSec == null ? null : arriveSec - nowSec,
    untilLeaveSec: leaveSec - nowSec,
    untilDepSec: depSec - nowSec,
    onTime: slackSec == null ? null : slackSec >= 0,
    targetPassed: goal != null && nowSec > goal,
  };
}

// ------------------------------------------------------------------ 즐겨찾기

const activeFav = () => favs.find((f) => f.id === settings.activeFav) || favs[0] || null;

function renderFavBar() {
  const bar = $('favBar');
  const cur = activeFav();
  const parts = favs.map((f) => {
    const on = cur && f.id === cur.id ? ' on' : '';
    return `<button class="fav-tab${on}" type="button" data-fav="${f.id}">
      ${escapeHtml(f.label || f.station)}<span class="sub">${escapeHtml(f.target)}</span>
    </button>`;
  });
  if (cur) parts.push(`<button class="fav-tab" type="button" data-edit="${cur.id}">⚙ 수정</button>`);
  parts.push('<button class="fav-tab add" type="button" data-add="1">＋ 도착역 추가</button>');
  bar.innerHTML = parts.join('');
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fillStationSelect() {
  const sel = $('favStation');
  if (!sel || !data) return;
  const prev = sel.value;
  const groups = { down: [], up: [] };
  for (const s of data.stations) (groups[s.direction] || groups.down).push(s);
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => (a.ride ?? 999) - (b.ride ?? 999));
  }
  const label = (key) => data.meta?.directions?.[key]?.label || key;
  sel.innerHTML = ['down', 'up']
    .filter((k) => groups[k].length)
    .map((k) => `<optgroup label="${escapeHtml(label(k))}">${groups[k]
      .map((s) => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}${
        s.ride != null ? ` (${s.ride}분)` : ''}</option>`)
      .join('')}</optgroup>`)
    .join('');
  if (prev) sel.value = prev;
}

function openFavDialog(id) {
  editingId = id || null;
  const f = id ? favs.find((x) => x.id === id) : null;
  $('favDialogTitle').textContent = f ? '도착역 수정' : '도착역 추가';
  $('favLabel').value = f?.label || '';
  $('favOfficeWalk').value = f?.officeWalk ?? 5;
  $('favTarget').value = f?.target || '09:00';
  fillStationSelect();
  if (f) $('favStation').value = f.station;
  else if ($('favStation').options.length) $('favStation').selectedIndex = 0;
  $('favDelete').hidden = !f;
  $('favDialog').showModal();
}

function saveFav() {
  const station = $('favStation').value;
  if (!station) return;
  const payload = {
    station,
    label: ($('favLabel').value || '').trim() || station,
    officeWalk: clampNum($('favOfficeWalk').value, 0, 120, 5),
    target: /^\d{2}:\d{2}$/.test($('favTarget').value) ? $('favTarget').value : '09:00',
  };
  if (editingId) {
    const f = favs.find((x) => x.id === editingId);
    if (f) Object.assign(f, payload);
  } else {
    const id = `f${Date.now().toString(36)}`;
    favs.push({ id, ...payload });
    settings.activeFav = id;
  }
  saveStore();
  $('favDialog').close();
  render();
}

function deleteFav() {
  favs = favs.filter((f) => f.id !== editingId);
  if (settings.activeFav === editingId) settings.activeFav = favs[0]?.id || null;
  saveStore();
  $('favDialog').close();
  render();
}

function clampNum(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ------------------------------------------------------------------ 화면 그리기

function render() {
  const now = new Date();
  renderClock(now);
  renderFavBar();

  const fav = activeFav();
  const hasFav = Boolean(fav);
  $('noFav').hidden = hasFav;
  $('summary').hidden = !hasFav;
  $('trainsPanel').hidden = !hasFav;

  if (hasFav && data) renderPlan(fav, now);
  renderSchedule(now);
  renderFoot();
}

function renderClock(now) {
  $('clock').textContent =
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const sd = serviceDate(now);
  const dayType = resolveDayType(now);
  const auto = settings.dayType === 'auto' ? '' : ' (직접 선택)';
  $('dateLine').innerHTML =
    `${sd.getFullYear()}년 ${sd.getMonth() + 1}월 ${sd.getDate()}일 (${days[sd.getDay()]}) · ` +
    `<span class="daytype">${DAY_LABEL[dayType]} 시간표${auto}</span>`;
}

function renderPlan(fav, now) {
  const station = stationByName(fav.station);
  const dayType = resolveDayType(now);
  const nowSec = serviceSec(now);
  const dirKey = station?.direction || 'down';
  const dirLabel = data.meta?.directions?.[dirKey]?.label || '';
  const list = data.timetable?.[dayType]?.[dirKey] || [];

  $('dirLabel').textContent = dirLabel;
  $('deadlineLabel').textContent = '집에서 출발';
  $('sumRoute').innerHTML =
    `구파발<span class="arrow">→</span>${escapeHtml(fav.station)}` +
    `<span class="arrow">→</span>${escapeHtml(fav.label)}`;

  if (!station) {
    $('sumTarget').textContent = `'${fav.station}'역 정보를 찾을 수 없습니다.`;
    setDeadline('–', '역 정보 없음', '', 'bad');
    $('trains').innerHTML = emptyBox('시간표 데이터에 없는 역입니다. 즐겨찾기를 다시 설정해주세요.');
    return;
  }

  const ridePart = station.ride != null
    ? `열차 ${station.ride}분`
    : '열차 소요시간 정보 없음';
  $('sumTarget').innerHTML =
    `목표 도착 <b>${escapeHtml(fav.target)}</b> · ${escapeHtml(ridePart)}` +
    (data.meta?.rideEstimated ? ' <span title="자동 업데이트 전이라 추정치입니다">(추정)</span>' : '');

  $('statHome').textContent = `${settings.homeWalk}분`;
  $('statRide').textContent = station.ride != null ? `${station.ride}분` : '–';
  $('statOffice').textContent = `${Number(fav.officeWalk) || 0}분`;

  if (!list.length) {
    setDeadline('–', '시간표 없음', '', 'bad');
    $('trains').innerHTML = emptyBox(
      `${DAY_LABEL[dayType]} ${dirLabel} 시간표가 아직 비어 있습니다.<br>` +
      'README의 <b>자동 업데이트 켜기</b>를 따라 한 번 실행하면 채워집니다.'
    );
    return;
  }

  const plans = list.map((t) => planTrain(t, station, fav, nowSec));
  const targetPassed = plans[0]?.targetPassed === true;

  // --- 목표 시각을 지킬 수 있는 마지막 열차 = 오늘의 데드라인 ---
  const onTime = plans.filter((p) => p.onTime);
  const lastChance = onTime.length ? onTime[onTime.length - 1] : null;

  if (targetPassed) {
    // 오늘 목표 시각이 이미 지난 시간대 — 지각 분수를 세는 건 의미가 없습니다.
    // 지금 나가서 실제로 탈 수 있는 첫 열차를 기준으로 안내합니다.
    const next = plans.find((p) => p.untilDepSec > 0 && p.untilLeaveSec > 0)
      || plans.find((p) => p.untilDepSec > 0);
    if (next) {
      setDeadline(
        secToHHMM(next.leaveSec),
        `오늘 목표 시각 ${escapeHtml(fav.target)}은 이미 지났습니다` +
        `<br>다음 열차 ${secToHHMM(next.depSec)} · ${escapeHtml(fav.label)} 도착 ${secToHHMM(next.arriveSec)}`,
        next.untilLeaveSec > 0 ? humanDur(next.untilLeaveSec) : '',
        next.untilLeaveSec > 0 ? 'ok' : 'warn',
        next.untilLeaveSec > 0 ? '남음' : '지금 출발'
      );
    } else {
      setDeadline('–', '오늘 운행이 끝났습니다', '', 'bad', '운행 종료');
    }
    $('deadlineLabel').textContent = '다음 열차 · 집에서 출발';
  } else if (!lastChance) {
    setDeadline('–', `${fav.target}까지 도착 가능한 열차가 없습니다`, '', 'bad');
  } else if (lastChance.untilLeaveSec <= 0) {
    // 지금 집에서 나가서 실제로 탈 수 있는 첫 열차를 알려줍니다.
    const stillRunning = plans.find((p) => p.untilDepSec > 0 && p.untilLeaveSec > 0);
    const next = stillRunning
      ? `지금 나가면 ${secToHHMM(stillRunning.depSec)} 열차 · 도착 ${secToHHMM(stillRunning.arriveSec)}` +
        (stillRunning.slackSec != null ? ` (${signedMin(stillRunning.slackSec)})` : '')
      : '오늘 탈 수 있는 열차가 없습니다';
    setDeadline(
      secToHHMM(lastChance.leaveSec),
      `${escapeHtml(fav.target)} 도착 막차(${secToHHMM(lastChance.depSec)})의 출발 시각이 지났습니다` +
        `<br>${escapeHtml(next)}`,
      '지각',
      'bad',
      '확정'
    );
  } else {
    const cls = lastChance.untilLeaveSec < 5 * 60 ? 'warn' : 'ok';
    setDeadline(
      secToHHMM(lastChance.leaveSec),
      `${escapeHtml(fav.target)} 도착 막차는 ${secToHHMM(lastChance.depSec)} 열차 · ` +
      `남은 열차 ${onTime.filter((p) => p.untilDepSec > 0).length}편`,
      humanDur(lastChance.untilLeaveSec),
      cls
    );
  }

  // --- 다음 열차 카드 ---
  const upcoming = plans.filter((p) => p.untilDepSec > 0);
  const catchable = upcoming.filter((p) => p.untilLeaveSec > 0);
  const missed = upcoming.filter((p) => p.untilLeaveSec <= 0);
  const show = (catchable.length ? catchable : upcoming).slice(0, TRAIN_COUNT);

  const note = catchable.length && missed.length
    ? `<p class="hint" style="margin:-2px 0 4px">지금 나가면 ` +
      `${missed.slice(0, 3).map((p) => secToHHMM(p.depSec)).join('·')}` +
      `${missed.length > 3 ? ` 외 ${missed.length - 3}편` : ''} 열차는 이미 탈 수 없어 건너뛰었습니다.</p>`
    : '';

  $('trains').innerHTML = show.length
    ? note + show.map(trainCard).join('')
    : emptyBox('오늘 남은 열차가 없습니다. 내일 첫차를 기다려주세요.');
}

function setDeadline(time, note, count, cls, countLabel) {
  $('deadlineTime').textContent = time;
  $('deadlineNote').innerHTML = note;
  const el = $('deadlineCount');
  el.className = `deadline-count ${cls}`;
  el.innerHTML = count
    ? `${escapeHtml(count)}<small>${countLabel || '남음'}</small>`
    : `<small>${countLabel || '–'}</small>`;
}

function trainCard(p) {
  const remain = p.untilLeaveSec;
  let cls = 'ok';
  let status = `여유 ${Math.floor(remain / 60)}분`;
  let stroke = 'var(--ok)';

  if (remain <= 0) {
    cls = 'bad';
    status = '출발 시각 지남';
    stroke = 'var(--bad)';
  } else if (remain < 5 * 60) {
    cls = 'warn';
    status = remain < 60 ? '지금 바로 출발!' : '서둘러 출발하세요';
    stroke = 'var(--warn)';
  }
  if (p.onTime === false && remain > 0) {
    // 탈 수는 있지만 목표 시각에는 늦는 열차
    cls = 'warn';
    stroke = 'var(--warn)';
  }

  const ratio = remain <= 0 ? 0 : Math.min(1, remain / RING_FULL_SEC);
  const dash = (150.8 * (1 - ratio)).toFixed(1);
  const mm = Math.max(0, Math.floor(remain / 60));
  const ss = Math.max(0, Math.floor(remain % 60));

  // 집에서 나갈 시각이 이미 지난 열차는 '여유'가 아니라 '탈 수 없음'으로 보여줍니다.
  const missed = remain <= 0;
  const slackCls = missed ? 'bad'
    : p.targetPassed ? ''
    : p.slackSec == null ? ''
    : p.slackSec >= 5 * 60 ? 'ok'
    : p.slackSec >= 0 ? 'warn' : 'bad';
  const slackTxt = missed ? '탑승 불가'
    : p.targetPassed && p.totalSec != null ? `도착까지 ${Math.round(p.totalSec / 60)}분`
    : p.slackSec == null ? status
    : signedMin(p.slackSec);

  return `
  <article class="train ${cls}">
    <div class="ring">
      <svg viewBox="0 0 58 58" aria-hidden="true">
        <circle class="bg" cx="29" cy="29" r="24"></circle>
        <circle class="fg" cx="29" cy="29" r="24" stroke="${stroke}" stroke-dashoffset="${dash}"></circle>
      </svg>
      <div class="ring-txt">
        ${remain <= 0
          ? '<span class="m">–</span>'
          : `<span class="m">${mm > 0 ? mm + '분' : ss + '초'}</span>${
              mm > 0 ? `<span class="s">${ss}초</span>` : ''}`}
      </div>
    </div>

    <div class="train-body">
      <div class="train-top">
        <span class="train-dep">${secToHHMM(p.depSec)}</span>
        <span class="train-dep-label">열차</span>
        ${p.train.x ? '<span class="badge">급행</span>' : ''}
      </div>
      <div class="train-leave">
        <span class="k">집에서 출발</span>
        <span class="v">${secToHHMM(p.leaveSec)}</span>
      </div>
      <div class="bar"><i style="width:${(remain <= 0 ? 0 : Math.min(100, (remain / RING_FULL_SEC) * 100)).toFixed(1)}%"></i></div>
      <div class="train-foot">
        <span class="train-arrive">사무실 도착 <b>${p.arriveSec != null ? secToHHMM(p.arriveSec) : '–'}</b></span>
        <span class="train-slack ${slackCls}">${slackTxt}</span>
      </div>
    </div>
  </article>`;
}

const emptyBox = (html) => `<div class="empty">${html}</div>`;

// ------------------------------------------------------------------ 전체 시간표

function renderSchedule(now) {
  const body = $('schedBody');
  if (body.hidden || !data) return;

  const fav = activeFav();
  const station = fav ? stationByName(fav.station) : null;
  const dirKey = station?.direction || 'down';
  const dayType = resolveDayType(now);
  const list = data.timetable?.[dayType]?.[dirKey] || [];
  const nowSec = serviceSec(now);

  if (!list.length) {
    body.innerHTML = emptyBox(
      `${DAY_LABEL[dayType]} ${escapeHtml(data.meta?.directions?.[dirKey]?.label || '')} ` +
      '시간표가 아직 비어 있습니다.'
    );
    return;
  }

  const nextIdx = list.findIndex((t) => hhmmToMin(t.t) * 60 > nowSec);
  const byHour = new Map();
  list.forEach((t, i) => {
    const min = hhmmToMin(t.t);
    const h = Math.floor(min / 60);
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push({ t, i, mm: min % 60, sec: min * 60 });
  });

  const rows = [...byHour.entries()].map(([h, items]) => `
    <tr>
      <td class="hour">${pad2(h % 24)}시</td>
      <td class="mins">${items.map((it) => {
        const c = [it.i === nextIdx ? 'next' : it.sec <= nowSec ? 'gone' : '', it.t.x ? 'ex' : '']
          .filter(Boolean).join(' ');
        return `<span class="mm ${c}">${pad2(it.mm)}</span>`;
      }).join('')}</td>
    </tr>`).join('');

  body.innerHTML = `
    <p class="hint" style="margin-bottom:10px">
      ${escapeHtml(DAY_LABEL[dayType])} ·
      ${escapeHtml(data.meta?.directions?.[dirKey]?.label || '')} ·
      총 ${list.length}편 · 테두리 있는 숫자는 급행
    </p>
    <table class="sched-table">
      <thead><tr><th>시</th><th>분</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ------------------------------------------------------------------ 푸터

function renderFoot() {
  const foot = $('foot');
  if (dataError && !data) {
    foot.innerHTML = `<span class="stale">시간표를 불러오지 못했습니다: ${escapeHtml(dataError)}</span>`;
    return;
  }
  if (!data) { foot.textContent = '시간표를 불러오는 중...'; return; }

  const updated = new Date(data.meta?.updatedAt || Date.now());
  const days = Math.floor((Date.now() - updated.getTime()) / 86400000);
  const isSeed = data.meta?.source === 'seed';
  const stale = isSeed || days > 30;

  const when = `${updated.getFullYear()}.${pad2(updated.getMonth() + 1)}.${pad2(updated.getDate())}` +
    (days > 0 ? ` (${days}일 전)` : ' (오늘)');

  foot.innerHTML =
    `시간표 기준 ${when} · ${escapeHtml(data.meta?.sourceLabel || '')}` +
    (data.meta?.sourceUrl
      ? ` · <a href="${escapeHtml(data.meta.sourceUrl)}" target="_blank" rel="noopener">출처</a>`
      : '') +
    (stale
      ? `<br><span class="stale">${isSeed
          ? '아직 손으로 넣은 초기 데이터입니다. 자동 업데이트를 켜면 최신 시간표로 바뀝니다.'
          : '한 달 넘게 갱신되지 않았습니다.'}</span>`
      : '') +
    '<br>※ 공휴일은 자동 인식하지 않습니다. 설정에서 요일 기준을 직접 골라주세요.' +
    '<br>※ 실제 운행은 상황에 따라 달라질 수 있습니다.';
}

// ------------------------------------------------------------------ 이벤트

function bindEvents() {
  $('favBar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.add) return openFavDialog(null);
    if (btn.dataset.edit) return openFavDialog(btn.dataset.edit);
    if (btn.dataset.fav) {
      settings.activeFav = btn.dataset.fav;
      saveStore();
      render();
    }
  });

  $('favSave').addEventListener('click', saveFav);
  $('favCancel').addEventListener('click', () => $('favDialog').close());
  $('favDelete').addEventListener('click', deleteFav);

  $('homeWalk').addEventListener('input', (e) => {
    settings.homeWalk = clampNum(e.target.value, 0, 180, 15);
    saveStore();
    render();
  });
  $('buffer').addEventListener('input', (e) => {
    settings.buffer = clampNum(e.target.value, 0, 60, 0);
    saveStore();
    render();
  });
  $('dayType').addEventListener('change', (e) => {
    settings.dayType = e.target.value;
    saveStore();
    render();
  });

  $('schedToggle').addEventListener('click', () => {
    const body = $('schedBody');
    body.hidden = !body.hidden;
    $('schedToggle').textContent = body.hidden ? '시간표 펼치기' : '시간표 접기';
    render();
  });

  // 화면을 다시 켰을 때 오래된 데이터면 새로 받아옵니다.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - lastFetch > REFRESH_MS) fetchData();
  });
}

// ------------------------------------------------------------------ 시작

function init() {
  loadStore();
  $('homeWalk').value = settings.homeWalk;
  $('buffer').value = settings.buffer;
  $('dayType').value = settings.dayType;
  bindEvents();
  render();
  fetchData();
  setInterval(render, 1000);
  setInterval(() => { if (Date.now() - lastFetch > REFRESH_MS) fetchData(); }, 60 * 60 * 1000);
}

document.addEventListener('DOMContentLoaded', init);
