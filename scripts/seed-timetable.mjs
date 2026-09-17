/**
 * 시드(초기) 시간표 생성기
 *
 * 서울열린데이터광장 API 키가 아직 없거나 자동 업데이트가 한 번도 돌지 않았을 때
 * 앱이 빈 화면을 보여주지 않도록, 손으로 입력한 평일 오금방향 시간표를 넣어 둡니다.
 *
 *   node scripts/seed-timetable.mjs
 *
 * 자동 업데이트(scripts/update-timetable.mjs)가 성공하면 이 파일이 만든 내용은
 * 실제 공공데이터로 통째로 교체됩니다.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'data/line3-gupabal.json');

/** 3호선 전체 역 (대화 310 ~ 오금 353). 구파발은 321번. */
const GUPABAL_NO = 321;

/** 구파발 기준 '오금 방향'(하행) 역: [역번호, 역이름, 구파발에서 걸리는 분] */
const DOWN = [
  [322, '연신내', 2], [323, '불광', 4], [324, '녹번', 6], [325, '홍제', 8],
  [326, '무악재', 10], [327, '독립문', 12], [328, '경복궁', 15], [329, '안국', 17],
  [330, '종로3가', 19], [331, '을지로3가', 21], [332, '충무로', 23], [333, '동대입구', 25],
  [334, '약수', 27], [335, '금호', 29], [336, '옥수', 31], [337, '압구정', 34],
  [338, '신사', 36], [339, '잠원', 38], [340, '고속터미널', 40], [341, '교대', 42],
  [342, '남부터미널', 44], [343, '양재', 46], [344, '매봉', 48], [345, '도곡', 50],
  [346, '대치', 52], [347, '학여울', 54], [348, '대청', 56], [349, '일원', 58],
  [350, '수서', 60], [351, '가락시장', 63], [352, '경찰병원', 65], [353, '오금', 67],
];

/** 구파발 기준 '대화 방향'(상행) 역 */
const UP = [
  [320, '지축', 2], [319, '삼송', 4], [318, '원흥', 6], [317, '원당', 9],
  [316, '화정', 11], [315, '대곡', 14], [314, '백석', 16], [313, '마두', 18],
  [312, '정발산', 20], [311, '주엽', 22], [310, '대화', 24],
];

/**
 * 평일 오금방향 구파발 출발 시각. "HH:MM" 또는 급행이면 "HH:MM!"
 * 24시대는 자정 이후(다음날 00시대) 열차를 뜻합니다.
 */
const WEEKDAY_DOWN = `
05:30 05:38 05:56
06:09 06:28 06:45 06:56
07:05 07:13 07:21 07:31 07:42 07:49 07:57
08:04 08:11! 08:19! 08:33 08:45 08:53!
09:01! 09:09! 09:18 09:28! 09:56!
10:21 10:58
11:17 11:30 11:56
12:15 12:35
13:52
14:12 14:31 14:52
15:11
16:28 16:41 16:51
17:04 17:12 17:20 17:28 17:51
18:00! 18:08 18:16! 18:24! 18:32 18:40 18:50
19:03 19:13 19:28 19:38! 19:48 19:58
20:14 20:30! 20:40
21:00 21:12
22:10! 22:42!
23:44
24:02!
`;

function parseTrains(block) {
  return block
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => {
      const express = token.endsWith('!');
      const time = express ? token.slice(0, -1) : token;
      if (!/^\d{2}:\d{2}$/.test(time)) throw new Error(`시간 형식 오류: ${token}`);
      return { t: time, x: express ? 1 : 0 };
    });
}

function stations(list, direction) {
  return list.map(([no, name, ride]) => ({
    no: String(no),
    name,
    direction,
    ride,
    rideExpress: null,
  }));
}

const data = {
  meta: {
    line: '3',
    origin: { no: String(GUPABAL_NO), name: '구파발' },
    directions: {
      up: { label: '대화 방향', terminal: '대화' },
      down: { label: '오금 방향', terminal: '오금' },
    },
    updatedAt: new Date().toISOString(),
    source: 'seed',
    sourceLabel: '수동 입력(시드 데이터)',
    rideEstimated: true,
    notes: [
      '평일 오금방향 시간표만 손으로 입력된 초기 데이터입니다.',
      '역간 소요시간은 역당 약 2분으로 잡은 추정치입니다.',
      'GitHub Actions 자동 업데이트가 한 번 성공하면 전부 실제 공공데이터로 바뀝니다.',
    ],
  },
  stations: [...stations(UP, 'up'), ...stations(DOWN, 'down')],
  timetable: {
    weekday: { down: parseTrains(WEEKDAY_DOWN), up: [] },
    saturday: { down: [], up: [] },
    holiday: { down: [], up: [] },
  },
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log(
  `시드 시간표 생성 완료: ${OUT}\n` +
  `  역 ${data.stations.length}개 / 평일 오금방향 ${data.timetable.weekday.down.length}편`
);
