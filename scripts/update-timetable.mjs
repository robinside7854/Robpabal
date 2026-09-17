/**
 * 구파발역 3호선 시간표 자동 업데이트
 *
 * 서울열린데이터광장(data.seoul.go.kr)의 "서울시 지하철역별 요일별 운행시간표"
 * 공공데이터를 받아서 data/line3-gupabal.json 을 새로 씁니다.
 *
 *   SEOUL_OPENAPI_KEY=발급받은키 node scripts/update-timetable.mjs
 *
 * 하는 일
 *   1) 3호선 전체 역 목록과 역코드를 받아온다
 *   2) 구파발역의 평일/토요일/휴일 × 상행/하행 출발 시간표를 받아온다
 *   3) 각 역의 평일 시간표를 받아, 같은 '열차번호'끼리 짝지어
 *      구파발 출발 → 그 역 도착까지 실제 몇 분 걸리는지 계산한다
 *   4) 값이 멀쩡한지 검사한 뒤에만 파일을 덮어쓴다 (이상하면 기존 파일 유지)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/line3-gupabal.json');

const API_KEY = process.env.SEOUL_OPENAPI_KEY;
const BASE = process.env.SEOUL_OPENAPI_BASE || 'http://openapi.seoul.go.kr:8088';

const ORIGIN_NAME = '구파발';
const LINE = '3';

/** API의 요일 코드 */
const WEEK_TAGS = { weekday: '1', saturday: '2', holiday: '3' };
/**
 * API의 상하행 코드. 3호선은 상행=대화 방향, 하행=오금 방향.
 * 이 앱은 구파발에서 도심으로 나가는 '오금 방향'만 다루므로 하행만 씁니다.
 */
const DIR_TAGS = { down: '2' };

/** 이 값보다 적게 나오면 "데이터가 깨졌다"고 보고 파일을 덮어쓰지 않습니다. */
const MIN_STATIONS = 30;
const MIN_WEEKDAY_TRAINS = 30;
/** 구파발 시발 열차가 이보다 적으면 수집이 잘못된 것으로 봅니다. */
const MIN_START_HERE = 10;

// ---------------------------------------------------------------- 유틸

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 응답 row 에서 여러 후보 키 중 처음 있는 값을 꺼냅니다. (API 필드명 변동 대비) */
function pick(row, ...keys) {
  for (const k of keys) {
    if (row[k] !== undefined && row[k] !== null && String(row[k]).trim() !== '') {
      return String(row[k]).trim();
    }
  }
  return '';
}

/** "05:30:00" / "2430" 같은 값을 자정 기준 분으로. 24시 이후도 그대로 25:10 처럼 다룹니다. */
function toMinutes(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{1,2}):?(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || min > 59) return null;
  return h * 60 + min;
}

function toHHMM(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// ---------------------------------------------------------------- API 호출

let requestCount = 0;

/** 서울 열린데이터 API를 1000건씩 끊어서 전부 받아옵니다. */
async function fetchRows(service, ...args) {
  const rows = [];
  const PAGE = 1000;
  for (let start = 1; ; start += PAGE) {
    const end = start + PAGE - 1;
    const path = [API_KEY, 'json', service, start, end, ...args].join('/');
    const url = `${BASE}/${path}/`;

    requestCount += 1;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${service} HTTP ${res.status}`);
    const json = await res.json();

    const body = json[service];
    // 데이터 없음(INFO-200)은 정상적인 "빈 결과"로 취급합니다.
    const topCode = json?.RESULT?.CODE || body?.RESULT?.CODE || '';
    if (topCode && topCode !== 'INFO-000') {
      if (topCode === 'INFO-200') return rows;
      const msg = json?.RESULT?.MESSAGE || body?.RESULT?.MESSAGE || topCode;
      throw new Error(`${service} 오류 ${topCode}: ${msg}`);
    }
    if (!body) throw new Error(`${service} 응답에 ${service} 항목이 없습니다`);

    const page = Array.isArray(body.row) ? body.row : [];
    rows.push(...page);

    const total = Number(body.list_total_count || 0);
    if (page.length < PAGE || rows.length >= total) break;
    await sleep(120); // 공공 API 예의상 약간의 간격
  }
  return rows;
}

// ---------------------------------------------------------------- 1) 역 목록

async function fetchLine3Stations() {
  const rows = await fetchRows('SearchSTNBySubwayLineInfo');
  const seen = new Map();

  for (const row of rows) {
    const lineNum = pick(row, 'LINE_NUM', 'LINE_NM');
    if (String(parseInt(lineNum.replace(/[^0-9]/g, ''), 10)) !== LINE) continue;

    const name = pick(row, 'STATION_NM', 'STATION_NM_KOR');
    const code = pick(row, 'STATION_CD');
    const frCode = pick(row, 'FR_CODE');
    if (!name || !code) continue;
    if (!seen.has(name)) seen.set(name, { name, code, no: frCode || code });
  }

  const list = [...seen.values()];
  // FR_CODE(310~353)가 곧 역 순서라서 그걸로 정렬합니다.
  list.sort((a, b) => Number(a.no) - Number(b.no));
  return list;
}

// ---------------------------------------------------------------- 2) 시간표

async function fetchStationTimetable(stationCode, weekTag, dirTag) {
  const rows = await fetchRows('SearchSTNTimeTableByIDService', stationCode, weekTag, dirTag);
  return rows
    .map((row) => {
      const leave = toMinutes(pick(row, 'LEFTTIME', 'LEFT_TIME'));
      const arrive = toMinutes(pick(row, 'ARRIVETIME', 'ARRIVE_TIME'));
      const trainNo = pick(row, 'TRAIN_NO', 'TRAINNO');
      const expressRaw = pick(row, 'EXPRESS_YN', 'EXPRESS');
      return {
        trainNo,
        leave: leave ?? arrive,
        arrive: arrive ?? leave,
        express: /^(Y|E|D|1|급행)/i.test(expressRaw) ? 1 : 0,
        // 시발역. 구파발에서 처음 출발하는 열차인지 가리는 데 씁니다.
        start: pick(row, 'SUBWAYSNAME', 'ORG_STATION_NM', 'SUBWAYSNAME_H'),
        dest: pick(row, 'SUBWAYENAME', 'DEST_STATION_NM', 'SUBWAYENAME_H'),
      };
    })
    .filter((t) => t.leave !== null && t.trainNo);
}

/**
 * 구파발에서 운행을 마치는 열차를 걸러냅니다.
 *
 * 종착 열차는 여기서 더 출발하지 않으므로 API가 출발시각(LEFTTIME)에
 * 00:00:00 을 보냅니다. 그대로 두면 '자정 출발 열차'로 오인되어
 * 출발 시간표 맨 앞에 유령 열차가 잔뜩 쌓입니다.
 *
 * 도착 시각만 쓰는 '도착역' 시간표에는 적용하면 안 됩니다. 그 역이 종착역인
 * 열차까지 사라져 소요시간을 못 구하게 됩니다. 출발역 시간표에만 씁니다.
 */
function onlyDeparting(trains, originName) {
  return trains.filter((t) => t.dest !== originName && t.leave !== 0);
}

// ---------------------------------------------------------------- 3) 역간 소요시간

function rideMinutesFrom(originTrains, destTrains) {
  const destByTrain = new Map();
  for (const t of destTrains) {
    if (!destByTrain.has(t.trainNo)) destByTrain.set(t.trainNo, t);
  }

  const normal = [];
  const express = [];
  for (const o of originTrains) {
    const d = destByTrain.get(o.trainNo);
    if (!d) continue;
    let diff = d.arrive - o.leave;
    if (diff < 0) diff += 24 * 60; // 자정을 넘긴 경우
    if (diff <= 0 || diff > 180) continue; // 말도 안 되는 값은 버림
    (o.express ? express : normal).push(diff);
  }

  return {
    ride: median(normal) ?? median(express),
    rideExpress: median(express),
    matched: normal.length + express.length,
  };
}

// ---------------------------------------------------------------- 메인

async function main() {
  if (!API_KEY) {
    console.error(
      '오류: 환경변수 SEOUL_OPENAPI_KEY 가 없습니다.\n' +
      '      https://data.seoul.go.kr 에서 무료 인증키를 발급받아 넣어주세요.\n' +
      '      (GitHub 저장소 > Settings > Secrets > Actions 에 SEOUL_OPENAPI_KEY 로 등록)'
    );
    process.exit(1);
  }

  console.log('1/3 3호선 역 목록을 받는 중...');
  const line3 = await fetchLine3Stations();
  const origin = line3.find((s) => s.name === ORIGIN_NAME);
  if (!origin) throw new Error(`3호선 역 목록에서 ${ORIGIN_NAME}역을 찾지 못했습니다`);
  console.log(`    ${line3.length}개 역 확인 (${ORIGIN_NAME} 코드 ${origin.code})`);

  console.log('2/3 구파발역 시간표를 받는 중...');
  const timetable = {};
  const originTrains = {}; // 소요시간 계산에 쓸 평일 원본
  for (const [dayKey, weekTag] of Object.entries(WEEK_TAGS)) {
    timetable[dayKey] = {};
    for (const [dirKey, dirTag] of Object.entries(DIR_TAGS)) {
      const raw = await fetchStationTimetable(origin.code, weekTag, dirTag);
      const trains = onlyDeparting(raw, ORIGIN_NAME);
      trains.sort((a, b) => a.leave - b.leave);
      if (dayKey === 'weekday') originTrains[dirKey] = trains;
      timetable[dayKey][dirKey] = trains.map((t) => ({
        t: toHHMM(t.leave),
        x: t.express,
        // s:1 = 구파발이 시발역인 열차 (빈 차로 출발해 앉아서 갈 수 있음)
        s: t.start === ORIGIN_NAME ? 1 : 0,
        ...(t.start ? { from: t.start } : {}),
        ...(t.dest ? { dest: t.dest } : {}),
      }));
      const dropped = raw.length - trains.length;
      const startHere = timetable[dayKey][dirKey].filter((t) => t.s).length;
      console.log(
        `    ${dayKey}/${dirKey}: ${trains.length}편` +
        ` (${ORIGIN_NAME} 시발 ${startHere}편 / 경유 ${trains.length - startHere}편)` +
        (dropped ? ` · ${ORIGIN_NAME} 종착 ${dropped}편 제외` : '')
      );
    }
  }

  console.log('3/3 역별 소요시간을 계산하는 중...');
  const originNo = Number(origin.no);
  const stations = [];
  for (const st of line3) {
    // 구파발보다 앞선 역(대화 방향)은 이 앱의 대상이 아닙니다.
    if (Number(st.no) <= originNo) continue;
    const destTrains = await fetchStationTimetable(st.code, WEEK_TAGS.weekday, DIR_TAGS.down);
    const { ride, rideExpress, matched } = rideMinutesFrom(originTrains.down || [], destTrains);
    stations.push({ no: st.no, name: st.name, code: st.code, direction: 'down', ride, rideExpress });
    console.log(`    ${st.name}: ${ride ?? '?'}분 (일치 열차 ${matched}편)`);
  }

  // --- 안전장치: 결과가 멀쩡할 때만 덮어쓴다 -------------------------
  const problems = [];
  if (stations.length < MIN_STATIONS) problems.push(`역 수가 ${stations.length}개뿐입니다`);
  if ((timetable.weekday?.down?.length || 0) < MIN_WEEKDAY_TRAINS) {
    problems.push(`평일 오금방향 열차가 ${timetable.weekday?.down?.length || 0}편뿐입니다`);
  }
  const missingRide = stations.filter((s) => !s.ride).map((s) => s.name);
  if (missingRide.length > stations.length / 2) {
    problems.push(`소요시간을 못 구한 역이 너무 많습니다 (${missingRide.length}개)`);
  }
  // 이 앱의 핵심은 '구파발 시발 열차'입니다. 하나도 못 가려냈다면
  // API 필드명이 바뀐 것이므로, 잘못된 데이터를 내보내지 않고 멈춥니다.
  const startHereCount = (timetable.weekday?.down || []).filter((t) => t.s).length;
  if (startHereCount < MIN_START_HERE) {
    problems.push(
      `${ORIGIN_NAME} 시발 열차를 ${startHereCount}편밖에 못 찾았습니다` +
      ' (시발역 필드명이 바뀌었을 수 있습니다)'
    );
  }
  if (problems.length) {
    console.error('\n검증 실패 — 기존 데이터를 그대로 둡니다:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  // 소요시간을 못 구한 역은 기존 파일의 값을 살려둡니다.
  let previous = null;
  try {
    previous = JSON.parse(readFileSync(OUT, 'utf8'));
  } catch { /* 기존 파일이 없으면 무시 */ }
  if (previous?.stations && missingRide.length) {
    const prevByName = new Map(previous.stations.map((s) => [s.name, s]));
    for (const s of stations) {
      if (!s.ride && prevByName.get(s.name)?.ride) s.ride = prevByName.get(s.name).ride;
    }
  }

  const data = {
    meta: {
      line: LINE,
      origin: { no: origin.no, name: origin.name, code: origin.code },
      directions: {
        down: { label: '오금 방향', terminal: '오금' },
      },
      updatedAt: new Date().toISOString(),
      source: 'seoul-open-api',
      sourceLabel: '서울열린데이터광장 · 서울시 지하철역별 요일별 운행시간표',
      sourceUrl: 'https://data.seoul.go.kr/',
      rideEstimated: false,
      notes: missingRide.length
        ? [`소요시간을 직접 구하지 못해 이전 값을 유지한 역: ${missingRide.join(', ')}`]
        : [],
    },
    stations,
    timetable,
  };

  writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log(`\n완료! ${OUT} 갱신 (API 호출 ${requestCount}회)`);
}

main().catch((err) => {
  console.error(`\n실패: ${err.message}`);
  process.exit(1);
});
