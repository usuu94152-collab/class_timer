(() => {
  'use strict';

  const ACTIVITY_TYPE = 'obstacle_run';
  const STORAGE_KEY = 'movement-records-obstacle-run-v1';
  const CLASS_STORAGE_KEY = 'movement-records-selected-class-v1';
  const GROUP_STORAGE_KEY = 'movement-records-selected-group-v1';
  const API_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyxpjMufyOkttT0ZBQIKCA3BOJpZWKjAz4-TuGzYdwNz0kYi0TkcqBVGQIPze8IUVjN/exec';

  let students = JSON.parse(document.getElementById('student-data').textContent);
  const screens = [...document.querySelectorAll('[data-screen]')];
  const classTabs = document.getElementById('class-tabs');
  const groupTabs = document.getElementById('group-tabs');
  const studentsGrid = document.getElementById('students-grid');
  const emptyState = document.getElementById('empty-state');
  const toast = document.getElementById('toast');
  let availableClasses = getAvailableClasses(students);

  const state = {
    screen: 'selection',
    selectedClass: readSelectedClass(),
    selectedGroup: '',
    selectedStudentId: null,
    recordsStudentId: null,
    timerStatus: 'idle',
    startedAt: 0,
    elapsedMs: 0,
    timerId: null,
    pendingRecord: null,
    isSaving: false
  };

  let records = readRecords()
    .map((record) => normalizeRecord(record, record.sync_status || (record.record_id ? 'pending' : 'synced')))
    .filter(Boolean);
  let toastTimer = null;

  function getAvailableClasses(studentList) {
    return [...new Set(studentList.map((student) => Number(student.class)))]
      .filter((classNo) => Number.isInteger(classNo) && classNo > 0)
      .sort((first, second) => first - second);
  }

  function normalizeStudent(student) {
    if (!student || student.student_id === undefined || student.name === undefined) return null;
    const classNo = Number(student.class);
    const number = Number(student.number);
    const studentId = String(student.student_id).trim();
    if (!Number.isInteger(classNo) || classNo < 1 || !Number.isInteger(number) || number < 1) return null;
    const name = String(student.name).trim();
    const group = String(student.group_or_team || '').trim();
    if (!studentId || !name || !group) return null;
    return {
      student_id: studentId,
      grade: Number(student.grade),
      class: classNo,
      number,
      name,
      group_or_team: group
    };
  }

  function normalizeRecord(record, syncStatus) {
    if (!record || record.student_id === undefined || record.timestamp === undefined) return null;
    const attemptNo = Number(record.attempt_no);
    const recordSeconds = Number(record.record_seconds);
    const timestamp = String(record.timestamp).trim();
    const activityType = String(record.activity_type || ACTIVITY_TYPE).trim();
    if (!timestamp || !record.student_id || activityType !== ACTIVITY_TYPE || !Number.isInteger(attemptNo) || attemptNo < 1 || !Number.isFinite(recordSeconds) || recordSeconds < 0) return null;
    return {
      timestamp,
      student_id: String(record.student_id).trim(),
      grade: Number(record.grade),
      class: Number(record.class),
      number: Number(record.number),
      name: String(record.name || '').trim(),
      group_or_team: String(record.group_or_team || '').trim(),
      attempt_no: attemptNo,
      record_seconds: Number(recordSeconds.toFixed(2)),
      activity_type: activityType,
      record_id: record.record_id ? String(record.record_id) : '',
      sync_status: syncStatus || 'pending'
    };
  }

  function recordFingerprint(record) {
    return [
      record.student_id,
      record.attempt_no,
      Number(record.record_seconds).toFixed(2),
      record.activity_type
    ].join('|');
  }

  function mergeRecords(existingRecords, incomingRecords) {
    const merged = existingRecords
      .map((record) => normalizeRecord(record, record.sync_status || 'pending'))
      .filter(Boolean);

    incomingRecords
      .map((record) => normalizeRecord(record, record.sync_status || 'synced'))
      .filter(Boolean)
      .forEach((incoming) => {
        const index = merged.findIndex((record) => (
          (incoming.record_id && record.record_id === incoming.record_id) ||
          recordFingerprint(record) === recordFingerprint(incoming)
        ));
        if (index === -1) {
          merged.push(incoming);
        } else {
          merged[index] = { ...merged[index], ...incoming };
        }
      });

    return merged.sort((first, second) => new Date(first.timestamp) - new Date(second.timestamp));
  }

  function createRecordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function buildApiUrl(action) {
    const url = new URL(API_ENDPOINT);
    url.searchParams.set('action', action);
    return url.toString();
  }

  async function requestApi(url, options = {}) {
    const response = await fetch(url, {
      cache: 'no-store',
      credentials: 'include',
      ...options
    });
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('Google Sheets API가 JSON 응답을 보내지 않았습니다. Google 계정 로그인을 확인하세요.');
    }
    if (!response.ok || payload.ok !== true) {
      throw new Error(payload.error?.message || 'Google Sheets API 요청에 실패했습니다.');
    }
    return payload;
  }

  async function sendRecordToApi(record) {
    const payload = await requestApi(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({
        type: 'record',
        record: {
          student_id: record.student_id,
          attempt_no: record.attempt_no,
          record_seconds: record.record_seconds,
          activity_type: ACTIVITY_TYPE,
          record_id: record.record_id
        }
      })
    });
    return normalizeRecord({
      ...(payload.record || record),
      record_id: payload.record_id || record.record_id
    }, 'synced') || normalizeRecord(record, 'synced');
  }

  function setConnectionStatus(status, message) {
    const statusBadge = document.getElementById('connection-status');
    const statusLabel = document.getElementById('connection-status-label');
    if (!statusBadge || !statusLabel) return;
    statusBadge.dataset.status = status;
    statusLabel.textContent = message;
  }

  function applyRemoteStudents(remoteStudents) {
    const normalized = remoteStudents.map(normalizeStudent).filter(Boolean);
    if (!normalized.length) throw new Error('Students 시트에 사용할 학생 데이터가 없습니다.');
    students = normalized;
    availableClasses = getAvailableClasses(students);
    state.selectedClass = readSelectedClass();
    state.selectedGroup = readSelectedGroup(state.selectedClass);
  }

  async function syncPendingRecords() {
    const pendingRecords = records.filter((record) => record.sync_status !== 'synced' && record.record_id);
    for (const record of pendingRecords) {
      try {
        const syncedRecord = await sendRecordToApi(record);
        records = mergeRecords(records, [syncedRecord]);
      } catch (error) {
        console.warn('대기 중인 기록을 Google Sheets로 보내지 못했습니다.', error);
        break;
      }
    }
    writeRecords();
  }

  async function loadRemoteData() {
    let connected = false;
    try {
      const studentPayload = await requestApi(buildApiUrl('students'));
      applyRemoteStudents(studentPayload.data || []);
      connected = true;
    } catch (error) {
      console.warn('Students 시트를 불러오지 못했습니다.', error);
    }

    try {
      const recordsPayload = await requestApi(buildApiUrl('records'));
      const remoteRecords = (recordsPayload.data || []).map((record) => normalizeRecord(record, 'synced')).filter(Boolean);
      records = mergeRecords(records, remoteRecords);
      writeRecords();
      connected = true;
    } catch (error) {
      console.warn('Records 시트를 불러오지 못했습니다.', error);
    }

    renderSelection();
    if (connected) {
      setConnectionStatus('online', 'Google Sheets 연결됨');
      await syncPendingRecords();
    } else {
      setConnectionStatus('offline', '이 기기에 임시 저장');
      showToast('온라인 연결을 확인하지 못해 이 기기에 임시 저장합니다.');
    }
  }

  function readSelectedClass() {
    const storedClass = Number.parseInt(localStorage.getItem(CLASS_STORAGE_KEY), 10);
    return availableClasses.includes(storedClass) ? storedClass : (availableClasses[0] ?? 1);
  }

  function getGroupsForClass(classNo) {
    return [...new Set(students
      .filter((student) => Number(student.class) === classNo)
      .map((student) => student.group_or_team))]
      .sort((first, second) => {
        const firstGender = first.startsWith('남') ? 0 : first.startsWith('여') ? 1 : 2;
        const secondGender = second.startsWith('남') ? 0 : second.startsWith('여') ? 1 : 2;
        if (firstGender !== secondGender) return firstGender - secondGender;
        return Number.parseInt(first.replace(/\D/g, ''), 10) - Number.parseInt(second.replace(/\D/g, ''), 10);
      });
  }

  function readSelectedGroup(classNo) {
    const storedGroup = localStorage.getItem(GROUP_STORAGE_KEY);
    const groups = getGroupsForClass(classNo);
    return groups.includes(storedGroup) ? storedGroup : (groups[0] ?? '');
  }

  function syncSelectedGroup() {
    const groups = getGroupsForClass(state.selectedClass);
    if (!groups.includes(state.selectedGroup)) {
      state.selectedGroup = groups[0] ?? '';
      localStorage.setItem(GROUP_STORAGE_KEY, state.selectedGroup);
    }
    return groups;
  }

  function readRecords() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn('저장된 기록을 읽지 못했습니다.', error);
      return [];
    }
  }

  function writeRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  }

  function getStudent(studentId) {
    return students.find((student) => student.student_id === studentId);
  }

  function getStudentRecords(studentId) {
    return records
      .filter((record) => record.student_id === studentId && record.activity_type === ACTIVITY_TYPE)
      .sort((first, second) => new Date(first.timestamp) - new Date(second.timestamp));
  }

  function formatSeconds(seconds) {
    return Number(seconds || 0).toFixed(2);
  }

  function formatTime(seconds) {
    return `${formatSeconds(seconds)}<small>초</small>`;
  }

  function formatMeasuredAt(timestamp) {
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  }

  function setScreen(screenName) {
    state.screen = screenName;
    screens.forEach((screen) => {
      const isActive = screen.dataset.screen === screenName;
      screen.hidden = !isActive;
      screen.setAttribute('aria-hidden', String(!isActive));
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderClassTabs() {
    classTabs.innerHTML = availableClasses.map((classNo) => `
      <button class="class-tab${classNo === state.selectedClass ? ' is-selected' : ''}" type="button" role="tab" aria-selected="${classNo === state.selectedClass}" data-class="${classNo}">${classNo}반</button>`).join('');
  }

  function renderGroupTabs(groups) {
    groupTabs.innerHTML = groups.map((group) => `
      <button class="group-tab${group === state.selectedGroup ? ' is-selected' : ''}" type="button" role="tab" aria-selected="${group === state.selectedGroup}" data-group="${escapeHtml(group)}">${escapeHtml(group)}</button>`).join('');
  }

  function renderSelection() {
    const groups = syncSelectedGroup();
    const groupStudents = students.filter((student) => Number(student.class) === state.selectedClass && student.group_or_team === state.selectedGroup);
    document.getElementById('selected-class-label').textContent = `${state.selectedClass}반`;
    document.getElementById('selected-class-caption').textContent = `${state.selectedClass}반 수업`;
    document.getElementById('selected-group-label').textContent = state.selectedGroup;
    document.getElementById('group-count').textContent = groupStudents.length;
    renderClassTabs();
    renderGroupTabs(groups);

    studentsGrid.innerHTML = groupStudents.map((student) => {
      const studentRecords = getStudentRecords(student.student_id);
      const best = studentRecords.length ? Math.min(...studentRecords.map((record) => Number(record.record_seconds))) : null;
      return `
        <article class="student-card" data-student-id="${escapeHtml(student.student_id)}">
          <button class="student-select" type="button" data-action="select-student" aria-label="${escapeHtml(student.name)} 학생 측정 시작">
            <div class="student-card-top">
              <span class="student-avatar" aria-hidden="true">${escapeHtml(student.name.slice(0, 1))}</span>
              <div>
                <h3 class="student-name">${escapeHtml(student.name)}</h3>
                <span class="student-meta">${escapeHtml(student.number)}번 · ${escapeHtml(student.group_or_team)}</span>
              </div>
            </div>
            <dl class="student-stats">
              <div class="student-stat"><dt>연습</dt><dd>${studentRecords.length}<small>회</small></dd></div>
              <div class="student-stat"><dt>최고 기록</dt><dd>${best === null ? '—' : formatSeconds(best)}<small>${best === null ? '' : '초'}</small></dd></div>
            </dl>
          </button>
          <button class="student-history" type="button" data-action="view-records" aria-label="${escapeHtml(student.name)} 학생 기록 조회"><span aria-hidden="true">↗</span> 기록 보기</button>
        </article>`;
    }).join('');

    emptyState.hidden = groupStudents.length > 0;
    studentsGrid.hidden = groupStudents.length === 0;
  }

  function renderTimer() {
    const student = getStudent(state.selectedStudentId);
    if (!student) return;
    const display = document.getElementById('timer-display');
    const timerCard = document.querySelector('.timer-card');
    const startButton = document.getElementById('start-button');
    const stopButton = document.getElementById('stop-button');
    const isRunning = state.timerStatus === 'running';
    const seconds = state.timerStatus === 'running' ? (performance.now() - state.startedAt) / 1000 : state.elapsedMs / 1000;

    document.getElementById('timer-avatar').textContent = student.name.slice(0, 1);
    document.getElementById('timer-student-meta').textContent = `${student.class}반 · ${student.group_or_team} · ${student.number}번`;
    document.getElementById('timer-title').textContent = student.name;
    display.innerHTML = formatTime(seconds);
    timerCard.classList.toggle('is-running', isRunning);
    timerCard.classList.toggle('is-stopped', state.timerStatus === 'stopped');
    document.getElementById('timer-status').innerHTML = isRunning
      ? '<span class="status-pip" aria-hidden="true"></span>측정 중'
      : '<span class="status-pip" aria-hidden="true"></span>측정 전';
    document.getElementById('timer-instruction').textContent = isRunning ? '달리기가 끝나면 STOP을 눌러주세요.' : '출발 준비가 되면 START를 눌러주세요.';
    startButton.disabled = state.timerStatus !== 'idle';
    stopButton.disabled = !isRunning;
    document.querySelector('[data-action="back-to-selection"]').disabled = isRunning;
  }

  function renderConfirm() {
    const student = getStudent(state.pendingRecord?.student_id);
    if (!student || !state.pendingRecord) return;
    document.getElementById('confirm-avatar').textContent = student.name.slice(0, 1);
    document.getElementById('confirm-student-meta').textContent = `${student.class}반 · ${student.group_or_team} · ${student.number}번`;
    document.getElementById('confirm-student-name').textContent = student.name;
    document.getElementById('confirm-time').innerHTML = formatTime(state.pendingRecord.record_seconds);
    document.getElementById('confirm-attempt').textContent = `${state.pendingRecord.attempt_no}회차`;
    document.getElementById('save-button').disabled = false;
  }

  function renderRecords(studentId) {
    const student = getStudent(studentId);
    if (!student) return;
    const studentRecords = getStudentRecords(studentId);
    const best = studentRecords.length ? Math.min(...studentRecords.map((record) => Number(record.record_seconds))) : null;
    const latest = studentRecords.length ? studentRecords[studentRecords.length - 1].record_seconds : null;

    document.getElementById('records-title').textContent = `${student.name}의 기록`;
    document.getElementById('records-student-meta').textContent = `${student.class}반 · ${student.group_or_team} · ${student.number}번 · 장애물달리기`;
    document.getElementById('records-count').textContent = studentRecords.length;
    document.getElementById('records-attempts').innerHTML = `${studentRecords.length}<span>회</span>`;
    document.getElementById('records-best').innerHTML = best === null ? '—<span>초</span>' : `${formatSeconds(best)}<span>초</span>`;
    document.getElementById('records-latest').innerHTML = latest === null ? '—<span>초</span>' : `${formatSeconds(latest)}<span>초</span>`;

    const recordsList = document.getElementById('records-list');
    recordsList.innerHTML = [...studentRecords].reverse().map((record) => `
      <tr><td>${escapeHtml(record.attempt_no)}회차</td><td>${formatSeconds(record.record_seconds)}<small>초</small></td><td>${escapeHtml(formatMeasuredAt(record.timestamp))}</td></tr>`).join('');
    document.querySelector('.records-table').hidden = studentRecords.length === 0;
    document.getElementById('records-empty').hidden = studentRecords.length > 0;
  }

  function selectStudent(studentId) {
    if (state.timerStatus === 'running') {
      showToast('측정 중에는 학생을 변경할 수 없어요.');
      return;
    }
    if (!getStudent(studentId)) return;
    state.selectedStudentId = studentId;
    state.timerStatus = 'idle';
    state.elapsedMs = 0;
    state.pendingRecord = null;
    setScreen('timer');
    renderTimer();
  }

  function startTimer() {
    if (state.timerStatus !== 'idle' || !state.selectedStudentId) return;
    state.timerStatus = 'running';
    state.startedAt = performance.now();
    renderTimer();
    state.timerId = window.setInterval(() => {
      if (state.timerStatus !== 'running') return;
      renderTimer();
    }, 40);
  }

  function stopTimer() {
    if (state.timerStatus !== 'running') return;
    window.clearInterval(state.timerId);
    state.timerId = null;
    state.elapsedMs = Math.max(10, performance.now() - state.startedAt);
    const student = getStudent(state.selectedStudentId);
    const attemptNo = getStudentRecords(state.selectedStudentId).length + 1;
    state.timerStatus = 'stopped';
    state.pendingRecord = {
      timestamp: new Date().toISOString(),
      student_id: student.student_id,
      grade: student.grade,
      class: student.class,
      number: student.number,
      name: student.name,
      group_or_team: student.group_or_team,
      attempt_no: attemptNo,
      record_seconds: Number((state.elapsedMs / 1000).toFixed(2)),
      activity_type: ACTIVITY_TYPE,
      record_id: createRecordId(),
      sync_status: 'pending'
    };
    setScreen('confirm');
    renderConfirm();
  }

  function resetToSelection(message) {
    window.clearInterval(state.timerId);
    state.timerId = null;
    state.screen = 'selection';
    state.selectedStudentId = null;
    state.recordsStudentId = null;
    state.timerStatus = 'idle';
    state.startedAt = 0;
    state.elapsedMs = 0;
    state.pendingRecord = null;
    state.isSaving = false;
    setScreen('selection');
    renderSelection();
    if (message) showToast(message);
  }

  async function saveRecord() {
    if (state.timerStatus !== 'stopped' || !state.pendingRecord || state.isSaving) return;
    state.isSaving = true;
    document.getElementById('save-button').disabled = true;
    const localRecord = normalizeRecord(state.pendingRecord, 'pending');
    if (!localRecord) {
      state.isSaving = false;
      document.getElementById('save-button').disabled = false;
      showToast('기록 형식이 올바르지 않아 저장하지 못했어요.');
      return;
    }
    try {
      const syncedRecord = await sendRecordToApi(localRecord);
      records = mergeRecords(records, [syncedRecord]);
      writeRecords();
      setConnectionStatus('online', 'Google Sheets 연결됨');
      resetToSelection('Google Sheets에 기록이 저장됐어요. 다음 학생을 선택해 주세요.');
    } catch (error) {
      console.error('기록 저장에 실패했습니다.', error);
      records = mergeRecords(records, [localRecord]);
      writeRecords();
      setConnectionStatus('offline', '이 기기에 임시 저장');
      resetToSelection('온라인 저장에 실패해 이 기기에 임시 저장했어요. 연결되면 다시 전송합니다.');
    }
  }

  function openRecords(studentId) {
    if (state.timerStatus === 'running') {
      showToast('측정 중에는 기록을 조회할 수 없어요.');
      return;
    }
    state.recordsStudentId = studentId;
    setScreen('records');
    renderRecords(studentId);
  }

  function showToast(message) {
    window.clearTimeout(toastTimer);
    toast.textContent = message;
    toast.hidden = false;
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 3200);
  }

  document.addEventListener('click', (event) => {
    const classTab = event.target.closest('.class-tab');
    if (classTab) {
      if (state.timerStatus === 'running') {
        showToast('측정 중에는 반을 변경할 수 없어요.');
        return;
      }
      state.selectedClass = Number(classTab.dataset.class);
      state.selectedGroup = readSelectedGroup(state.selectedClass);
      localStorage.setItem(CLASS_STORAGE_KEY, String(state.selectedClass));
      localStorage.setItem(GROUP_STORAGE_KEY, state.selectedGroup);
      renderSelection();
      return;
    }

    const groupTab = event.target.closest('.group-tab');
    if (groupTab) {
      if (state.timerStatus === 'running') {
        showToast('측정 중에는 조를 변경할 수 없어요.');
        return;
      }
      state.selectedGroup = groupTab.dataset.group;
      localStorage.setItem(GROUP_STORAGE_KEY, state.selectedGroup);
      renderSelection();
      return;
    }

    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    if (action === 'home') {
      event.preventDefault();
      if (state.timerStatus === 'running') {
        showToast('측정 중에는 화면을 이동할 수 없어요.');
        return;
      }
      resetToSelection();
    } else if (action === 'select-student') {
      selectStudent(actionTarget.closest('[data-student-id]')?.dataset.studentId);
    } else if (action === 'view-records') {
      openRecords(actionTarget.closest('[data-student-id]')?.dataset.studentId);
    } else if (action === 'start-timer') {
      startTimer();
    } else if (action === 'stop-timer') {
      stopTimer();
    } else if (action === 'save-record') {
      saveRecord();
    } else if (action === 'cancel-record') {
      resetToSelection('기록을 저장하지 않고 학생 선택으로 돌아왔어요.');
    } else if (action === 'back-to-selection') {
      if (state.timerStatus === 'running') {
        showToast('측정 중에는 학생을 변경할 수 없어요.');
        return;
      }
      resetToSelection();
    }
  });

  state.selectedGroup = readSelectedGroup(state.selectedClass);
  renderSelection();
  loadRemoteData();
})();
