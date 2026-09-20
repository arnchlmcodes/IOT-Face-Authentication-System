/**
 * ESP32-S3 Face Authentication Hub - Frontend Controller
 * WebSocket real-time client, REST API integration, audio cues, SD card log synchronization
 */

// Application State
const state = {
  ws: null,
  wsConnected: false,
  soundEnabled: true,
  currentEnrollment: null,
  currentLightboxEventId: null,
  pendingDeleteId: null,
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
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now); // C5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
      osc.start(now);
      osc.stop(now + 0.35);
    } else if (type === 'denied') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(140, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.25);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'capture') {
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
  doorStatusPill: document.getElementById('doorStatusPill'),
  doorStatusText: document.getElementById('doorStatusText'),
  doorLockIcon: document.getElementById('doorLockIcon'),
  manualUnlockBtn: document.getElementById('manualUnlockBtn'),
  openSyncModalBtn: document.getElementById('openSyncModalBtn'),
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
  refreshFeedBtn: document.getElementById('refreshFeedBtn'),
  clearAllLogsBtn: document.getElementById('clearAllLogsBtn'),
  usersTableBody: document.getElementById('usersTableBody'),
  intruderGrid: document.getElementById('intruderGrid'),
  intruderCountBadge: document.getElementById('intruderCountBadge'),
  refreshUsersBtn: document.getElementById('refreshUsersBtn'),

  // Enrollment Modal
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

  // Lightbox Modal
  imageLightboxModal: document.getElementById('imageLightboxModal'),
  closeLightboxBtn: document.getElementById('closeLightboxBtn'),
  lightboxImg: document.getElementById('lightboxImg'),
  lightboxTime: document.getElementById('lightboxTime'),
  lightboxSimilarity: document.getElementById('lightboxSimilarity'),
  lightboxDeleteBtn: document.getElementById('lightboxDeleteBtn'),

  // SD Sync Modal
  syncModal: document.getElementById('syncModal'),
  closeSyncModalBtn: document.getElementById('closeSyncModalBtn'),
  eventsDropzone: document.getElementById('eventsDropzone'),
  eventsFileInput: document.getElementById('eventsFileInput'),
  eventsDropText: document.getElementById('eventsDropText'),
  uploadEventsBtn: document.getElementById('uploadEventsBtn'),
  usersDropzone: document.getElementById('usersDropzone'),
  usersFileInput: document.getElementById('usersFileInput'),
  usersDropText: document.getElementById('usersDropText'),
  uploadUsersBtn: document.getElementById('uploadUsersBtn'),
  syncResultsBox: document.getElementById('syncResultsBox'),
  syncResultsTitle: document.getElementById('syncResultsTitle'),
  syncStatsGrid: document.getElementById('syncStatsGrid'),

  // Delete Confirm Modal
  deleteConfirmModal: document.getElementById('deleteConfirmModal'),
  closeDeleteModalBtn: document.getElementById('closeDeleteModalBtn'),
  cancelDeleteBtn: document.getElementById('cancelDeleteBtn'),
  confirmDeleteActionBtn: document.getElementById('confirmDeleteActionBtn'),
  deleteConfirmTitle: document.getElementById('deleteConfirmTitle'),
  deleteConfirmText: document.getElementById('deleteConfirmText'),
  confirmDeleteBtnText: document.getElementById('confirmDeleteBtnText'),

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

    case 'door_lock':
      updateDoorUI(data.status, data.source);
      break;

    case 'authentication_authorized':
      renderAuthFeedItem({
        id: data.eventId,
        status: 'authorized',
        user_name: data.name,
        user_id: data.id,
        similarity: data.similarity,
        first_similarity: data.first_similarity,
        second_similarity: data.second_similarity,
        threshold: data.threshold || 0.65,
        embedding_delta: data.embedding_delta,
        source: data.source || 'face',
        created_at: data.timestamp
      }, true);
      playSound('authorized');
      fetchStats();
      break;

    case 'authentication_denied':
      renderAuthFeedItem({
        id: data.eventId,
        status: 'denied',
        user_name: data.candidate_name ? `Unrecognized (Candidate: ${data.candidate_name})` : 'Unrecognized Person',
        user_id: data.candidate_id || -1,
        similarity: data.similarity,
        first_similarity: data.first_similarity,
        second_similarity: data.second_similarity,
        threshold: data.threshold || 0.65,
        embedding_delta: data.embedding_delta,
        reason: data.reason,
        source: data.source || 'face',
        created_at: data.timestamp
      }, true);
      playSound('denied');
      fetchStats();
      break;

    case 'intruder_image':
      attachIntruderImageToLatestFeed(data.imagePath, data.eventId);
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

    case 'log_deleted':
      removeFeedItemFromDOM(data.id);
      fetchIntruders();
      fetchStats();
      break;

    case 'logs_cleared':
      elements.authFeedList.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-id-badge"></i>
          <p>No verification events recorded yet.</p>
        </div>
      `;
      fetchIntruders();
      fetchStats();
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

function updateDoorUI(status, source) {
  if (!elements.doorStatusPill) return;
  if (status === 'unlocked') {
    elements.doorStatusText.textContent = `Door: Unlocked (${source || 'relay'})`;
    elements.doorLockIcon.className = 'fa-solid fa-lock-open';
    elements.doorStatusPill.style.borderColor = 'var(--color-green)';
    elements.doorStatusPill.style.color = 'var(--color-green)';
  } else {
    elements.doorStatusText.textContent = 'Door: Locked';
    elements.doorLockIcon.className = 'fa-solid fa-lock';
    elements.doorStatusPill.style.borderColor = 'var(--border-subtle)';
    elements.doorStatusPill.style.color = 'var(--text-secondary)';
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

// ============================================================================
// Custom In-App Deletion Modal Handling (Reliable & Never Blocked)
// ============================================================================

function openDeleteConfirm(id, title, message) {
  state.pendingDeleteId = id;
  if (title && elements.deleteConfirmTitle) elements.deleteConfirmTitle.textContent = title;
  if (message && elements.deleteConfirmText) elements.deleteConfirmText.textContent = message;
  if (elements.confirmDeleteBtnText) {
    elements.confirmDeleteBtnText.textContent = id === 'all' ? 'Clear All' : 'Delete';
  }
  if (elements.deleteConfirmModal) elements.deleteConfirmModal.classList.add('active');
}

function closeDeleteConfirm() {
  if (elements.deleteConfirmModal) elements.deleteConfirmModal.classList.remove('active');
  state.pendingDeleteId = null;
}

if (elements.closeDeleteModalBtn) elements.closeDeleteModalBtn.addEventListener('click', closeDeleteConfirm);
if (elements.cancelDeleteBtn) elements.cancelDeleteBtn.addEventListener('click', closeDeleteConfirm);

if (elements.confirmDeleteActionBtn) {
  elements.confirmDeleteActionBtn.addEventListener('click', async () => {
    const id = state.pendingDeleteId;
    if (!id) return;

    elements.confirmDeleteActionBtn.disabled = true;
    elements.confirmDeleteActionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Deleting...';

    try {
      const url = id === 'all' ? '/api/smart-lock/logs' : `/api/smart-lock/logs/${id}`;
      const res = await fetch(url, { method: 'DELETE' });
      const data = await res.json();

      if (data.ok || data.success) {
        if (id === 'all') {
          showToast('All logs and stored images cleared', 'success');
          elements.authFeedList.innerHTML = `
            <div class="empty-state">
              <i class="fa-solid fa-id-badge"></i>
              <p>No verification events recorded yet.</p>
            </div>
          `;
        } else {
          showToast(`Log #${id} and associated image deleted`, 'success');
          removeFeedItemFromDOM(id);
        }

        if (state.currentLightboxEventId === id || id === 'all') {
          elements.imageLightboxModal.classList.remove('active');
          state.currentLightboxEventId = null;
        }

        closeDeleteConfirm();
        syncWithEndpoints(false);
      } else {
        showToast(data.error || 'Failed to delete log', 'error');
      }
    } catch (err) {
      showToast('Network error during deletion: ' + err.message, 'error');
    } finally {
      elements.confirmDeleteActionBtn.disabled = false;
      elements.confirmDeleteActionBtn.innerHTML = '<i class="fa-solid fa-trash-can"></i> <span id="confirmDeleteBtnText">Delete</span>';
    }
  });
}

// Global hook for deleting individual logs
window.deleteLog = function (id, event) {
  if (event) {
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }
  openDeleteConfirm(
    id,
    `Delete Log Record #${id}`,
    `Are you sure you want to permanently delete log record #${id} and remove its stored image from disk?`
  );
};

// Clear all logs button handler
if (elements.clearAllLogsBtn) {
  elements.clearAllLogsBtn.addEventListener('click', () => {
    openDeleteConfirm(
      'all',
      'Clear All Access Logs',
      'Are you sure you want to permanently delete ALL verification logs and stored intruder images from the system?'
    );
  });
}

function removeFeedItemFromDOM(id) {
  const item = elements.authFeedList.querySelector(`[data-event-id="${id}"]`);
  if (item) {
    item.style.opacity = '0';
    item.style.transform = 'scale(0.95)';
    setTimeout(() => item.remove(), 250);
  }
}

// ============================================================================
// Endpoint Synchronization on Manual Refresh & Page Load
// ============================================================================

async function syncWithEndpoints(showNotice = false) {
  try {
    // 1. Fetch latest processed logs & statistics directly from GET /api/smart-lock/logs
    const logsRes = await fetch('/api/smart-lock/logs');
    const logsData = await logsRes.json();

    if (logsData.ok && Array.isArray(logsData.latest)) {
      renderAuthFeedList(logsData.latest);
      if (logsData.summary) {
        updateStatsFromSummary(logsData.summary, logsData.total_records, logsData.registered_users);
      }
    } else {
      await fetchAuthHistory();
    }

    // 2. Fetch latest registered users from GET /api/smart-lock/users
    const usersRes = await fetch('/api/smart-lock/users');
    const usersData = await usersRes.json();
    if (usersData.ok && Array.isArray(usersData.users)) {
      renderUsersTable(usersData.users);
      if (elements.kpiRegisteredUsers) {
        elements.kpiRegisteredUsers.textContent = usersData.users.length;
      }
    } else {
      await fetchUsers();
    }

    // 3. Fetch intruders and stats
    await fetchIntruders();
    await fetchStats();

    if (showNotice) {
      showToast('Synchronized with smart lock endpoints', 'success');
    }
  } catch (err) {
    console.warn('Endpoint sync fallback:', err);
    await fetchAuthHistory();
    await fetchUsers();
    await fetchStats();
    await fetchIntruders();
  }
}

function updateStatsFromSummary(summary, total, users) {
  if (elements.kpiTotalEvents) elements.kpiTotalEvents.textContent = total || 0;
  if (elements.kpiIntruders) elements.kpiIntruders.textContent = summary.authentication_denied || 0;
  if (elements.kpiRegisteredUsers && Array.isArray(users)) {
    elements.kpiRegisteredUsers.textContent = users.length;
  }
  const passRate = total > 0 ? Math.round(((summary.authentication_authorized || 0) / total) * 100) : 100;
  if (elements.kpiPassRate) elements.kpiPassRate.textContent = `${passRate}%`;
  if (elements.kpiPassRateDetail) {
    elements.kpiPassRateDetail.textContent = `${summary.authentication_authorized || 0} of ${total} authorized`;
  }
}

if (elements.refreshFeedBtn) {
  elements.refreshFeedBtn.addEventListener('click', () => {
    syncWithEndpoints(true);
  });
}

// Fetch and render live authentication feed
async function fetchAuthHistory() {
  try {
    const res = await fetch('/api/auth/history?limit=30');
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
        <p>No verification events recorded yet. Press physical button on ESP32 or sync SD logs to populate.</p>
      </div>
    `;
    return;
  }

  elements.authFeedList.innerHTML = '';
  events.forEach(evt => renderAuthFeedItem(evt, false));
}

function renderAuthFeedItem(evt, prepend = false) {
  const isAuth = evt.status === 'authorized';
  const isLock = evt.event_type === 'lock' || evt.status === 'unlocked' || evt.status === 'locked';
  const item = document.createElement('div');
  item.className = `auth-feed-item ${isLock ? 'lock' : (isAuth ? 'authorized' : 'denied')}`;
  if (evt.id) {
    item.setAttribute('data-event-id', evt.id);
  }

  const formattedTime = formatTimestamp(evt.created_at || evt.timestamp);
  const similarityScore = evt.similarity !== null && evt.similarity !== undefined
    ? Number(evt.similarity).toFixed(3)
    : (isAuth ? '0.750' : (isLock ? '-' : '0.412'));

  const similarityClass = isAuth ? 'high' : (isLock ? 'neutral' : 'low');

  let metaText = '';
  if (isLock) {
    metaText = `Door ${evt.status} (${evt.source || 'system'}) • ${formattedTime}`;
  } else if (isAuth) {
    metaText = `User ID #${evt.user_id || 1} • Match: 65% • ${formattedTime}`;
  } else {
    metaText = `Threshold: 0.65 • ${evt.reason ? escapeHtml(evt.reason) : 'Unrecognized Face'} • ${formattedTime}`;
  }

  let extraSimDetails = '';
  if (evt.first_similarity !== null && evt.first_similarity !== undefined && evt.second_similarity !== null && evt.second_similarity !== undefined) {
    extraSimDetails = `<span class="sim-sub-detail">F1: ${Number(evt.first_similarity).toFixed(3)} | F2: ${Number(evt.second_similarity).toFixed(3)}</span>`;
  }

  item.innerHTML = `
    <div class="feed-item-left">
      <div class="feed-avatar ${isLock ? 'lock' : (isAuth ? 'auth' : 'denied')}">
        <i class="fa-solid ${isLock ? (evt.status === 'unlocked' ? 'fa-lock-open' : 'fa-lock') : (isAuth ? 'fa-user-check' : 'fa-user-xmark')}"></i>
      </div>
      <div class="feed-user-details">
        <span class="feed-user-name">${escapeHtml(evt.name || evt.user_name || (isAuth ? 'Authorized User' : 'Unrecognized Person'))}</span>
        <span class="feed-user-meta">${metaText}</span>
        ${extraSimDetails}
      </div>
    </div>
    <div class="feed-item-right">
      ${!isLock ? `
        <span class="similarity-pill ${similarityClass}">
          <i class="fa-solid fa-chart-simple"></i> ${similarityScore}
        </span>
      ` : ''}
      ${evt.image_path ? `
        <button class="feed-thumbnail-btn" onclick="window.openLightbox('${evt.image_path}', '${similarityScore}', '${formattedTime}', ${evt.id || 'null'})" title="View snapshot">
          <img src="${evt.image_path}" class="feed-thumb-img" alt="Intruder Snapshot">
        </button>
      ` : ''}
      ${evt.id ? `
        <button class="btn-delete-log-item" onclick="window.deleteLog(${evt.id}, event)" title="Delete log entry & image">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      ` : ''}
    </div>
  `;

  if (prepend && elements.authFeedList.firstChild) {
    const emptyState = elements.authFeedList.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    elements.authFeedList.insertBefore(item, elements.authFeedList.firstChild);
  } else {
    elements.authFeedList.appendChild(item);
  }
}

function attachIntruderImageToLatestFeed(imagePath, eventId = null) {
  const latestDenied = elements.authFeedList.querySelector('.auth-feed-item.denied');
  if (latestDenied) {
    const rightCol = latestDenied.querySelector('.feed-item-right');
    if (rightCol && !rightCol.querySelector('.feed-thumb-img')) {
      const btn = document.createElement('button');
      btn.className = 'feed-thumbnail-btn';
      btn.onclick = () => window.openLightbox(imagePath, '0.420', 'Just now', eventId);
      btn.innerHTML = `<img src="${imagePath}" class="feed-thumb-img" alt="Intruder Snapshot">`;
      rightCol.insertBefore(btn, rightCol.firstChild);
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
    <div class="intruder-card" onclick="window.openLightbox('${item.image_path}', '${Number(item.similarity || 0.42).toFixed(3)}', '${formatTimestamp(item.created_at)}', ${item.id})">
      <img src="${item.image_path}" alt="Intruder Capture" loading="lazy">
      <button class="intruder-trash-btn" onclick="window.deleteLog(${item.id}, event)" title="Delete snapshot & log">
        <i class="fa-solid fa-trash-can"></i>
      </button>
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
  card.onclick = () => window.openLightbox(data.imagePath, Number(data.similarity || 0.42).toFixed(3), 'Just now', data.eventId);
  card.innerHTML = `
    <img src="${data.imagePath}" alt="Intruder Capture">
    ${data.eventId ? `
      <button class="intruder-trash-btn" onclick="window.deleteLog(${data.eventId}, event)" title="Delete snapshot & log">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    ` : ''}
    <div class="intruder-overlay">
      <span class="intruder-score"><i class="fa-solid fa-triangle-exclamation"></i> ${Number(data.similarity || 0.42).toFixed(3)}</span>
      <span class="intruder-time">Just now</span>
    </div>
  `;

  elements.intruderGrid.insertBefore(card, elements.intruderGrid.firstChild);
  const currentCount = Number(elements.intruderCountBadge.textContent) || 0;
  elements.intruderCountBadge.textContent = currentCount + 1;
}

// Fetch KPI metrics
async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.success) {
      const { registeredUsers, totalEvents, authorizedCount, deniedCount, passRate } = data.stats;
      elements.kpiRegisteredUsers.textContent = registeredUsers;
      elements.kpiPassRate.textContent = `${passRate}%`;
      elements.kpiPassRateDetail.textContent = `${authorizedCount} of ${totalEvents} authorized`;
      elements.kpiTotalEvents.textContent = totalEvents;
      elements.kpiIntruders.textContent = deniedCount;
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

// ============================================================================
// Enrollment Modal Lifecycle
// ============================================================================

function openEnrollModal() {
  elements.enrollModal.classList.add('active');
  elements.enrollStep1.classList.remove('hidden');
  elements.enrollStep2.classList.add('hidden');
  elements.enrollStep3.classList.add('hidden');
  elements.enrollForm.reset();
  state.currentEnrollment = null;
}

function closeEnrollModal() {
  elements.enrollModal.classList.remove('active');
  state.currentEnrollment = null;
}

elements.openEnrollModalBtn.addEventListener('click', openEnrollModal);
elements.closeEnrollModalBtn.addEventListener('click', closeEnrollModal);
elements.cancelEnrollBtn.addEventListener('click', closeEnrollModal);
elements.finishEnrollBtn.addEventListener('click', () => {
  closeEnrollModal();
  fetchUsers();
});

// Submit Enrollment
elements.enrollForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  initAudio();

  const name = elements.enrollUserName.value.trim();
  const idVal = elements.enrollUserId.value;
  const id = idVal ? Number(idVal) : null;

  if (!name) return;

  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name })
    });

    const data = await res.json();
    if (!data.success) {
      showToast(data.error, 'error');
      return;
    }

    state.currentEnrollment = { id: data.user.id, name: data.user.name };

    elements.enrollStep1.classList.add('hidden');
    elements.enrollStep2.classList.remove('hidden');
    elements.captureCurrentNum.textContent = '0';
    elements.captureProgressBar.style.width = '0%';
    elements.guidanceText.textContent = GUIDANCE_STEPS[0];

    elements.stepTicksContainer.querySelectorAll('.tick').forEach(t => t.classList.remove('active'));

    showToast(`Enrollment initiated for ${name}. Position face in front of ESP32...`, 'info');
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

  const ticks = elements.stepTicksContainer.querySelectorAll('.tick');
  ticks.forEach((t, idx) => {
    if (idx < current) {
      t.classList.add('active');
    } else {
      t.classList.remove('active');
    }
  });

  const guideIdx = Math.min(current, GUIDANCE_STEPS.length - 1);
  elements.guidanceText.textContent = GUIDANCE_STEPS[guideIdx];
}

function completeRegistrationUI(data) {
  elements.enrollStep2.classList.add('hidden');
  elements.enrollStep3.classList.remove('hidden');

  elements.summaryUserName.textContent = data.name;
  elements.summaryUserId.textContent = `#${data.id}`;
}

function failRegistrationUI(data) {
  showToast(`Enrollment failed: ${data.reason}`, 'error');
  closeEnrollModal();
}

// ============================================================================
// Lightbox Modal & Delete from Lightbox
// ============================================================================

window.openLightbox = function (imagePath, similarity, timeStr, eventId = null) {
  state.currentLightboxEventId = eventId;
  elements.lightboxImg.src = imagePath;
  elements.lightboxSimilarity.textContent = similarity;
  elements.lightboxTime.textContent = timeStr;
  elements.imageLightboxModal.classList.add('active');
};

elements.closeLightboxBtn.addEventListener('click', () => {
  elements.imageLightboxModal.classList.remove('active');
  state.currentLightboxEventId = null;
});

if (elements.lightboxDeleteBtn) {
  elements.lightboxDeleteBtn.addEventListener('click', () => {
    if (state.currentLightboxEventId) {
      window.deleteLog(state.currentLightboxEventId);
    } else {
      showToast('No record ID attached to this snapshot', 'error');
    }
  });
}

// ============================================================================
// Manual Unlock Trigger (per api.md Section 3)
// ============================================================================

if (elements.manualUnlockBtn) {
  elements.manualUnlockBtn.addEventListener('click', async () => {
    initAudio();
    if (elements.doorStatusText) elements.doorStatusText.textContent = 'Door: Unlocking...';

    try {
      const res = await fetch('/api/smart-lock/unlock', { method: 'POST' });
      const data = await res.json();
      if (data.ok || data.success) {
        showToast('Manual unlock command sent to ESP32 (10s auto-relock)', 'success');
        playSound('authorized');
      } else {
        showToast(data.error || 'Manual unlock failed', 'error');
      }
    } catch (err) {
      showToast('Failed to trigger door unlock', 'error');
    }
  });
}

// ============================================================================
// SD Card Log & Profile Synchronization Modal
// ============================================================================

if (elements.openSyncModalBtn) {
  elements.openSyncModalBtn.addEventListener('click', () => {
    elements.syncModal.classList.add('active');
  });
}

if (elements.closeSyncModalBtn) {
  elements.closeSyncModalBtn.addEventListener('click', () => {
    elements.syncModal.classList.remove('active');
  });
}

if (elements.eventsDropzone && elements.eventsFileInput) {
  elements.eventsDropzone.addEventListener('click', () => elements.eventsFileInput.click());

  elements.eventsFileInput.addEventListener('change', () => {
    const file = elements.eventsFileInput.files[0];
    if (file) {
      elements.eventsDropText.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      elements.uploadEventsBtn.disabled = false;
    }
  });

  elements.eventsDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.eventsDropzone.classList.add('dragover');
  });

  elements.eventsDropzone.addEventListener('dragleave', () => {
    elements.eventsDropzone.classList.remove('dragover');
  });

  elements.eventsDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.eventsDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      elements.eventsFileInput.files = e.dataTransfer.files;
      const file = e.dataTransfer.files[0];
      elements.eventsDropText.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      elements.uploadEventsBtn.disabled = false;
    }
  });
}

if (elements.usersDropzone && elements.usersFileInput) {
  elements.usersDropzone.addEventListener('click', () => elements.usersFileInput.click());

  elements.usersFileInput.addEventListener('change', () => {
    const file = elements.usersFileInput.files[0];
    if (file) {
      elements.usersDropText.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      elements.uploadUsersBtn.disabled = false;
    }
  });

  elements.usersDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.usersDropzone.classList.add('dragover');
  });

  elements.usersDropzone.addEventListener('dragleave', () => {
    elements.usersDropzone.classList.remove('dragover');
  });

  elements.usersDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.usersDropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      elements.usersFileInput.files = e.dataTransfer.files;
      const file = e.dataTransfer.files[0];
      elements.usersDropText.textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      elements.uploadUsersBtn.disabled = false;
    }
  });
}

if (elements.uploadEventsBtn) {
  elements.uploadEventsBtn.addEventListener('click', async () => {
    const file = elements.eventsFileInput.files[0];
    if (!file) {
      showToast('Please select events.jsonl first', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    elements.uploadEventsBtn.disabled = true;
    elements.uploadEventsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Ingesting Log...';

    try {
      const res = await fetch('/api/smart-lock/logs', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!data.ok) {
        showToast(data.error || 'Failed to process events log', 'error');
        return;
      }

      showToast(`Processed ${data.total_records} events from ${data.filename}`, 'success');
      displaySyncResults(data);
      syncWithEndpoints(false);
    } catch (err) {
      showToast(`Upload error: ${err.message}`, 'error');
    } finally {
      elements.uploadEventsBtn.disabled = false;
      elements.uploadEventsBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload & Process Log';
    }
  });
}

if (elements.uploadUsersBtn) {
  elements.uploadUsersBtn.addEventListener('click', async () => {
    const file = elements.usersFileInput.files[0];
    if (!file) {
      showToast('Please select registered_users.json first', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('file', file);

    elements.uploadUsersBtn.disabled = true;
    elements.uploadUsersBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Syncing Profiles...';

    try {
      const res = await fetch('/api/smart-lock/users', {
        method: 'POST',
        body: formData
      });

      const data = await res.json();
      if (!data.ok) {
        showToast(data.error || 'Failed to sync users file', 'error');
        return;
      }

      showToast(`Synchronized ${data.user_count} profile(s) from ${data.filename}`, 'success');
      syncWithEndpoints(false);
    } catch (err) {
      showToast(`Upload error: ${err.message}`, 'error');
    } finally {
      elements.uploadUsersBtn.disabled = false;
      elements.uploadUsersBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Upload & Sync Profiles';
    }
  });
}

function displaySyncResults(data) {
  elements.syncResultsBox.classList.remove('hidden');
  const sum = data.summary || {};

  elements.syncStatsGrid.innerHTML = `
    <div class="sync-stat-pill">
      <span class="stat-label">Total Records</span>
      <span class="stat-val">${data.total_records}</span>
    </div>
    <div class="sync-stat-pill">
      <span class="stat-label">Authorized</span>
      <span class="stat-val text-green">${sum.authentication_authorized || 0}</span>
    </div>
    <div class="sync-stat-pill">
      <span class="stat-label">Denied</span>
      <span class="stat-val text-red">${sum.authentication_denied || 0}</span>
    </div>
    <div class="sync-stat-pill">
      <span class="stat-label">No Face Detected</span>
      <span class="stat-val text-amber">${sum.authentication_no_face || 0}</span>
    </div>
    <div class="sync-stat-pill">
      <span class="stat-label">Lock Cycles</span>
      <span class="stat-val">${(sum.lock_unlocked || 0) + (sum.lock_locked || 0)}</span>
    </div>
    <div class="sync-stat-pill">
      <span class="stat-label">Average Score</span>
      <span class="stat-val">${sum.average_auth_score !== null ? sum.average_auth_score : 'N/A'}</span>
    </div>
  `;
}

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

function formatTimestamp(isoStr) {
  if (!isoStr) return 'Just now';
  const d = new Date(isoStr);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

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
// Initialization: Runs on Every Page Load / Manual Refresh
// ============================================================================
window.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();

  // Automatically retrieve files from endpoints & synchronize logs and profiles
  syncWithEndpoints(true);

  // Periodic heartbeat sync
  setInterval(() => syncWithEndpoints(false), 15000);
});
