/**
 * ESP32-S3 Face Authentication Hub - Frontend Controller
 * WebSocket real-time client, REST API integration, and audio cues
 */

// Application State
const state = {
  ws: null,
  wsConnected: false,
  soundEnabled: true,
  currentEnrollment: null,
  audioCtx: null
};

// Posture Prompts for 10-step embedding capture
const GUIDANCE_STEPS = [
  "Look straight at the ESP32 camera lens...",
  "Keep your head steady...",
  "Tilt your head slightly to the right...",
  "Tilt your head slightly to the left...",
  "Raise your chin slightly upwards...",
  "Lower your chin slightly...",
  "Slight facial expression (smile or neutral)...",
  "Hold steady for fine feature extraction...",
  "Almost complete, final embedding capture...",
  "Writing 10 face embeddings to MicroSD..."
];

// Initialize Audio Context on first interaction
function initAudio() {
  if (!state.audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      state.audioCtx = new AudioContext();
    }
  }
}

// Synthesized Sound Effects
function playSound(type) {
  if (!state.soundEnabled || !state.audioCtx) return;
  try {
    const now = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

    if (type === 'authorized') {
      // Pleasant futuristic double chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'denied') {
      // Low dual cyber alert tone
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'capture') {
      // Subtle shutter click
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(300, now + 0.05);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
      osc.start(now);
      osc.stop(now + 0.06);
    }
  } catch (e) {
    console.warn('Audio playback error:', e);
  }
}

// DOM Elements
const elements = {
  mqttStatusPill: document.getElementById('mqttStatusPill'),
  mqttStatusText: document.getElementById('mqttStatusText'),
  deviceStatusPill: document.getElementById('deviceStatusPill'),
  deviceStatusText: document.getElementById('deviceStatusText'),
  soundToggleBtn: document.getElementById('soundToggleBtn'),
  soundIcon: document.getElementById('soundIcon'),

  // KPIs
  kpiRegisteredUsers: document.getElementById('kpiRegisteredUsers'),
  kpiPassRate: document.getElementById('kpiPassRate'),
  kpiPassRateDetail: document.getElementById('kpiPassRateDetail'),
  kpiTotalEvents: document.getElementById('kpiTotalEvents'),
  kpiIntruders: document.getElementById('kpiIntruders'),

  // Feeds & Tables
  authFeedList: document.getElementById('authFeedList'),
  usersTableBody: document.getElementById('usersTableBody'),
  intruderGrid: document.getElementById('intruderGrid'),
  intruderCountBadge: document.getElementById('intruderCountBadge'),

  // Modals
  openEnrollModalBtn: document.getElementById('openEnrollModalBtn'),
  enrollModal: document.getElementById('enrollModal'),
  closeEnrollModalBtn: document.getElementById('closeEnrollModalBtn'),
  cancelEnrollBtn: document.getElementById('cancelEnrollBtn'),
  enrollForm: document.getElementById('enrollForm'),
  enrollUserId: document.getElementById('enrollUserId'),
  enrollUserName: document.getElementById('enrollUserName'),
  enrollStep1: document.getElementById('enrollStep1'),
  enrollStep2: document.getElementById('enrollStep2'),
  enrollStep3: document.getElementById('enrollStep3'),
  captureCurrentNum: document.getElementById('captureCurrentNum'),
  captureTotalNum: document.getElementById('captureTotalNum'),
  captureProgressBar: document.getElementById('captureProgressBar'),
  guidanceText: document.getElementById('guidanceText'),
  stepTicksContainer: document.getElementById('stepTicksContainer'),
  summaryUserName: document.getElementById('summaryUserName'),
  summaryUserId: document.getElementById('summaryUserId'),
  finishEnrollBtn: document.getElementById('finishEnrollBtn'),
  simStepBtn: document.getElementById('simStepBtn'),

  // Lightbox
  imageLightboxModal: document.getElementById('imageLightboxModal'),
  closeLightboxBtn: document.getElementById('closeLightboxBtn'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxTime: document.getElementById('lightboxTime'),
  lightboxSimilarity: document.getElementById('lightboxSimilarity'),

  // Simulators
  simAuthPassBtn: document.getElementById('simAuthPassBtn'),
  simAuthFailBtn: document.getElementById('simAuthFailBtn'),
  refreshUsersBtn: document.getElementById('refreshUsersBtn'),
  toastContainer: document.getElementById('toastContainer')
};

// ============================================================================
// Toast Notifications
// ============================================================================
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  let icon = 'fa-info-circle';
  if (type === 'success') icon = 'fa-check-circle';
  if (type === 'error') icon = 'fa-circle-exclamation';

  toast.innerHTML = `
    <i class="fa-solid ${icon}"></i>
    <span>${escapeHtml(message)}</span>
  `;

  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================================
// WebSocket Real-Time Stream
// ============================================================================
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('[WebSocket] Connected to hub');
    state.wsConnected = true;
    updateMqttUI('connected');
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleIncomingEvent(msg);
    } catch (err) {
      console.warn('Failed to parse WS payload:', err);
    }
  };

  state.ws.onclose = () => {
    state.wsConnected = false;
    updateMqttUI('disconnected');
    setTimeout(connectWebSocket, 3000);
  };

  state.ws.onerror = (err) => {
    console.error('[WebSocket] Error:', err);
  };
}

// Handle Real-Time Events from Hub
function handleIncomingEvent(msg) {
  const { event, data } = msg;

  switch (event) {
    case 'connected':
      if (data.deviceStatus) {
        updateMqttUI(data.deviceStatus.connectionStatus);
        updateDeviceBusyUI(data.deviceStatus.deviceState);
      }
      break;

    case 'device_status':
      if (data.mqtt) updateMqttUI(data.mqtt);
      if (data.deviceState) updateDeviceBusyUI(data.deviceState);
      break;

    case 'authentication_authorized':
      renderAuthFeedItem({
        status: 'authorized',
        user_name: data.name,
        user_id: data.id,
        similarity: data.similarity,
        created_at: data.timestamp
      }, true);
      playSound('authorized');
      fetchStats();
      break;

    case 'authentication_denied':
      renderAuthFeedItem({
        status: 'denied',
        user_name: 'Unrecognized Person',
        similarity: data.similarity,
        created_at: data.timestamp
      }, true);
      playSound('denied');
      fetchStats();
      break;

    case 'intruder_image':
      attachIntruderImageToLatestFeed(data.imagePath);
      prependIntruderGalleryItem(data);
      fetchStats();
      break;

    case 'registration_progress':
      updateRegistrationProgressUI(data);
      playSound('capture');
      break;

    case 'registration_success':
      completeRegistrationUI(data);
      playSound('authorized');
      fetchUsers();
      fetchStats();
      break;

    case 'registration_failed':
      failRegistrationUI(data);
      playSound('denied');
      fetchUsers();
      break;

    case 'deletion_success':
      showToast(`User ID ${data.id} erased from ESP32 database`, 'success');
      fetchUsers();
      fetchStats();
      break;

    case 'deletion_failed':
      showToast(`Failed to erase User ID ${data.id}: ${data.reason}`, 'error');
      fetchUsers();
      break;

    default:
      console.log('Hub event:', event, data);
  }
}

// ============================================================================
// UI Renderers & State Updaters
// ============================================================================

function updateMqttUI(status) {
  const dot = elements.mqttStatusPill.querySelector('.pulse-dot');
  if (status === 'connected') {
    dot.className = 'pulse-dot status-connected';
    elements.mqttStatusText.textContent = 'MQTT: Connected';
  } else if (status === 'reconnecting' || status === 'connecting') {
    dot.className = 'pulse-dot status-busy';
    elements.mqttStatusText.textContent = 'MQTT: Connecting...';
  } else {
    dot.className = 'pulse-dot status-error';
    elements.mqttStatusText.textContent = 'MQTT: Offline';
  }
}

function updateDeviceBusyUI(deviceState) {
  if (!deviceState) return;
  if (deviceState.isBusy) {
    elements.deviceStatusPill.style.borderColor = 'var(--color-amber)';
    elements.deviceStatusText.textContent = `ESP32: Busy (${deviceState.busyReason || 'Working'})`;
  } else {
    elements.deviceStatusPill.style.borderColor = 'var(--border-subtle)';
    elements.deviceStatusText.textContent = 'ESP32: Ready';
  }
}

// Fetch and render users table
async function fetchUsers() {
  try {
    const res = await fetch('/api/users');
    const data = await res.json();
    if (data.success) {
      renderUsersTable(data.users);
    }
  } catch (err) {
    console.error('Failed to load users:', err);
  }
}

function renderUsersTable(users) {
  if (!users || users.length === 0) {
    elements.usersTableBody.innerHTML = `
      <tr>
        <td colspan="5" class="empty-state">
          <i class="fa-solid fa-user-slash"></i>
          <p>No profiles enrolled. Click "Enroll Face" to add your first user.</p>
        </td>
      </tr>
    `;
    return;
  }

  elements.usersTableBody.innerHTML = users.map(user => `
    <tr>
      <td style="font-family: var(--font-mono); font-weight: 600; color: var(--color-blue);">#${user.id}</td>
      <td style="font-weight: 600;">${escapeHtml(user.name)}</td>
      <td>
        <span class="user-samples-badge">
          <i class="fa-solid fa-cube"></i> ${user.samples || 10}/10 Embeddings
        </span>
      </td>
      <td>
        ${user.status === 'registered'
      ? '<span class="badge badge-online">Registered</span>'
      : `<span class="badge badge-denied">${escapeHtml(user.status)}</span>`}
      </td>
      <td style="text-align: right;">
        <button class="btn-delete" onclick="window.deleteUser(${user.id}, '${escapeHtml(user.name)}')">
          <i class="fa-solid fa-trash-can"></i> Delete
        </button>
      </td>
    </tr>
  `).join('');
}

// Delete User handler
window.deleteUser = async function (id, name) {
  if (!confirm(`Are you sure you want to delete "${name}" (ID: ${id}) from the ESP32 MicroSD face database?`)) {
    return;
  }

  try {
    const res = await fetch(`/api/users/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Delete request sent for ${name}. Waiting for ESP32...`, 'info');
      fetchUsers();
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to dispatch delete command', 'error');
  }
};

// Fetch and render live authentication feed
async function fetchAuthHistory() {
  try {
    const res = await fetch('/api/auth/history?limit=25');
    const data = await res.json();
    if (data.success) {
      renderAuthFeedList(data.events);
    }
  } catch (err) {
    console.error('Failed to load auth feed:', err);
  }
}

function renderAuthFeedList(events) {
  if (!events || events.length === 0) {
    elements.authFeedList.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-id-badge"></i>
        <p>No verification events recorded yet. Press GPIO 1 on ESP32 to test.</p>
      </div>
    `;
    return;
  }

  elements.authFeedList.innerHTML = '';
  events.forEach(evt => renderAuthFeedItem(evt, false));
}

function renderAuthFeedItem(evt, prepend = false) {
  const isAuth = evt.status === 'authorized';
  const item = document.createElement('div');
  item.className = `auth-feed-item ${isAuth ? 'authorized' : 'denied'}`;

  const formattedTime = formatTimestamp(evt.created_at);
  const similarityScore = evt.similarity !== null && evt.similarity !== undefined
    ? Number(evt.similarity).toFixed(3)
    : (isAuth ? '0.890' : '0.412');

  const similarityClass = isAuth ? 'high' : 'low';

  item.innerHTML = `
    <div class="feed-item-left">
      <div class="feed-avatar ${isAuth ? 'auth' : 'denied'}">
        <i class="fa-solid ${isAuth ? 'fa-user-check' : 'fa-user-xmark'}"></i>
      </div>
      <div class="feed-user-details">
        <span class="feed-user-name">${escapeHtml(evt.user_name || (isAuth ? 'Authorized User' : 'Unrecognized Person'))}</span>
        <span class="feed-user-meta">
          ${isAuth ? `User ID #${evt.user_id}` : 'Threshold: 0.70'} • ${formattedTime}
        </span>
      </div>
    </div>
    <div class="feed-item-right">
      <span class="similarity-pill ${similarityClass}">
        <i class="fa-solid fa-chart-simple"></i> ${similarityScore}
      </span>
      ${evt.image_path ? `
        <button class="feed-thumbnail-btn" onclick="window.openLightbox('${evt.image_path}', '${similarityScore}', '${formattedTime}')">
          <img src="${evt.image_path}" class="feed-thumb-img" alt="Intruder Snapshot">
        </button>
      ` : ''}
    </div>
  `;

  if (prepend && elements.authFeedList.firstChild) {
    // Remove empty state if present
    const emptyState = elements.authFeedList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();

    elements.authFeedList.insertBefore(item, elements.authFeedList.firstChild);
  } else {
    elements.authFeedList.appendChild(item);
  }
}

function attachIntruderImageToLatestFeed(imagePath) {
  const latestDenied = elements.authFeedList.querySelector('.auth-feed-item.denied');
  if (latestDenied) {
    const rightCol = latestDenied.querySelector('.feed-item-right');
    if (rightCol && !rightCol.querySelector('.feed-thumb-img')) {
      const btn = document.createElement('button');
      btn.className = 'feed-thumbnail-btn';
      btn.onclick = () => window.openLightbox(imagePath, '0.420', 'Just now');
      btn.innerHTML = `<img src="${imagePath}" class="feed-thumb-img" alt="Intruder Snapshot">`;
      rightCol.appendChild(btn);
    }
  }
}

// Fetch and render Intruder Gallery
async function fetchIntruders() {
  try {
    const res = await fetch('/api/intruders');
    const data = await res.json();
    if (data.success) {
      renderIntruderGrid(data.intruders);
    }
  } catch (err) {
    console.error('Failed to load intruders:', err);
  }
}

function renderIntruderGrid(intruders) {
  elements.intruderCountBadge.textContent = intruders ? intruders.length : 0;

  if (!intruders || intruders.length === 0) {
    elements.intruderGrid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i class="fa-solid fa-shield-halved"></i>
        <p>No unrecognized captures recorded yet.</p>
      </div>
    `;
    return;
  }

  elements.intruderGrid.innerHTML = intruders.map(item => `
    <div class="intruder-card" onclick="window.openLightbox('${item.image_path}', '${Number(item.similarity || 0.42).toFixed(3)}', '${formatTimestamp(item.created_at)}')">
      <img src="${item.image_path}" alt="Intruder Capture" loading="lazy">
      <div class="intruder-overlay">
        <span class="intruder-score"><i class="fa-solid fa-triangle-exclamation"></i> ${Number(item.similarity || 0.42).toFixed(3)}</span>
        <span class="intruder-time">${formatTimestamp(item.created_at)}</span>
      </div>
    </div>
  `).join('');
}

function prependIntruderGalleryItem(data) {
  const emptyState = elements.intruderGrid.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const card = document.createElement('div');
  card.className = 'intruder-card';
  card.onclick = () => window.openLightbox(data.imagePath, Number(data.similarity || 0.42).toFixed(3), 'Just now');
  card.innerHTML = `
    <img src="${data.imagePath}" alt="Intruder Capture">
    <div class="intruder-overlay">
      <span class="intruder-score"><i class="fa-solid fa-triangle-exclamation"></i> ${Number(data.similarity || 0.42).toFixed(3)}</span>
      <span class="intruder-time">Just now</span>
    </div>
  `;

  elements.intruderGrid.insertBefore(card, elements.intruderGrid.firstChild);
  const currentCount = Number(elements.intruderCountBadge.textContent) || 0;
  elements.intruderCountBadge.textContent = currentCount + 1;
}

// Fetch KPI statistics
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.success) {
      const { registeredUsers, totalEvents, authorizedCount, deniedCount, passRate } = data.stats;
      elements.kpiRegisteredUsers.textContent = registeredUsers;
      elements.kpiTotalEvents.textContent = totalEvents;
      elements.kpiIntruders.textContent = deniedCount;
      elements.kpiPassRate.textContent = `${passRate}%`;
      elements.kpiPassRateDetail.textContent = `${authorizedCount} of ${totalEvents} authorized`;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ============================================================================
// Enrollment Modal & Async Progress Flow
// ============================================================================

function openEnrollModal() {
  initAudio();
  elements.enrollStep1.classList.remove('hidden');
  elements.enrollStep2.classList.add('hidden');
  elements.enrollStep3.classList.add('hidden');
  elements.enrollForm.reset();
  elements.enrollModal.classList.add('active');
}

function closeEnrollModal() {
  elements.enrollModal.classList.remove('active');
  state.currentEnrollment = null;
}

elements.openEnrollModalBtn.addEventListener('click', openEnrollModal);
elements.closeEnrollModalBtn.addEventListener('click', closeEnrollModal);
elements.cancelEnrollBtn.addEventListener('click', closeEnrollModal);
elements.finishEnrollBtn.addEventListener('click', closeEnrollModal);

// Submit Enrollment
elements.enrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const idVal = elements.enrollUserId.value.trim();
  const nameVal = elements.enrollUserName.value.trim();

  if (!nameVal) return;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: idVal ? Number(idVal) : undefined,
        name: nameVal
      })
    });

    const data = await res.json();

    if (data.success) {
      state.currentEnrollment = data.user;
      elements.enrollStep1.classList.add('hidden');
      elements.enrollStep2.classList.remove('hidden');
      elements.captureCurrentNum.textContent = '0';
      elements.captureTotalNum.textContent = '10';
      elements.captureProgressBar.style.width = '0%';
      elements.guidanceText.textContent = GUIDANCE_STEPS[0];

      // Reset step ticks
      const ticks = elements.stepTicksContainer.querySelectorAll('.tick');
      ticks.forEach(t => t.classList.remove('active'));

      showToast(`Initiated face enrollment for ${nameVal}. Please face the camera.`, 'info');
    } else {
      showToast(data.error, 'error');
    }
  } catch (err) {
    showToast('Failed to start enrollment', 'error');
  }
});

// Update UI during 10-step capture
function updateRegistrationProgressUI(data) {
  const current = data.embedding || 0;
  const total = data.total || 10;

  elements.captureCurrentNum.textContent = current;
  elements.captureTotalNum.textContent = total;

  const pct = Math.round((current / total) * 100);
  elements.captureProgressBar.style.width = `${pct}%`;

  // Update ticks
  const ticks = elements.stepTicksContainer.querySelectorAll('.tick');
  ticks.forEach((t, idx) => {
    if (idx < current) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  // Update guidance
  const guideIdx = Math.min(current, GUIDANCE_STEPS.length - 1);
  elements.guidanceText.textContent = GUIDANCE_STEPS[guideIdx];
}

// Complete registration
function completeRegistrationUI(data) {
  elements.enrollStep2.classList.add('hidden');
  elements.enrollStep3.classList.remove('hidden');

  elements.summaryUserName.textContent = data.name;
  elements.summaryUserId.textContent = `#${data.id}`;
}

// Fail registration
function failRegistrationUI(data) {
  showToast(`Enrollment failed: ${data.reason}`, 'error');
  closeEnrollModal();
}

// ============================================================================
// Lightbox Modal
// ============================================================================

window.openLightbox = function (imagePath, similarity, timeStr) {
  elements.lightboxImg.src = imagePath;
  elements.lightboxSimilarity.textContent = similarity;
  elements.lightboxTime.textContent = timeStr;
  elements.imageLightboxModal.classList.add('active');
};

elements.closeLightboxBtn.addEventListener('click', () => {
  elements.imageLightboxModal.classList.remove('active');
});

// ============================================================================
// Interactive Hardware Simulator Triggers
// ============================================================================

elements.simAuthPassBtn.addEventListener('click', async () => {
  initAudio();
  try {
    await fetch('/api/simulator/trigger-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'authorized',
        id: 1,
        name: 'Ajeth',
        similarity: (0.85 + Math.random() * 0.12).toFixed(3)
      })
    });
    showToast('Simulated: Authorized face verified via physical GPIO 1', 'success');
  } catch (err) {
    showToast('Simulation trigger error', 'error');
  }
});

elements.simAuthFailBtn.addEventListener('click', async () => {
  initAudio();
  try {
    await fetch('/api/simulator/trigger-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'denied',
        similarity: (0.35 + Math.random() * 0.28).toFixed(3)
      })
    });
    showToast('Simulated: Access denied (< 0.70 threshold)', 'error');
  } catch (err) {
    showToast('Simulation trigger error', 'error');
  }
});

// Step simulator for enrollment
elements.simStepBtn.addEventListener('click', () => {
  const cur = Number(elements.captureCurrentNum.textContent) || 0;
  if (cur < 10) {
    const next = cur + 1;
    handleIncomingEvent({
      event: 'registration_progress',
      data: {
        id: state.currentEnrollment ? state.currentEnrollment.id : 1,
        name: state.currentEnrollment ? state.currentEnrollment.name : 'Ajeth',
        status: 'capturing',
        embedding: next,
        total: 10
      }
    });

    if (next === 10) {
      setTimeout(() => {
        handleIncomingEvent({
          event: 'registration_success',
          data: {
            id: state.currentEnrollment ? state.currentEnrollment.id : 1,
            name: state.currentEnrollment ? state.currentEnrollment.name : 'Ajeth',
            status: 'success',
            embeddings: 10
          }
        });
      }, 600);
    }
  }
});

elements.refreshUsersBtn.addEventListener('click', () => {
  fetchUsers();
  showToast('Profile list refreshed', 'info');
});

// Sound Toggle
elements.soundToggleBtn.addEventListener('click', () => {
  initAudio();
  state.soundEnabled = !state.soundEnabled;
  elements.soundIcon.className = state.soundEnabled ? 'fa-solid fa-volume-high' : 'fa-solid fa-volume-xmark';
  showToast(state.soundEnabled ? 'Sound cues enabled' : 'Sound cues muted', 'info');
});

// Helper: timestamp formatting
function formatTimestamp(isoStr) {
  if (!isoStr) return 'Just now';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Helper: HTML escaping
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// Initialization
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();
  fetchStats();
  fetchUsers();
  fetchAuthHistory();
  fetchIntruders();

  // Periodic heartbeat
  setInterval(fetchStats, 10000);
});
