import { DronePhysics, FIXED_DT, MODES, clamp } from './sim/physics.js';
import { TrainingSession, LESSONS, WAYPOINTS } from './sim/training.js';
import { FlightScene } from './sim/scene.js';
import { RushSession, RUN_SECONDS, OVERDRIVE_SECONDS, RUSH_RULES, traceShot, scoreRank } from './sim/rush.js';
import { ArcadeFlight } from './sim/arcade-flight.js';
import { ArcadeInput } from './sim/arcade-input.js';
import { MAPS, ringDefinitions, sceneryDefinitions } from './sim/maps.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const trainingDrone = new DronePhysics();
const arcadeDrone = new ArcadeFlight();
let drone = arcadeDrone;
const keys = new Set();
const dialog = $('#info-dialog');
const stage = $('#flight-stage');
const state = { activity: 'arcade', map: 'city', lesson: 'hover', mode: 'position', wind: 0, gusts: false, running: false, paused: false, session: null, camera: 'chase' };
const isArcade = () => state.activity === 'arcade';
const mapLayouts = { city: sceneryDefinitions('city'), forest: sceneryDefinitions('forest') };
const input = { pitch: 0, roll: 0, yaw: 0, lift: 0, rescue: false };
const timeLabel = (seconds) => `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`;
const modeName = { position: 'POSITION ASSIST', attitude: 'ATTITUDE / ALT HOLD', manual: 'MANUAL THRUST' };
let scene, accumulator = 0, lastTime = 0, uiTimer = 0, trailTimer = 0, toastTimer;
const preferences = readPreferences();
let soundEnabled = preferences.sound !== false, audioContext, audioGain, audioBus, oscillator, noiseBuffer;
let records = readRecords();
let arcadeHistory = readArcadeHistory();
let scorePopupTimer, countdown = 0, aimInfo = null, lastCountdown = 3;
const arcadeInput = new ArcadeInput({
  canvas: $('#world'), active: () => isArcade() && state.running && !state.paused && state.camera !== 'observer',
  look: (x, y) => arcadeDrone.look(x, y, Number($('#sensitivity').value) * (arcadeInput.focused || keys.has('KeyV') ? .48 : 1)), pause, notify: toast
});

function readArcadeHistory() {
  try {
    const saved=JSON.parse(localStorage.getItem('airframe-rush-v2')||'{}');
    const valid=r=>r&&Object.hasOwn(MAPS,r.mapId)&&Object.hasOwn(MODES,r.mode)&&Number.isSafeInteger(r.score)&&r.score>=0&&Number.isFinite(r.elapsed)&&r.elapsed>=0&&typeof r.reason==='string'&&typeof r.date==='string'&&['rings','crystals','lap','maxCombo','assistance'].every(k=>Number.isSafeInteger(r[k])&&r[k]>=0)&&Number.isFinite(r.wind);
    const validRush = r => valid(r) && r.rules === RUSH_RULES && ['destroyed', 'shots', 'hits', 'hull', 'damage', 'perfects', 'boostRings', 'overdrives', 'bestStreak'].every(k => Number.isSafeInteger(r[k]) && r[k] >= 0) && r.hull <= 3 && r.hits <= r.shots;
    return {records:Array.isArray(saved.records)?saved.records.filter(validRush).slice(0,12):[],bests:{city:Number.isSafeInteger(saved.bests?.city)&&saved.bests.city>0?saved.bests.city:0,forest:Number.isSafeInteger(saved.bests?.forest)&&saved.bests.forest>0?saved.bests.forest:0}};
  } catch {return {records:[],bests:{city:0,forest:0}};}
}

function syncActivity() {
  const arcade=isArcade();
  drone = arcade ? arcadeDrone : trainingDrone;
  $('#rush-hud').hidden = !arcade;
  $('#arcade-settings').hidden = !arcade;
  $('.settings').hidden = arcade;
  $('#arcade-controls').hidden = !arcade;
  $('.input-panel .control-inputs').hidden = arcade;
  $('.lesson-tip > div').hidden = arcade;
  $('.page-intro p').textContent = arcade ? '120초. 두 개의 월드. 끝없이 높아지는 당신의 기록.' : '이륙부터 정밀 착륙까지, 한 단계씩 비행의 감각을 익히세요.';
  $('footer p').textContent = arcade ? '두 개의 월드. 나만의 라인. 다음 비행은 더 멀리.' : '조종 원리를 익히는 교육용 모델 · 특정 기체의 비행 특성을 재현한 인증 시뮬레이터는 아닙니다.';
  document.body.classList.toggle('arcade-mode',arcade);
  $('#arcade-options').hidden=!arcade;$('#training-options').hidden=arcade;$('#arcade-scoreboard').hidden=!arcade;
  $('#nav-arcade').classList.toggle('active',arcade);$('#nav-field').classList.toggle('active',!arcade);
}

function selectActivity(activity) {
  if(state.running){toast('비행을 종료한 다음 모드를 바꿀 수 있어요.');return;}
  state.activity=activity;prepare();
}

function prepareArcade() {
  const map=MAPS[state.map];
  scene?.setArcade(state.map);
  drone.reset({altitude:5.26});
  stage.classList.remove('is-boosting', 'is-damaged', 'is-overdrive', 'is-focusing');
  $('#action-feed').replaceChildren(); aimInfo = null;
  drone.obstacles=[...(scene?.obstacles||[]),...ringDefinitions(state.map)];
  clearInput();accumulator=0;
  $$('[data-map]').forEach(button=>{const active=button.dataset.map===state.map;button.classList.toggle('selected',active);button.setAttribute('aria-pressed',String(active));});
  $('#personal-best').textContent=String(arcadeHistory.bests[state.map]).padStart(6,'0');
  $('#field-index').textContent=state.map==='city'?'01':'02';
  $('#field-title').textContent=map.title;
  $('#mission-kicker').textContent=map.subtitle;$('#mission-title').textContent=map.title;
  $('#mission-objective').textContent='링을 잇고, 표적을 맞히세요. 120초의 스코어 어택.';
  $('#mode-code').textContent=MODES[state.mode].code;$('#mode-description').textContent=MODES[state.mode].description;
  $('#active-mode').textContent='ARCADE / ALT HOLD';$('#wind-readout').textContent='120 SEC · 3 SHIELDS';
  $('.key-legend > div:first-child > span').textContent=state.mode==='manual'?'추력 증감':'상승 · 하강';
  $('#standby-note').hidden=false;$('#flight-notice').hidden=true;$('#flight-status').innerHTML='<i></i> READY TO FLY';
  $('#standby-note > span').textContent='AIRFRAME / SKY RUSH';$('#standby-note strong').textContent=state.map==='city'?'도시를 가르고, 기록을 넘어.':'숲을 가르고, 한계 너머로.';
  $('#standby-note p').textContent='WASD 비행 · 좌클릭 발사 · 우클릭 정밀 조준.\n링을 가르고, 오버드라이브를 터뜨리세요.';
  $('#start-button span').textContent='출격하기';$('#start-note').textContent='WASD + 마우스 · 터치 조종 지원';
  $('#trace-target').textContent='FLIGHT ALTITUDE / m';
  $('#tip-title').textContent='정중앙으로. 더 빠르게.';
  $('#tip-body').textContent='링 중앙 PERFECT +75, 부스트 통과 +50. 링·표적·크리스털로 게이지를 채우면 8초간 점수 2배, 과열 없는 고속 연사와 무제한 부스트!';
  $('#coach-text').textContent='WASD 이동 · Q/E 상승·하강 · Shift 부스트 · Space 급제동';
  updateTelemetry();drawMinimap();drawAltitude($('#altitude-chart'),[],30,false);updateAudio();
}

function updateArcadeTelemetry() {
  const session=state.session;
  $('#crosshair').hidden = state.camera === 'observer';
  $('#flight-time').textContent = timeLabel(Math.ceil(session?.remaining ?? RUN_SECONDS));
  $('#flight-time').classList.toggle('urgent', !!session && session.remaining < 20);
  $('#energy-fill').style.width = `${drone.energy}%`;
  $('#energy-value').textContent = drone.exhausted ? '충전 중' : `${Math.round(drone.energy)}%`;
  $('#heat-fill').style.width = `${session?.heat || 0}%`;
  $('#weapon-state').textContent = session?.overdrive > 0 ? 'PULSE / UNLIMITED' : session?.overheated ? '과열 · 냉각 중' : drone.focusing ? 'FOCUS / 정밀 조준' : 'PULSE / READY';
  $('#hull-value').textContent = '◆'.repeat(drone.hull) + '◇'.repeat(3 - drone.hull);
  $('#combo-timer').style.width = `${(session?.comboRemaining || 0) * 100}%`;
  $('#target-count').textContent = String(session?.destroyed || 0).padStart(2, '0');
  $('#mouse-hint').hidden = !state.running || state.paused || countdown > 0 || state.camera === 'observer' || document.pointerLockElement === $('#world');
  stage.classList.toggle('is-boosting', state.running && !state.paused && drone.boosting);
  stage.classList.toggle('is-focusing', state.running && drone.focusing);
  stage.classList.toggle('is-overdrive', state.running && session?.overdrive > 0);
  stage.classList.toggle('is-damaged', state.running && drone.immunity > 1.3);
  $('#score-value').textContent=String(session?.score||0).padStart(6,'0');
  $('#combo-value').textContent=`×${session?.combo||1}`;
  $('#arcade-counts').textContent=`LAP ${String(session?.lap||1).padStart(2,'0')} · ◆ ${session?.crystalsCollected||0}`;
  const powered = session?.overdrive > 0;
  $('#overdrive-panel').classList.toggle('powered', powered);
  $('#overdrive-fill').style.width = `${powered ? session.overdrive / OVERDRIVE_SECONDS * 100 : session?.charge || 0}%`;
  $('#overdrive-value').textContent = powered ? `${session.overdrive.toFixed(1)}s · ×2` : `${Math.round(session?.charge || 0)}%`;
  $('#overdrive-caption').textContent = powered ? '점수 2배 · 무제한 부스트 · 고속 연사' : '링 · 표적 · 크리스털로 충전';
  $('#rush-speed').textContent = Math.round(drone.velocity.length() * 3.6);
  $('#speed-state').textContent = input.rescue ? 'AIR BRAKE' : drone.boosting ? 'BOOSTING' : 'CRUISE';
  const aiming = state.running && !state.paused && countdown <= 0 && state.camera !== 'observer';
  aimInfo = aiming ? traceShot(drone, session.targets) : null;
  $('#crosshair').classList.toggle('on-target', !!aimInfo?.target);
  $('#crosshair').classList.toggle('overheated', !!session?.overheated);
  $('#aim-label').hidden = !aimInfo?.target;
  $('#aim-label').textContent = aimInfo?.target ? `TARGET · ${aimInfo.target.health === 1 ? '마지막 한 발' : '2 HITS'}` : '';
  $('#progress-value').textContent=`${(session?.ringIndex||0)+1} / 8`;
  const target=session?.target||MAPS[state.map].rings[0];
  const distance=Math.hypot(target[0]-drone.position.x,target[1]-drone.altitude,target[2]-drone.position.z);
  $('#target-label-text').textContent=`RING ${(session?.ringIndex||0)+1} · ${Math.round(distance)} M`;
  $('#ring-direction').hidden = !state.running || countdown > 0 || scene?.projectTarget(target).visible;
  if(state.running&&!input.rescue){
    const bearing=Math.atan2(target[0]-drone.position.x,-(target[2]-drone.position.z))*180/Math.PI;
    const delta=((bearing-drone.heading+540)%360)-180;
    const direction=Math.abs(delta)<20?'정면':delta>0?'오른쪽':'왼쪽';
    $('#ring-direction b').style.transform = `rotate(${delta}deg)`;
    const heightDelta = target[1] - drone.altitude;
    const heightHint = Math.abs(heightDelta) > 1 ? `${heightDelta > 0 ? 'Q 상승' : 'E 하강'} ${Math.abs(heightDelta).toFixed(0)}m` : '';
    $('#ring-direction small').textContent = `${Math.round(distance)}m · ${Math.abs(delta) > 130 ? '뒤쪽' : heightHint || direction}`;
    $('#coach-text').textContent=`다음 링 ${Math.round(distance)}m · 고도 ${target[1]}m · ${direction}${Math.abs(delta)>20?` ${Math.round(Math.abs(delta))}°`:''}. ${session.combo>1?`콤보 ×${session.combo} 유지 중!`:'크리스털도 놓치지 마세요.'}`;
  }
}

function handleArcadeEvents() {
  if (!isArcade()) return;
  const events = state.session.events.splice(0);
  let headline = null;
  for (const event of events) {
    scene.feedback(event.type);
    playArcadeSound(event);
    if (event.type === 'shot') {
      if (!scene.reducedMotion) $('#crosshair').animate([{ scale: '1.25' }, { scale: '1' }], { duration: 100 });
      continue;
    }
    if (event.type === 'hit') {
      $('#crosshair').classList.remove('hit', 'kill');
      void $('#crosshair').offsetWidth;
      $('#crosshair').classList.add('hit');
      $('#crosshair').classList.toggle('kill', event.destroyed);
      continue;
    }
    if (event.type === 'time') continue;
    const labels = {
      damage: `SHIELD HIT · ${event.hull} LEFT`, repair: 'SHIELD RESTORED',
      target: `${event.streak > 1 ? `${event.streak} KILL STREAK` : 'TARGET DOWN'} +${event.points}`,
      crystal: `CRYSTAL +${event.points} · BOOST +25`,
      ring: `${event.perfect ? 'PERFECT' : 'RING CLEAR'}${event.boosted ? ' / BOOST' : ''} +${event.points}`,
      lap: `LAP ${event.lap} · 한 바퀴 더!`, overdrive: 'OVERDRIVE', overheat: '과열 · 잠시 식혀주세요'
    };
    const label = labels[event.type];
    if (!label) continue;
    const row = document.createElement('div'); row.className = `feed-${event.type}`; row.textContent = label;
    $('#action-feed').prepend(row);
    while ($('#action-feed').children.length > 3) $('#action-feed').lastElementChild.remove();
    setTimeout(() => row.remove(), 2400);
    const priority = { overdrive: 6, damage: 5, target: 4, ring: 3, lap: 2, repair: 2, overheat: 1 }[event.type] || 0;
    if (priority && (!headline || priority > headline.priority)) headline = { label, priority, type: event.type };
    if (['ring', 'target', 'overdrive'].includes(event.type) && !scene.reducedMotion) {
      $('#combat-flash').animate([{ opacity: event.type === 'overdrive' ? .7 : .25 }, { opacity: 0 }], { duration: 450 });
    }
  }
  if (headline) {
    clearTimeout(scorePopupTimer);
    $('#score-popup').textContent = headline.label;
    $('#score-popup').dataset.kind = headline.type;
    $('#score-popup').classList.add('visible');
    scorePopupTimer = setTimeout(() => $('#score-popup').classList.remove('visible'), 1150);
  }
  if (events.some(event => event.type === 'ring')) drone.obstacles = [...scene.obstacles, ...state.session.rings.slice(state.session.ringIndex)];
}

function updateAimReticle() {
  if (!isArcade() || !state.running || state.paused || state.camera === 'observer') return;
  const point = drone.position.clone().addScaledVector(drone.aimDirection, aimInfo?.distance || 25);
  const projected = scene.projectPoint(point.toArray());
  const x = clamp(projected.x * 100, 5, 95), y = clamp(projected.y * 100, 8, 90);
  $('#crosshair').style.left = `${x}%`; $('#crosshair').style.top = `${y}%`;
  $('#aim-label').style.left = `${x}%`; $('#aim-label').style.top = `calc(${y}% + 28px)`;
}

function readRecords() {
  try {
    const saved = JSON.parse(localStorage.getItem('airframe-training-v2') || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(r => r && Object.hasOwn(LESSONS, r.lesson) && Object.hasOwn(MODES, r.mode) && Number.isFinite(r.elapsed) && r.elapsed >= 0 && Number.isFinite(r.wind) && Number.isInteger(r.assistance) && r.assistance >= 0 && typeof r.passed === 'boolean' && typeof r.reason === 'string' && typeof r.date === 'string' && Array.isArray(r.samples) && r.samples.every(s => s && ['t', 'x', 'y', 'z', 'pitch', 'roll', 'speed'].every(k => Number.isFinite(s[k])))).slice(0, 12);
  } catch { return []; }
}

function storeReport(report) {
  const stride = Math.max(1, Math.ceil(report.samples.length / 240));
  records.unshift({ ...report, samples: report.samples.filter((_, index) => index % stride === 0) });
  records = records.slice(0, 12);
  try { localStorage.setItem('airframe-training-v2', JSON.stringify(records)); }
  catch { toast('브라우저 저장 공간이 부족해 이번 기록은 현재 세션에서만 유지됩니다.'); }
  updateRecordsBadge();
  window.dispatchEvent(new CustomEvent('airframe:training-complete', { detail: report }));
}

function updateRecordsBadge() {
  $('#record-count').textContent = String(records.length+arcadeHistory.records.length).padStart(2, '0');
  $$('.lesson').forEach(button => {
    const completed = records.some(r => r.lesson === button.dataset.lesson && r.passed && r.assistance === 0);
    button.classList.toggle('completed', completed);
    button.querySelector('.lesson-status').textContent = completed ? '✓' : '↗';
  });
}

function clearInput() {
  keys.clear();
  arcadeInput.reset();
  Object.assign(input, { pitch: 0, roll: 0, yaw: 0, lift: 0, rescue: false, boost: false, fire: false, look: 0, focus: false });
  updateInputPanel();
}

function prepare(lesson = state.lesson) {
  if (state.running) return;
  state.lesson = lesson;
  state.session = null;
  countdown = 0; $('#launch-countdown').hidden = true;
  state.paused = false;
  syncActivity();
  clearTimeout(scorePopupTimer);$('#score-popup').classList.remove('visible');
  stage.classList.remove('is-boosting', 'is-damaged', 'is-overdrive', 'is-focusing');
  if(isArcade()){prepareArcade();return;}
  const training = LESSONS[lesson];
  scene?.setMap('training');drone.obstacles=scene?.obstacles||[];
  drone.reset({ altitude: training.startAltitude, mode: state.mode, wind: state.wind, gusts: state.gusts });
  scene?.setLesson(lesson);
  clearInput(); accumulator = 0;
  $$('.lesson').forEach(button => { const active = button.dataset.lesson === lesson; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
  $('#free-flight').classList.toggle('selected', lesson === 'free');
  $('#mission-kicker').textContent = `${training.number} / ${training.en}`;
  $('#mission-title').textContent = training.title;
  $('#mission-objective').textContent = training.objective;
  $('#field-index').textContent='A01';$('#field-title').textContent='비행 훈련장';
  $('#standby-note > span').textContent='READY WHEN YOU ARE.';$('#standby-note strong').textContent='첫 비행은, 천천히.';$('#standby-note p').textContent='왼쪽에서 훈련을 시작하세요. 주황색 영역이 오늘의 목표입니다.';
  $('#mode-code').textContent = MODES[state.mode].code;
  $('#mode-description').textContent = MODES[state.mode].description;
  $('#active-mode').textContent = modeName[state.mode];
  $('.key-legend > div:first-child > span').textContent = state.mode === 'manual' ? '추력 증감' : '상승 · 하강';
  $('#wind-readout').textContent = `WIND ${state.wind.toFixed(1)} m/s`;
  $('#standby-note').hidden = false;
  $('#flight-notice').hidden = true;
  $('#flight-status').innerHTML = '<i></i> PRE-FLIGHT';
  $('#start-button span').textContent = '훈련 시작';
  $('#start-note').textContent = training.startAltitude > 1 ? `${Math.round(training.startAltitude - 0.26)}m 상공에서 시작 · 키보드 조종` : 'W로 직접 이륙 · 키보드 조종';
  $('#trace-target').textContent = ['hover', 'attitude', 'square'].includes(lesson) ? 'TARGET 5.0 m' : 'ALTITUDE / m';
  const tips = {
    hover: ['키를 놓는 것도, 조종입니다.', '목표 고도에 도착하기 조금 전에 W를 놓아보세요. 기체의 관성과 제동 거리를 느끼는 것이 첫걸음입니다.'],
    attitude: ['수평과 정지는 다릅니다.', '기체가 수평으로 돌아와도 관성은 남습니다. 자세 모드에서는 반대로 살짝 기울여 이동을 상쇄하세요.'],
    square: ['앞은 항상 기수 방향입니다.', '기수를 북쪽에 고정하고 앞·오른쪽·뒤·왼쪽으로 이동합니다. 각 꼭짓점에서 제동 후 잠깐 멈춰보세요.'],
    landing: ['마지막 1미터를 아껴 쓰세요.', '지면 근처에서는 Shift + S로 하강 속도를 낮추세요. 수동 추력에서는 S를 놓아도 추력이 복원되지 않습니다.'],
    free: ['같은 입력, 다른 보조.', '위치 보조에서 멈추는 감각을 익힌 뒤 자세 모드와 약풍으로 다시 시도해보세요. 관성과 바람을 구분할 수 있습니다.']
  };
  $('#tip-title').textContent = tips[lesson][0]; $('#tip-body').textContent = tips[lesson][1];
  $('#coach-text').textContent = state.mode === 'manual' ? `수평 호버 추력은 약 ${Math.round(drone.hoverThrottle * 100)}%. W/S로 설정을 조절하세요.` : lesson === 'hover' ? 'W는 상승, 방향키 ↑는 기수를 숙여 전진합니다.' : training.description;
  updateTelemetry(); drawMinimap(); drawAltitude($('#altitude-chart'), [], 30, true); updateAudio();
}

function settingsLocked(locked) {
  $$('.lesson, .wind-options button, #mode-select, #gust-toggle, #free-flight, [data-map], #nav-arcade, #nav-field').forEach(element => element.disabled = locked);
  $('#pause-button').disabled = !locked; $('#reset-button').disabled = !locked; $('#end-button').disabled = !locked;
}

function start() {
  if (!scene) return;
  if (dialog.open) dialog.close();
  state.running = false; prepare();
  state.session = isArcade()?new RushSession(state.map):new TrainingSession(state.lesson, state.mode, state.wind, state.gusts);
  if (!isArcade()&&state.lesson === 'square') state.session.target = WAYPOINTS[0];
  state.running = true; state.paused = false;
  drone.armMotors(); settingsLocked(true); clearInput();
  countdown = isArcade() ? 3 : 0; lastCountdown = 3;
  if (isArcade() && state.camera === 'observer') changeCamera('chase');
  initAudio();
  if (isArcade()) arcadeInput.capture();
  $('#launch-countdown').hidden = !isArcade();
  $('#launch-countdown b').textContent = '3';
  document.body.classList.toggle('run-active', isArcade());
  $('#standby-note').hidden = true;
  $('#start-button span').textContent = '비행 중 · 일시정지';
  $('#start-note').textContent = 'ESC 일시정지 · R 처음부터 다시';
  $('#flight-status').innerHTML = '<i></i> IN FLIGHT';
  scene.cameraInitialized = false;
  accumulator = 0; trailTimer = 0;
  document.activeElement?.blur();
  updateAudio();
  if (isArcade() || innerWidth < 640) $('.flight-workspace').scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  toast(isArcade()?'WASD 이동 · 좌클릭 발사 · 우클릭 정밀 조준 · Shift 부스트':state.lesson === 'hover' || state.lesson === 'free' ? 'W로 천천히 이륙하세요. 목표 근처에서는 키를 먼저 놓아보세요.' : `${LESSONS[state.lesson].title} · ${$('#start-note').textContent}`);
}

function smoothInput(dt) {
  const held = (...codes) => codes.some(code => keys.has(code));
  if (isArcade()) {
    const touch = arcadeInput;
    const target = {
      lift: Number(held('KeyQ') || touch.buttons.has('up')) - Number(held('KeyE') || touch.buttons.has('down')),
      yaw: Number(held('ArrowRight')) - Number(held('ArrowLeft')) + touch.aim.x,
      pitch: Number(held('KeyS')) - Number(held('KeyW')) + touch.move.y,
      roll: Number(held('KeyD')) - Number(held('KeyA')) + touch.move.x,
      look: Number(held('ArrowUp')) - Number(held('ArrowDown')) - touch.aim.y
    };
    for (const key of Object.keys(target)) input[key] = clamp(target[key], -1, 1);
    input.rescue = held('Space') || touch.buttons.has('brake');
    input.boost = held('ShiftLeft', 'ShiftRight') || touch.buttons.has('boost');
    input.fire = state.camera !== 'observer' && (held('KeyF') || touch.firing || touch.buttons.has('fire'));
    input.focus = state.camera !== 'observer' && (held('KeyV') || touch.focused);
    return;
  }
  const fine = held('ShiftLeft', 'ShiftRight') ? 0.25 : 1;
  const target = {
    lift: (Number(held('KeyW')) - Number(held('KeyS'))) * fine,
    yaw: (Number(held('KeyD')) - Number(held('KeyA'))) * fine,
    pitch: (Number(held('ArrowDown', 'Numpad5')) - Number(held('ArrowUp', 'Numpad8'))) * fine,
    roll: (Number(held('ArrowRight', 'Numpad6')) - Number(held('ArrowLeft', 'Numpad4'))) * fine
  };
  const response = 1 - Math.exp(-dt * 12);
  for (const key of Object.keys(target)) input[key] += (target[key] - input[key]) * response;
  input.rescue = held('Space');
}

function updateTelemetry() {
  $('#altitude-value').innerHTML = `${drone.altitude.toFixed(1)}<small>m</small>`;
  $('#speed-value').innerHTML = `${drone.horizontalSpeed.toFixed(1)}<small>m/s</small>`;
  $('#vertical-value').innerHTML = `${Math.abs(drone.velocity.y) < 0.05 ? '0.0' : `${drone.velocity.y > 0 ? '+' : ''}${drone.velocity.y.toFixed(1)}`}<small>m/s</small>`;
  $('#throttle-value').innerHTML = `${Math.round(drone.throttle * 100)}<small>%</small>`;
  $('#throttle-fill').style.width = `${drone.throttle * 100}%`;
  $('#heading-value').textContent = `${Math.round(drone.heading % 360).toString().padStart(3, '0')}°`;
  const cardinal = ['N', 'E', 'S', 'W'];
  $('#heading-left').textContent = cardinal[(Math.round(drone.heading / 90) + 3) % 4];
  $('#heading-right').textContent = cardinal[(Math.round(drone.heading / 90) + 1) % 4];
  $('#tilt-label').innerHTML = `P ${Math.round(drone.pitch)}° <i>/</i> R ${Math.round(drone.roll)}°`;
  $('#horizon-attitude').style.transform = `rotate(${-drone.roll}deg) translateY(${clamp(drone.pitch * 1.2, -38, 38)}px)`;
  $('#position-label').textContent = `X ${drone.position.x.toFixed(1)}  Z ${drone.position.z.toFixed(1)} m`;
  $('#flight-time').textContent = timeLabel(state.session?.elapsed || 0);
  $('#progress-value').textContent = state.lesson === 'free' ? '∞' : `${Math.floor((state.session?.progress || 0) * 100)}%`;
  $('#progress-bar').style.width = `${(state.session?.progress || 0) * 100}%`;
  if (state.session && state.running) {
    let hint = state.session.hint;
    if (!isArcade()&&state.mode === 'manual' && state.lesson === 'hover' && drone.altitude < 2) hint = 'W로 추력을 올리세요. 약 43%가 수평 호버 기준이며, 상승 관성은 S로 줄이세요.';
    if (input.rescue && !isArcade()) hint = '위치 보조가 개입 중입니다. Space를 놓으면 선택한 모드로 돌아갑니다.';
    $('#coach-text').textContent = hint;
    const notice = isArcade() ? (input.rescue ? 'AIR BRAKE · 급제동' : drone.exhausted ? '부스트 충전 중 · 25%에서 재사용' : '') : input.rescue ? '위치 보조 개입 중 · 훈련 기록에 표시됩니다' : drone.altitude < 1.2 && drone.velocity.y < -0.8 ? '하강 속도를 줄이세요' : '';
    $('#flight-notice').hidden = !notice; $('#flight-notice').textContent = notice;
  }
  const target = state.session?.target || (isArcade()?MAPS[state.map].rings[0]:state.lesson === 'square' ? WAYPOINTS[0] : [0, state.lesson === 'landing' ? 0 : 5, 0]);
  $('#target-label-text').textContent = state.lesson === 'square' ? `POINT ${Math.min(4, (state.session?.stage || 0) + 1)} / 5.0 M` : `TARGET / ${target[1].toFixed(1)} M`;
  if (scene) {
    const point = scene.projectTarget(target);
    $('#target-label').hidden = !point.visible || (!isArcade()&&state.lesson === 'free') || (!state.running && innerWidth < 640);
    $('#target-label').style.left = `${point.x * 100}%`; $('#target-label').style.top = `${point.y * 100}%`;
  }
  updateInputPanel();
  if(isArcade())updateArcadeTelemetry();
}

function updateInputPanel() {
  $('#left-stick').style.transform = `translate(${input.yaw * 21}px,${-input.lift * 21}px)`;
  $('#right-stick').style.transform = `translate(${input.roll * 21}px,${input.pitch * 21}px)`;
  $$('[data-key]').forEach(key => key.classList.toggle('pressed', keys.has(key.dataset.key)));
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect(), dpr = Math.min(devicePixelRatio, 2);
  const w = Math.max(1, Math.round(rect.width)), h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawMinimap(canvas = $('#minimap'), samples = state.session?.samples || [], report = null) {
  const { ctx, w, h } = canvasContext(canvas);
  const extent = report ? Math.max(18, ...samples.map(s => Math.max(Math.abs(s.x), Math.abs(s.z)))) + 3 : Math.max(isArcade()?45:18, Math.abs(drone.position.x) + 4, Math.abs(drone.position.z) + 4);
  const scale = Math.min(w, h) / (extent * 2);
  const point = (x, z) => [w / 2 + x * scale, h / 2 + z * scale];
  ctx.strokeStyle = '#86bfdf40'; ctx.lineWidth = 0.6;
  for (let i = -60; i <= 60; i += 10) { ctx.beginPath(); ctx.moveTo(...point(i, -70)); ctx.lineTo(...point(i, 70)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(...point(-70, i)); ctx.lineTo(...point(70, i)); ctx.stroke(); }
  const lesson = report?.lesson || state.lesson;
  if(isArcade()&&!report){
    ctx.fillStyle='#b4dcf52b';for(const b of mapLayouts[state.map].buildings){const [x,z]=point(b.x-b.w/2,b.z-b.d/2);ctx.fillRect(x,z,b.w*scale,b.d*scale);}
    const route=MAPS[state.map].rings;ctx.strokeStyle='#84d7f366';ctx.setLineDash([2,3]);ctx.beginPath();route.forEach(([x,,z],i)=>i?ctx.lineTo(...point(x,z)):ctx.moveTo(...point(x,z)));ctx.closePath();ctx.stroke();ctx.setLineDash([]);
    route.forEach(([x,,z],i)=>{ctx.strokeStyle=i===(state.session?.ringIndex||0)?'#ffb574':'#b4dcec66';ctx.beginPath();ctx.arc(...point(x,z),i===(state.session?.ringIndex||0)?4:2,0,Math.PI*2);ctx.stroke();});
  } else if (lesson === 'square') {
    ctx.strokeStyle = '#c7ad8188'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(...point(0, 0)); WAYPOINTS.forEach(([x, , z]) => ctx.lineTo(...point(x, z))); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#75d5f6'; ctx.lineWidth = 1.1; ctx.beginPath(); samples.forEach((p, i) => { if (i === 0) ctx.moveTo(...point(p.x, p.z)); else ctx.lineTo(...point(p.x, p.z)); }); ctx.stroke();
  const target = isArcade()&&!report?(state.session?.target||MAPS[state.map].rings[0]):lesson === 'square' ? WAYPOINTS[Math.min(state.session?.stage || 0, 3)] : [0, 0, 0];
  ctx.strokeStyle = '#f5b57b'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(...point(target[0], target[2]), Math.max(3, scale * 1.5), 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#d9e3c5'; ctx.font = '7px monospace'; ctx.fillText('H', w / 2 + 3, h / 2 + 9);
  if (!report) {
    ctx.save(); ctx.translate(...point(drone.position.x, drone.position.z)); ctx.rotate(drone.heading * Math.PI / 180);
    ctx.fillStyle = '#f1f2d6'; ctx.beginPath(); ctx.moveTo(0, -5); ctx.lineTo(3.5, 4); ctx.lineTo(0, 2); ctx.lineTo(-3.5, 4); ctx.closePath(); ctx.fill(); ctx.restore();
  }
}

function drawAltitude(canvas, samples, duration = 30, targetLine = true) {
  const { ctx, w, h } = canvasContext(canvas);
  const end = samples.at(-1)?.t || duration, start = Math.max(0, end - duration);
  const visible = samples.filter(s => s.t >= start);
  const max = Math.max(10, ...visible.map(s => s.y + 1));
  const px = t => 19 + (t - start) / duration * (w - 23);
  const py = y => h - 8 - (y / max) * (h - 16);
  ctx.font = '7px monospace'; ctx.fillStyle = '#88a9c0'; ctx.strokeStyle = '#80add140'; ctx.lineWidth = 0.5;
  for (const y of [0, max / 2, max]) { ctx.beginPath(); ctx.moveTo(18, py(y)); ctx.lineTo(w, py(y)); ctx.stroke(); ctx.fillText(y.toFixed(0), 1, py(y) + 2); }
  if (targetLine) {
    ctx.fillStyle = '#c6a47412'; ctx.fillRect(19, py(5.5), w - 19, py(4.5) - py(5.5));
    ctx.strokeStyle = '#cfaa7888'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(19, py(5)); ctx.lineTo(w, py(5)); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.strokeStyle = '#50aed7'; ctx.lineWidth = 1.5; ctx.beginPath(); visible.forEach((p, i) => i === 0 ? ctx.moveTo(px(p.t), py(p.y)) : ctx.lineTo(px(p.t), py(p.y))); ctx.stroke();
}

function finishSession(reason) {
  if (!state.running) return;
  if (!state.session.finished) state.session.finish(false, reason || (isArcade()?'비행을 마쳤습니다. 다음 기록에 도전하세요.':'훈련을 직접 종료했습니다. 다시 연습하며 기록을 비교해보세요.'));
  const report = state.session.report();
  countdown = 0; $('#launch-countdown').hidden = true;
  document.body.classList.remove('run-active');
  state.running = false; state.paused = false; drone.armed = false; drone.motors.fill(0); clearInput(); settingsLocked(false); updateAudio();
  if (isArcade()) { drone.overdrive = false; drone.focusing = false; }
  $('#flight-status').innerHTML = '<i></i> SESSION ENDED';
  $('#start-button span').textContent = isArcade() ? '다시 출격하기' : '다시 훈련하기';
  if(isArcade()) {
    const newBest=report.score>arcadeHistory.bests[report.mapId];
    arcadeHistory.records.unshift(report);arcadeHistory.records=arcadeHistory.records.slice(0,12);
    arcadeHistory.bests[report.mapId]=Math.max(arcadeHistory.bests[report.mapId],report.score);
    try{localStorage.setItem('airframe-rush-v2',JSON.stringify(arcadeHistory));}catch{toast('저장 공간이 부족해 현재 세션에서만 기록을 유지합니다.');}
    updateRecordsBadge();showArcadeReport(report,newBest);
  }else {storeReport(report); showReport(report);}
}

function openDialog(kicker, html) {
  if (state.running) { state.paused = true; clearInput(); updateAudio(); }
  if (document.pointerLockElement) document.exitPointerLock();
  if (document.fullscreenElement && !document.fullscreenElement.contains(dialog)) document.fullscreenElement.append(dialog);
  $('#dialog-kicker').textContent = kicker; $('#dialog-content').innerHTML = html;
  if (!dialog.open) dialog.showModal();
}

function pause() {
  if (!state.running || dialog.open) return;
  openDialog('FLIGHT PAUSED', `<h2>잠깐, 숨 고르기.</h2><p>${isArcade()?MAPS[state.map].title:LESSONS[state.lesson].title} · ${timeLabel(state.session.elapsed)}<br>일시정지 중에는 비행과 타이머가 함께 멈춥니다.</p><div class="dialog-actions"><button class="primary-button" id="resume-button">계속 비행 <svg><use href="#i-arrow"/></svg></button><button class="secondary-button" id="pause-end-button">여기서 마치기</button></div>`);
  $('#resume-button').onclick = () => { dialog.close(); state.paused = false; if (isArcade()) arcadeInput.capture(); }; $('#pause-end-button').onclick = () => finishSession();
}

function showGuide() {
  if (isArcade()) {
    openDialog('SKY RUSH / FLIGHT MANUAL', `<h2>비행은 가볍게. 기록은 높게.</h2><p>고도 유지와 자동 제동이 켜져 있습니다. 화면을 클릭하면 마우스로 조준합니다. 우클릭 또는 V를 누르면 시야와 감도를 줄여 정밀 조준합니다. 마우스 잠금을 지원하지 않으면 누른 채 드래그하거나 방향키로 시점을 돌리세요.</p><div class="guide-keys"><div><span>전진 · 후진 / 좌우 이동</span><span><kbd>W S</kbd> <kbd>A D</kbd></span></div><div><span>상승 / 하강</span><span><kbd>Q</kbd> <kbd>E</kbd></span></div><div><span>시점 / 조준</span><span>마우스 · 방향키</span></div><div><span>정밀 조준</span><span>우클릭 / <kbd>V</kbd></span></div><div><span>펄스 연사 · 두 발로 표적 격파</span><span>좌클릭 / <kbd>F</kbd></span></div><div><span>부스트 / 급제동</span><span><kbd>SHIFT</kbd> <kbd>SPACE</kbd></span></div><div><span>시점 / 재출격 / 일시정지</span><span><kbd>C</kbd> <kbd>R</kbd> <kbd>ESC</kbd></span></div></div><p class="guide-note">링 +100점 · 12초 내 연결하면 최대 ×3 · 중앙 통과 +75 · 부스트 통과 +50. 표적 +150점부터, 5초 내 연속 격파 시 추가 보너스 · 크리스털 +25점. 링과 크리스털은 부스트를 25% 충전하고, 크리스털 5개마다 실드가 하나 회복됩니다.</p><p>충돌하면 실드 하나와 콤보를 잃습니다. 실드가 소진되거나 120초가 지나면 종료됩니다. 연사를 오래 유지하면 냉각 시간이 필요합니다. 링·표적·크리스털로 게이지를 채우면 오버드라이브가 자동 발동합니다. 8초간 점수 2배·과열 없는 고속 연사·무제한 부스트! 모바일에서는 왼쪽 스틱으로 이동, 오른쪽 스틱으로 조준하세요.</p>`);
    return;
  }
  openDialog('KEYBOARD FLIGHT MANUAL', `<h2>두 손으로 익히는 비행.</h2><p>왼손으로 고도와 기수, 오른손으로 기체의 기울기를 조종합니다. GTA 스타일 비행 키보드 배치를 드론에 맞게 구성했습니다.</p><div class="guide-keys"><div><span><b>상승 / 하강</b><small>수동 추력에서는 추력 설정 증가 / 감소</small></span><span><kbd>W</kbd> <kbd>S</kbd></span></div><div><span><b>기수를 왼쪽 / 오른쪽으로 회전</b><small>요(Yaw) · 이동 방향의 기준이 바뀝니다</small></span><span><kbd>A</kbd> <kbd>D</kbd></span></div><div><span><b>기수 숙이기 / 들기</b><small>피치(Pitch) · 전진 / 후진 기울기</small></span><span><kbd>↑</kbd> <kbd>↓</kbd><small>숫자패드 8 / 5</small></span></div><div><span><b>좌 / 우 기울이기</b><small>롤(Roll) · 옆으로 이동하는 기울기</small></span><span><kbd>←</kbd> <kbd>→</kbd><small>숫자패드 4 / 6</small></span></div><div><span>입력 강도를 25%로 줄이기</span><kbd>SHIFT</kbd></div><div><span>누르는 동안 위치·고도 보조<small>보조 개입은 훈련 기록에 남습니다</small></span><kbd>SPACE</kbd></div><div><span>카메라 전환 / 다시 시작 / 일시정지</span><span><kbd>C</kbd> <kbd>R</kbd> <kbd>ESC</kbd></span></div></div><p class="guide-note">방향키는 화면 기준이 아닌 <b>기체 기준</b>입니다. 기수가 자신을 향하면 좌우가 반대로 보입니다. 처음에는 추적 시점과 무풍에서 연습하세요.</p><p>한 번에 키를 오래 누르기보다, 짧게 입력하고 기체의 반응을 살펴보세요. 한글 입력 상태에서도 같은 물리 키로 조종할 수 있습니다.</p>`);
}

function showAbout() {
  if (isArcade()) {
    openDialog('WELCOME TO SKY RUSH', '<h2>120초, 당신만의 비행.</h2><p>도시와 숲을 누비며 링을 연결하고, 움직이는 공중 표적을 맞히는 솔로 아케이드입니다. 부스트로 직선을 가르고, 급제동으로 다음 코너를 준비하세요.</p><p>링은 순서대로, 크리스털은 자유롭게. 실드는 3개로 시작하며 크리스털 5개마다 하나를 회복합니다. 연속 링 통과로 최대 3배 점수를 얻고, 중앙·부스트 통과 보너스를 더하세요. 게이지를 채우면 8초간 오버드라이브가 발동해 점수 2배·무제한 부스트·고속 연사를 즐길 수 있습니다.</p><p class="guide-note">최고 점수와 최근 비행 기록은 현재 브라우저에 저장됩니다. 트레이닝에서는 별도의 조작법으로 이륙·호버링·경로 비행·착륙을 연습할 수 있습니다.</p>');
    return;
  }
  openDialog('ABOUT THE TRAINING LAB', `<h2>원리를 익히는 비행장.</h2><p>중력, 기체 자세에 따른 추력, 선속도·각속도, 공기 저항, 모터 지연, 바람을 계산하는 쿼드콥터 교육용 모델입니다.</p><p><b>위치 보조</b>는 위치와 고도를 잡아줍니다.<br><b>자세 모드</b>는 수평과 고도를 잡지만 수평 이동은 직접 상쇄해야 합니다.<br><b>수동 추력</b>은 수평만 보조하며, 추력을 직접 조절합니다. 완전 수동 ACRO 모드는 아닙니다.</p><p class="guide-note">입력과 기체 반응의 관계를 배우는 데 집중했습니다. 실제 기체의 센서 오차·지면 효과·프로펠러 공력·배터리 전압 변화는 재현하지 않습니다. 특정 기체 또는 자격시험의 평가 기준과 일치하지 않습니다.</p><p>비행 모드 개념 참고: <a href="https://docs.px4.io/main/en/flight_modes_mc/position" target="_blank" rel="noopener">PX4 Position</a> · <a href="https://docs.px4.io/main/en/flight_modes_mc/altitude" target="_blank" rel="noopener">PX4 Altitude</a><br>위 문서를 참고한 자체 교육용 제어기이며 PX4 펌웨어를 실행하지는 않습니다.</p>`);
}

function showReport(report) {
  const assisted = report.assistance > 0;
  const resultTitle = report.lesson === 'free' ? '오늘의 비행을 돌아보세요.' : report.passed ? '좋은 비행은, 반복에서.' : '다음 비행은 더 정확하게.';
  const altitude = Number.isFinite(report.altitudeRms) ? report.altitudeRms.toFixed(2) : '—';
  const advice = report.landing ? `착지 하강 속도 ${report.landing.sink.toFixed(2)}m/s · 수평 속도 ${report.landing.horizontalSpeed.toFixed(2)}m/s · 중심 오차 ${Math.hypot(report.landing.x, report.landing.z).toFixed(2)}m` : report.altitudeRms > 0.7 ? '고도 오차가 컸습니다. 목표 고도보다 조금 일찍 입력을 놓고, Shift를 눌러 작은 변화부터 연습하세요.' : report.maxSpeed > 5 ? '이동 속도가 높았습니다. 짧게 기울인 뒤 미리 제동하면 목표 지점에서 더 정확하게 멈출 수 있습니다.' : '짧게 입력하고 반응을 기다리는 습관을 이어가세요. 익숙해지면 같은 훈련을 자세 모드와 약풍에서 반복해보세요.';
  openDialog(report.passed ? 'TRAINING COMPLETE' : 'FLIGHT DEBRIEF', `<h2>${resultTitle}</h2><p>${LESSONS[report.lesson].title} · ${report.passed ? '기준 충족' : report.lesson === 'free' ? '자유 연습' : '연습 기록'}${assisted ? ' · 보조 개입 있음' : ''}<br><span id="report-reason"></span></p><div class="report-context">${MODES[report.mode].label} / 풍속 ${Number(report.wind).toFixed(1)}m/s${report.gusts ? ' + 돌풍' : ''}</div><div class="report-summary"><div><span>훈련 시간</span><strong>${timeLabel(report.elapsed)}</strong></div><div><span>고도 RMS 오차</span><strong>${altitude}<small>m</small></strong></div><div><span>위치 보조 개입</span><strong>${report.assistance || 0}<small>회</small></strong></div></div><div class="report-charts"><div><span>FLIGHT PATH / TOP VIEW</span><canvas id="report-path" aria-label="실제 비행 궤적"></canvas></div><div><span>ALTITUDE / FULL SESSION</span><canvas id="report-altitude" aria-label="훈련 중 고도 변화"></canvas></div></div><div class="report-advice" id="report-advice"></div><p style="font-size:9px">고도 RMS는 고도 3m 이상에서 목표 5m와의 오차를 계산합니다. 착륙·자유 연습에는 적용하지 않습니다. 보조 사용 기록은 독립 수행 완료와 구분됩니다.</p><div class="dialog-actions"><button class="primary-button" id="retry-button">다시 훈련 <svg><use href="#i-arrow"/></svg></button><button class="secondary-button" id="export-button">기록 CSV ↓</button></div>`);
  $('#report-reason').textContent = report.reason || '';
  $('#report-advice').textContent = advice;
  $('#retry-button').onclick = () => {
    state.running = false; state.activity='training';state.lesson = report.lesson; state.mode = report.mode; state.wind = report.wind; state.gusts = !!report.gusts;
    $('#mode-select').value = state.mode; $('#gust-toggle').checked = state.gusts; updateWindButtons(); start();
  };
  $('#export-button').onclick = () => exportReport(report);
  requestAnimationFrame(() => {
    drawMinimap($('#report-path'), report.samples, report);
    drawAltitude($('#report-altitude'), report.samples, Math.max(report.elapsed, 1), ['hover', 'attitude', 'square'].includes(report.lesson));
  });
}

function showRecords() {
  if(isArcade()){showArcadeRecords();return;}
  openDialog('YOUR TRAINING LOG', '<h2>반복이 쌓이는 곳.</h2><p>이 브라우저에 저장된 최근 12회 훈련입니다.<br>같은 비행 모드와 바람 조건끼리 비교해보세요.</p><div id="record-list"></div>');
  const list = $('#record-list');
  if (!records.length) { const p = document.createElement('p'); p.className = 'guide-note'; p.textContent = '아직 훈련 기록이 없습니다. 첫 비행을 시작해보세요.'; list.append(p); }
  records.forEach(record => {
    const button = document.createElement('button'); button.className = 'record-entry';
    const text = document.createElement('span'), title = document.createElement('b'), meta = document.createElement('small'), result = document.createElement('span');
    title.textContent = LESSONS[record.lesson].title;
    meta.textContent = `${MODES[record.mode].label} · ${Number(record.wind).toFixed(1)}m/s · ${new Date(record.date).toLocaleDateString('ko-KR')}`;
    result.textContent = `${record.passed ? record.assistance ? '보조 완료' : '완료' : '연습'} / ${timeLabel(record.elapsed)}`;
    text.append(title, meta); button.append(text, result); button.onclick = () => showReport(record); list.append(button);
  });
}

function showArcadeReport(report, newBest = false) {
  const rank = scoreRank(report.score);
  const next = [750, 1800, 3500, 6000].find(value => value > report.score);
  openDialog(report.crashed ? 'FLIGHT ENDED' : 'RUN COMPLETE', `<div class="result-heading"><div><span class="result-eyebrow">${newBest ? 'NEW PERSONAL BEST' : 'SKY RUSH / FLIGHT RATING'}</span><h2>${newBest ? '방금, 한계를 넘었어요.' : '한 번 더 날아볼까요?'}</h2></div><div class="rank-badge rank-${rank}"><small>RANK</small><b>${rank}</b></div></div><p id="arcade-result-reason"></p><div class="gameover-score">${String(report.score).padStart(6, '0')}</div><div class="gameover-best">${next ? `다음 등급까지 ${(next - report.score).toLocaleString()}점` : 'S RANK · 완벽한 비행 감각'} · BEST ${arcadeHistory.bests[report.mapId].toLocaleString()}</div><div class="rank-progress"><i style="width:${Math.min(100, report.score / (next || 6000) * 100)}%"></i></div><div class="report-summary"><div><span>PERFECT 통과</span><strong>${report.perfects || 0}<small> / ${report.rings}</small></strong></div><div><span>최대 연속 격파</span><strong>${report.bestStreak || 0}<small>기</small></strong></div><div><span>오버드라이브</span><strong>${report.overdrives || 0}<small>회</small></strong></div></div><div class="arcade-result-meta">${MAPS[report.mapId].title} · ${timeLabel(report.elapsed)} · LAP ${report.lap}<br>표적 ${report.destroyed || 0}기 · 명중률 ${report.shots ? Math.round(report.hits / report.shots * 100) : 0}% · 최대 콤보 ×${report.maxCombo} · 크리스털 ${report.crystals}개</div><div class="report-advice">${report.perfects < report.rings / 2 ? '링 안쪽의 작은 원을 노려보세요. 중앙 통과는 점수와 오버드라이브를 더 많이 채웁니다.' : '부스트를 켠 채 링 중앙을 통과하면 보너스가 겹칩니다. 오버드라이브 때 몰아쳐 보세요.'}</div><div class="dialog-actions"><button class="primary-button" id="arcade-retry">한 번 더 출격 ↗</button><button class="secondary-button" id="choose-map">맵 고르기</button></div>`);
  $('#arcade-result-reason').textContent = report.reason;
  $('#arcade-retry').onclick = () => { state.activity = 'arcade'; state.map = report.mapId; start(); };
  $('#choose-map').onclick = () => { dialog.close(); if (state.running) finishSession(); };
}

function showArcadeRecords() {
  openDialog('YOUR PERSONAL BESTS',`<h2>한 번만 더, 한 점만 더.</h2><div class="report-summary"><div><span>스카이라인 최고</span><strong>${arcadeHistory.bests.city}</strong></div><div><span>포레스트 런 최고</span><strong>${arcadeHistory.bests.forest}</strong></div></div><p>최근 12회 아케이드 기록입니다. 최고 점수는 계속 보관됩니다.</p><div id="arcade-record-list"></div>`);
  const list=$('#arcade-record-list');
  if(!arcadeHistory.records.length){const p=document.createElement('p');p.className='guide-note';p.textContent='아직 비행 기록이 없어요. 첫 점수를 남겨보세요.';list.append(p);}
  for(const record of arcadeHistory.records){
    const button=document.createElement('button');button.className='record-entry';
    const text=document.createElement('span'),title=document.createElement('b'),meta=document.createElement('small'),score=document.createElement('span');
    title.textContent=MAPS[record.mapId].title;meta.textContent=`SKY RUSH · 링 ${record.rings} · 표적 ${record.destroyed || 0} · ${timeLabel(record.elapsed)}`;
    score.textContent=`${record.score.toLocaleString()} PTS`;text.append(title,meta);button.append(text,score);button.onclick=()=>showArcadeReport(record);list.append(button);
  }
}

function exportReport(report) {
  const header = 'time_s,x_m,altitude_m,z_m,pitch_deg,roll_deg,speed_mps';
  const lines = report.samples.map(s => [s.t, s.x, s.y, s.z, s.pitch, s.roll, s.speed].map(n => n.toFixed(3)).join(','));
  const blob = new Blob([`\uFEFF${header}\n${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `airframe-${report.lesson}-${report.id}.csv`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateWindButtons() { $$('[data-wind]').forEach(button => { const active = Number(button.dataset.wind) === state.wind; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); }); }
function changeCamera(mode) {
  state.camera = mode; scene.cameraMode = mode; scene.cameraInitialized = false;
  if (mode === 'observer' && isArcade()) {
    arcadeInput.reset();
    if (document.pointerLockElement) document.exitPointerLock();
  }
  $$('[data-camera]').forEach(button => { const active = button.dataset.camera === mode; button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active)); });
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').classList.add('visible'); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3700); }

function readPreferences() {
  try { return JSON.parse(localStorage.getItem('airframe-controls-v1') || '{}') || {}; }
  catch { return {}; }
}

function savePreferences() {
  try { localStorage.setItem('airframe-controls-v1', JSON.stringify({ sound: soundEnabled, sensitivity: Number($('#sensitivity').value) })); }
  catch { /* Controls still work when browser storage is unavailable. */ }
}

function syncSoundButton() {
  $('#sound-button').setAttribute('aria-pressed', String(soundEnabled));
  $('#sound-button').setAttribute('aria-label', `게임 소리 ${soundEnabled ? '끄기' : '켜기'}`);
  $('#sound-button use').setAttribute('href', soundEnabled ? '#i-sound' : '#i-muted');
}

async function initAudio() {
  if (!soundEnabled) return;
  try {
    if (!audioContext) {
      audioContext = new AudioContext(); oscillator = audioContext.createOscillator();
      audioGain = audioContext.createGain(); audioBus = audioContext.createGain();
      const filter = audioContext.createBiquadFilter();
      oscillator.type = 'sawtooth'; filter.type = 'lowpass'; filter.frequency.value = 380; audioGain.gain.value = 0;
      oscillator.connect(filter); filter.connect(audioGain); audioGain.connect(audioBus); audioBus.connect(audioContext.destination); oscillator.start();
      noiseBuffer = audioContext.createBuffer(1, audioContext.sampleRate * .4, audioContext.sampleRate);
      const samples = noiseBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;
    }
    await audioContext.resume(); updateAudio();
  } catch { soundEnabled = false; syncSoundButton(); toast('소리를 시작하지 못했습니다. 소리 버튼으로 다시 시도할 수 있어요.'); }
}

function playEffect(frequency, duration, { wave = 'sine', volume = .04, delay = 0, end = frequency * .55 } = {}) {
  if (!soundEnabled || !audioContext || audioContext.state !== 'running') return;
  const tone = audioContext.createOscillator(), gain = audioContext.createGain();
  const t = audioContext.currentTime + delay;
  tone.type = wave; tone.frequency.setValueAtTime(frequency, t);
  tone.frequency.exponentialRampToValueAtTime(end, t + duration);
  gain.gain.setValueAtTime(.001, t); gain.gain.linearRampToValueAtTime(volume, t + .006);
  gain.gain.exponentialRampToValueAtTime(.001, t + duration);
  tone.connect(gain); gain.connect(audioBus); tone.start(t); tone.stop(t + duration);
  tone.onended = () => { tone.disconnect(); gain.disconnect(); };
}

function playNoise(duration, volume, cutoff) {
  if (!soundEnabled || !noiseBuffer || audioContext.state !== 'running') return;
  const source = audioContext.createBufferSource(), filter = audioContext.createBiquadFilter(), gain = audioContext.createGain();
  source.buffer = noiseBuffer; filter.type = 'lowpass'; filter.frequency.value = cutoff;
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
  source.connect(filter); filter.connect(gain); gain.connect(audioBus); source.start(); source.stop(audioContext.currentTime + duration);
  source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
}

function playArcadeSound(event) {
  switch (event.type) {
    case 'shot': playEffect(event.powered ? 440 : 260, .085, { wave: 'triangle', volume: .025, end: 75 }); break;
    case 'hit': playEffect(event.destroyed ? 1200 : 850, .055, { volume: .035, end: 450 }); break;
    case 'target':
      playNoise(.24, .085, 1500); playEffect(130, .2, { wave: 'triangle', volume: .09, end: 35 });
      [660, 880, 1320].forEach((note, i) => playEffect(note, .12, { delay: i * .055, volume: .025, end: note })); break;
    case 'ring':
      [523, 659, event.perfect ? 1046 : 784].forEach((note, i) => playEffect(note, .2, { delay: i * .05, volume: .04, end: note * 1.01 })); break;
    case 'crystal': playEffect(1320, .12, { end: 1760, volume: .025 }); break;
    case 'damage': playNoise(.3, .12, 600); playEffect(85, .3, { wave: 'triangle', volume: .1, end: 30 }); break;
    case 'repair': [440, 660, 880].forEach((note, i) => playEffect(note, .18, { delay: i * .09, end: note })); break;
    case 'overdrive': [262, 330, 392, 523, 784, 1046].forEach((note, i) => playEffect(note, .24, { wave: 'triangle', delay: i * .06, end: note, volume: .05 })); break;
    case 'overheat': playEffect(180, .2, { wave: 'triangle', end: 100 }); break;
    case 'time': playEffect(event.seconds <= 3 ? 880 : 440, .06, { volume: .025, end: event.seconds <= 3 ? 880 : 440 }); break;
  }
}

function updateAudio() {
  if (!audioGain) return;
  audioBus.gain.setTargetAtTime(soundEnabled && !state.paused && !document.hidden ? .8 : 0, audioContext.currentTime, .03);
  audioGain.gain.setTargetAtTime(state.running ? .008 + drone.throttle * .014 : 0, audioContext.currentTime, .12);
  oscillator.frequency.setTargetAtTime(45 + Math.sqrt(drone.throttle) * 135 + (drone.boosting ? 55 : 0), audioContext.currentTime, .1);
}

$('#sound-button').onclick = () => {
  soundEnabled = !soundEnabled; syncSoundButton(); savePreferences();
  if (soundEnabled) initAudio(); else updateAudio();
};
$('#sensitivity').value = String(clamp(Number(preferences.sensitivity) || 1, .5, 2));
$('#sensitivity').addEventListener('change', savePreferences);
syncSoundButton();

$('#start-button').onclick = () => state.running ? pause() : start();
$('#pause-button').onclick = pause;
$('#reset-button').onclick = () => start();
$('#end-button').onclick = () => finishSession();
$('#controls-button').onclick = showGuide; $('#nav-guide').onclick = showGuide; $('#nav-records').onclick = showRecords; $('#about-button').onclick = showAbout;
$('#nav-field').onclick = () => selectActivity('training');
$('#nav-arcade').onclick = () => selectActivity('arcade');
$$('[data-map]').forEach(button=>button.onclick=()=>{state.map=button.dataset.map;prepare();});
$('#dialog-close').onclick = () => dialog.close();
// Inputs were cleared when opening the modal. Do not discard fresh keys that
// arrive between dialog.close() and its asynchronously dispatched close event.
dialog.addEventListener('close', () => { accumulator = 0; if (state.running) { state.paused = false; updateAudio(); } else if (scene) prepare(); });
dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); });
$$('[data-lesson]').forEach(button => button.onclick = () => prepare(button.dataset.lesson));
$('#free-flight').onclick = () => prepare('free');
$('#mode-select').onchange = event => { state.mode = event.target.value; prepare(); };
$('#gust-toggle').onchange = event => { state.gusts = event.target.checked; prepare(); };
$$('[data-wind]').forEach(button => button.onclick = () => { state.wind = Number(button.dataset.wind); updateWindButtons(); prepare(); });
$$('[data-camera]').forEach(button => button.onclick = () => changeCamera(button.dataset.camera));
$('#fullscreen-button').onclick = async () => { try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('.flight-workspace').requestFullscreen) await $('.flight-workspace').requestFullscreen(); else toast('이 브라우저는 전체 화면을 지원하지 않습니다.'); } catch { toast('전체 화면을 열 수 없습니다.'); } };

const flightCodes = new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Numpad8', 'Numpad5', 'Numpad4', 'Numpad6', 'ShiftLeft', 'ShiftRight', 'Space', 'KeyQ', 'KeyE', 'KeyF', 'KeyV']);
window.addEventListener('keydown', event => {
  if (dialog.open || !state.running || event.ctrlKey || event.metaKey || event.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (event.code === 'Escape') { event.preventDefault(); if (!event.repeat) pause(); return; }
  if (event.code === 'KeyR') { event.preventDefault(); if (!event.repeat) start(); return; }
  if (event.code === 'KeyC') { event.preventDefault(); if (!event.repeat) { const cameras = ['chase', 'fpv', 'observer']; changeCamera(cameras[(cameras.indexOf(state.camera) + 1) % 3]); } return; }
  if (flightCodes.has(event.code)) { event.preventDefault(); keys.add(event.code); }
});
window.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { clearInput(); if (state.running && !state.paused) pause(); });
document.addEventListener('visibilitychange', () => { clearInput(); if (document.hidden && state.running && !state.paused) pause(); accumulator = 0; updateAudio(); });

function frame(now) {
  const dt = Math.min((now - lastTime) / 1000 || 0, 0.05); lastTime = now;
  if (!document.hidden) {
    if (state.running && !state.paused && countdown > 0) {
      countdown = Math.max(0, countdown - dt);
      $('#launch-countdown b').textContent = String(Math.ceil(countdown));
      $('#launch-countdown').hidden = countdown <= 0;
      const beat = Math.ceil(countdown);
      if (beat < lastCountdown) { lastCountdown = beat; playEffect(beat === 0 ? 1046 : 523, beat === 0 ? .25 : .09); }
      if (countdown <= 0) { $('#score-popup').textContent = 'LET’S FLY'; $('#score-popup').dataset.kind = 'launch'; $('#score-popup').classList.add('visible'); scorePopupTimer = setTimeout(() => $('#score-popup').classList.remove('visible'), 900); }
    } else if (state.running && !state.paused) {
      accumulator += dt;
      while (accumulator >= FIXED_DT) {
        smoothInput(FIXED_DT); drone.step(FIXED_DT, input); state.session.tick(FIXED_DT, drone, input); handleArcadeEvents(); accumulator -= FIXED_DT;
        if (state.session.finished) { finishSession(); accumulator = 0; break; }
      }
      trailTimer += dt;
      if (trailTimer > 0.2) { scene.addTrail(drone.position); trailTimer = 0; }
    }
    if (!state.paused) scene.render(drone, state.session, dt, state.running, now / 1000);
    updateAimReticle();
    uiTimer += dt;
    if (uiTimer >= 0.1) { uiTimer = 0; updateTelemetry(); drawMinimap(); drawAltitude($('#altitude-chart'), state.session?.samples || [], 30, !isArcade()&&['hover', 'attitude', 'square'].includes(state.lesson)); updateAudio(); }
  }
  requestAnimationFrame(frame);
}

try {
  scene = new FlightScene($('#world'));
  drone.obstacles = scene.obstacles;
  const resize = () => { const bounds = stage.getBoundingClientRect(); scene.resize(bounds.width, bounds.height); };
  new ResizeObserver(resize).observe(stage); resize();
  $('#scene-loading').hidden = true; $('#start-button').disabled = false;
  prepare(); updateRecordsBadge(); requestAnimationFrame(frame);
  $('#world').addEventListener('webglcontextlost', event => { event.preventDefault(); if (state.running) pause(); $('#scene-loading').hidden = false; $('#scene-loading').textContent = '그래픽 연결이 끊어졌습니다. 페이지를 새로고침해 다시 시작하세요.'; $('#start-button').disabled = true; });
} catch (error) {
  console.error(error);
  $('#scene-loading').textContent = '3D 화면을 시작할 수 없습니다. WebGL 2를 지원하는 브라우저에서 하드웨어 가속을 켜고 다시 열어주세요.';
  $('#start-button span').textContent = '3D 화면을 확인해주세요';
}
