// AG-Remote PWA Client Application
(function () {
  'use strict';

  // DOM Elements
  const statusBadge = document.getElementById('statusBadge');
  const statusText = document.getElementById('statusText');
  const sessionLabel = document.getElementById('sessionLabel');
  const chatFeed = document.getElementById('chatFeed');
  const emptyState = document.getElementById('emptyState');
  const approvalCard = document.getElementById('approvalCard');
  const approvalBadge = document.getElementById('approvalBadge');
  const approvalKind = document.getElementById('approvalKind');
  const approvalDesc = document.getElementById('approvalDesc');
  const approvalDetail = document.getElementById('approvalDetail');
  const approvalOptions = document.getElementById('approvalOptions');
  const approvalActions = document.getElementById('approvalActions');
  const approvalCwd = document.getElementById('approvalCwd');
  const approvalIdeOnly = document.getElementById('approvalIdeOnly');
  const approvalDenyNote = document.getElementById('approvalDenyNote');
  const btnApprove = document.getElementById('btnApprove');
  const btnDeny = document.getElementById('btnDeny');
  const btnStop = document.getElementById('btnStop');
  const promptForm = document.getElementById('promptForm');
  const promptInput = document.getElementById('promptInput');
  const btnSend = document.getElementById('btnSend');
  const lastActiveLine = document.getElementById('lastActive');
  const btnAttach = document.getElementById('btnAttach');
  const attachInput = document.getElementById('attachInput');
  const attachTray = document.getElementById('attachTray');
  const toastBanner = document.getElementById('toastBanner');
  const toastMessage = document.getElementById('toastMessage');
  const toastClose = document.getElementById('toastClose');
  const pairingModal = document.getElementById('pairingModal');
  const tokenInput = document.getElementById('tokenInput');
  const btnSaveToken = document.getElementById('btnSaveToken');

  // State
  let token = localStorage.getItem('ag_remote_token') || '';
  let ws = null;
  let currentApproval = null;
  let isReconnecting = false;
  let reconnectAttempts = 0;

  // Relay mode: opened from a relay QR (/p/<room>#<secret>), or a phone that paired that way before.
  // Everything else (local Wi-Fi, Tailscale) talks to the PC's own server with the session token.
  const RELAY_ROOM_KEY = 'ag_remote_relay_room';
  let relayRoom = (() => {
    const m = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]{22})\/?$/);
    if (m) return m[1];
    if (window.location.protocol !== 'https:') return null;
    try { return localStorage.getItem(RELAY_ROOM_KEY); } catch (_) { return null; }
  })();
  let relayMode = !!relayRoom;
  const isRelayHost = window.location.protocol === 'https:' &&
    !window.location.hostname.endsWith('.ts.net') &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1';
  let relay = null; // RelayLink (relay-link.js) in relay mode

  /** Paired with a PC (it may still be unreachable right now). */
  function linked() {
    return relayMode ? !!relay : !!token;
  }

  /** One API call over whichever transport this page uses. Resolves { ok, status, data }. */
  async function api(method, path, body, timeoutMs) {
    if (relayMode) {
      if (!relay) throw new Error('not-connected');
      return relay.request(method, path, body, timeoutMs);
    }
    const headers = { 'Authorization': `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // 1. Token Initialization & Pairing Exchange
  async function initAuth() {
    if (relayMode) {
      startRelay();
      return;
    }
    if (isRelayHost) {
      showRelayPairing();
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const pairingCode = params.get('t');
    const directToken = params.get('token');

    if (pairingCode) {
      try {
        const res = await fetch(`/pair?t=${encodeURIComponent(pairingCode)}`, {
          headers: { 'Accept': 'application/json' }
        });
        const data = await res.json();
        if (data.token) {
          token = data.token;
          localStorage.setItem('ag_remote_token', token);
          // Clean URL parameter without reloading
          window.history.replaceState({}, document.title, '/');
        } else {
          showToast(data.error || 'Failed to exchange pairing code.');
        }
      } catch (err) {
        showToast('Network error during pairing code exchange.');
      }
    } else if (directToken) {
      token = directToken;
      localStorage.setItem('ag_remote_token', token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    if (!token) {
      pairingModal.classList.remove('hidden');
    } else {
      pairingModal.classList.add('hidden');
      startApp();
    }
  }

  // 2. Application Startup & State Resync
  async function startApp() {
    await resyncState();
    connectWebSocket();
  }

  const pairHint = document.getElementById('pairHint');
  const pinLabel = document.getElementById('pinLabel');
  const RELAY_PAIR_ERRORS = {
    'bad-secret': 'This QR code was already used or replaced by a newer one. Show a new QR code on your PC and scan it.',
    'no-pairing': 'This QR code was already used or replaced by a newer one. Show a new QR code on your PC and scan it.',
    'expired': 'This QR code has expired (they last 5 minutes). Show a new one on your PC and scan it.',
    'timeout': 'Your PC did not answer. Check that Antigravity is open, then scan a new QR code.',
    'denied': 'Your PC did not allow this phone. If it is yours, show a new QR code on your PC and try again.',
    'approval-timeout': 'Nobody clicked Allow on your PC within 2 minutes. Show a new QR code and try again.'
  };

  async function startRelay() {
    try { localStorage.setItem(RELAY_ROOM_KEY, relayRoom); } catch (_) {}
    const secret = window.location.hash.length > 1 ? window.location.hash.slice(1) : null;
    // Keep the one-time secret out of history and bookmarks.
    window.history.replaceState(null, document.title, `/p/${relayRoom}`);
    updateStatus('disconnected', 'Connecting...');
    const { RelayLink } = await import('/relay-link.js');
    relay = new RelayLink({
      room: relayRoom,
      secret,
      onEvent: handleAdapterEvent,
      onState: handleRelayState,
      onPairError: (code) => showRelayPairing(RELAY_PAIR_ERRORS[code] || 'Pairing failed. Show a new QR code on your PC and scan it.')
    });
    relay.start();
  }

  // After the first connection, a drop keeps the last screen and says "Reconnecting".
  let relayWasReady = false;

  function handleRelayState(state) {
    if (state === 'ready') {
      relayWasReady = true;
      pairingModal.classList.add('hidden');
      resyncState();
      pushOnReady();
      return;
    }
    if (state === 'unpaired') {
      updateStatus('disconnected', 'Not paired');
      showRelayPairing();
      dropPushSubscription();
      return;
    }
    if (state === 'approving') showApprovalWait(relay ? relay.checkCode : '');
    const labels = {
      'connecting': relayWasReady ? 'Reconnecting...' : 'Connecting...',
      'pairing': 'Pairing...',
      'approving': 'Allow on your PC',
      'waiting-host': 'PC offline',
      'offline': 'Offline',
      'room-full': 'Too many phones'
    };
    updateStatus('disconnected', labels[state] || 'Offline');
    if (state === 'waiting-host') sessionLabel.textContent = 'Open Antigravity on your PC';
    if (state === 'room-full') showToast('Your PC already has 4 phones connected. Close AG-Remote on another phone and reload.');
  }

  /** Relay pairing happens only by scanning a QR code, so the dialog explains that instead of asking for a PIN. */
  function showRelayPairing(error) {
    // A Home Screen app can't be opened by scanning (the camera opens the browser), and on iPhone it
    // may not share the browser's storage. There, pasting the QR's link or typing the code pairs instead.
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    pairHint.textContent = standalone
      ? 'Enter the 6-character code from your PC, or paste the link from the QR code.'
      : 'Scan the QR code from AG-Remote on your PC, or enter the 6-character pairing code.';
    pinLabel.classList.add('hidden');
    tokenInput.classList.remove('hidden');
    btnSaveToken.classList.remove('hidden');
    tokenInput.removeAttribute('maxlength');
    tokenInput.setAttribute('inputmode', 'text');
    tokenInput.placeholder = 'Pairing code or link';
    btnCancelPair.classList.toggle('hidden', !(relay && relay.isReady()));
    if (error) showPairError(error);
    else pairError.classList.add('hidden');
    pairingModal.classList.remove('hidden');
  }

  /** The code was right; the PC now asks its owner. Same code on both screens means it's this phone. */
  function showApprovalWait(code) {
    pairHint.textContent = code
      ? `On your PC, click Allow. Your PC should show the same code: ${code}`
      : 'On your PC, click Allow.';
    pinLabel.classList.add('hidden');
    tokenInput.classList.add('hidden');
    btnSaveToken.classList.add('hidden');
    btnCancelPair.classList.add('hidden');
    pairError.classList.add('hidden');
    pairingModal.classList.remove('hidden');
  }

  // Notifications (relay only: phones allow them on HTTPS pages only). The PC sends a push when the
  // agent needs an approval or finishes, unless this page is on screen. See src/relay-host/web-push.ts.
  const btnNotify = document.getElementById('btnNotify');
  const isIos = /iPhone|iPad/.test(navigator.userAgent || '');
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function currentPushSubscription() {
    if (!pushSupported) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  function setBell(on) {
    btnNotify.setAttribute('aria-pressed', on ? 'true' : 'false');
    btnNotify.setAttribute('aria-label', on ? 'Notifications are on' : 'Turn on notifications');
  }

  let visibilityHeartbeatTimer = null;

  function reportVisibility() {
    const isVis = document.visibilityState === 'visible';
    if (relayMode && relay) {
      relay.reportVisible(isVis);
    }
    if (relay && relay.isReady()) {
      api('POST', '/api/push/visible', { visible: isVis }).catch(() => {});
    }
  }

  function startVisibilityHeartbeat() {
    stopVisibilityHeartbeat();
    if (document.visibilityState === 'visible') {
      reportVisibility();
      visibilityHeartbeatTimer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          reportVisibility();
        } else {
          stopVisibilityHeartbeat();
        }
      }, 8000);
    }
  }

  function stopVisibilityHeartbeat() {
    if (visibilityHeartbeatTimer) {
      clearInterval(visibilityHeartbeatTimer);
      visibilityHeartbeatTimer = null;
    }
  }

  /** Each connect: tell the PC whether we're on screen, and re-send our subscription in case it lost it. */
  async function pushOnReady() {
    startVisibilityHeartbeat();
    try {
      const sub = Notification.permission === 'granted' ? await currentPushSubscription() : null;
      setBell(!!sub);
      if (sub) await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    } catch (_) {}
  }

  async function dropPushSubscription() {
    try {
      const sub = await currentPushSubscription();
      if (sub) await sub.unsubscribe();
    } catch (_) {}
    if (btnNotify) setBell(false);
  }

  async function enableNotifications() {
    if (!relay || !relay.isReady()) {
      showToast('Connect to your PC first, then turn on notifications.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showToast(permission === 'denied'
        ? "Notifications are blocked for this site. Allow them in your browser's site settings, then try again."
        : 'Notifications were not turned on.');
      return;
    }
    try {
      const keyRes = await api('GET', '/api/push/key');
      if (!keyRes.ok) throw new Error(keyRes.data?.error || 'no key');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      // A subscription made for another PC's key can't be reused.
      if (sub) await sub.unsubscribe();
      const raw = atob(keyRes.data.key.replace(/-/g, '+').replace(/_/g, '/'));
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0))
      });
      const res = await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      if (!res.ok) throw new Error(res.data?.error || 'subscribe failed');
      setBell(true);
      showToast("Notifications are on. You'll get one when the agent needs approval or finishes.");
    } catch (err) {
      showToast(`Could not turn on notifications (${err.message || err}).`);
    }
  }

  async function disableNotifications() {
    try { await api('POST', '/api/push/unsubscribe', {}); } catch (_) {}
    await dropPushSubscription();
    showToast('Notifications are off.');
  }

  if (relayMode && btnNotify) {
    btnNotify.classList.remove('hidden');
    btnNotify.addEventListener('click', () => {
      if (!pushSupported) {
        showToast(isIos
          ? 'On iPhone, notifications need the app on your Home Screen: tap Share, then "Add to Home Screen", and open AG Remote from that icon.'
          : 'This browser does not support notifications. Try Chrome.');
        return;
      }
      if (btnNotify.getAttribute('aria-pressed') === 'true') {
        showToast('Notifications are on.', { label: 'Turn off', run: disableNotifications });
      } else {
        enableNotifications();
      }
    });
  }

  // Tabs: one per open IDE window, each with its own conversation, status and approval.
  // Key '' holds the single conversation when the server reports no windows.
  const tabBar = document.getElementById('tabBar');
  const tabs = new Map();
  let activeTabId = '';
  try { activeTabId = localStorage.getItem('ag_remote_tab') || ''; } catch (_) {}

  function tabFor(id) {
    const key = id || '';
    if (!tabs.has(key)) tabs.set(key, { name: 'Antigravity', status: 'disconnected', messages: [], approval: null, title: '', lastActivity: 0 });
    return tabs.get(key);
  }

  function windowQuery(id = activeTabId) {
    return id ? `?windowId=${encodeURIComponent(id)}` : '';
  }

  function withWindow(body, id = activeTabId) {
    return id ? { ...body, windowId: id } : body;
  }

  /** Adds tabs for new windows and drops tabs of closed ones. Returns the ids that are new. */
  function syncTabs(windows, selectedId) {
    const added = [];
    const live = new Set(windows.map(w => w.windowId));
    for (const w of windows) {
      if (!tabs.has(w.windowId)) added.push(w.windowId);
      tabFor(w.windowId).name = w.workspaceName || 'Workspace';
    }
    for (const id of [...tabs.keys()]) {
      if (!live.has(id) && (windows.length > 0 || id !== '')) tabs.delete(id);
    }
    if (!tabs.has(activeTabId)) {
      activeTabId = (selectedId && tabs.has(selectedId)) ? selectedId : ([...tabs.keys()][0] || '');
    }
    renderTabBar();
    return added;
  }

  async function fetchTabState(id) {
    const res = await api('GET', `/api/state${windowQuery(id)}`);
    if (res.status === 401) throw Object.assign(new Error('unauthorized'), { unauthorized: true });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const snap = res.data;
    if (!tabs.has(id || '')) return; // the window closed while we asked
    const t = tabFor(id);
    t.status = snap.status;
    t.messages = Array.isArray(snap.messages) ? snap.messages : [];
    t.approval = snap.pendingApproval || null;
    t.lastActivity = Number(snap.lastActivity) || 0;
  }

  // One resync at a time. Waking fires several events and the relay coming back adds another;
  // a request made meanwhile runs once more after the current one instead of in parallel.
  let resyncRunning = null;
  let resyncAgain = false;

  function resyncState() {
    if (resyncRunning) {
      resyncAgain = true;
      return resyncRunning;
    }
    resyncRunning = (async () => {
      try {
        do {
          resyncAgain = false;
          await resyncOnce();
        } while (resyncAgain);
      } finally {
        resyncRunning = null;
      }
    })();
    return resyncRunning;
  }

  /** The shown window's chat is asked for together with the window list and drawn first; other tabs follow. */
  async function resyncOnce() {
    if (!linked() || (relayMode && !relay.isReady())) return;
    try {
      const shownId = activeTabId;
      const shown = tabs.has(shownId)
        ? fetchTabState(shownId).then(() => null, (err) => err)
        : null;
      let windows = [];
      let selectedId = null;
      const winRes = await api('GET', '/api/windows');
      if (winRes.status === 401) throw Object.assign(new Error('unauthorized'), { unauthorized: true });
      if (winRes.ok) {
        const winData = winRes.data;
        windows = winData.windows || [];
        selectedId = winData.selectedId;
      }
      syncTabs(windows, selectedId);
      if (tabs.size === 0) tabFor('');
      const shownErr = shown ? await shown : null;
      if (shownErr?.unauthorized) throw shownErr;
      const early = shown && !shownErr && activeTabId === shownId;
      if (!early) await fetchTabState(activeTabId);
      renderActiveTab();
      // A tab whose refresh fails keeps what it had; only a revoked phone stops here.
      const rest = [...tabs.keys()].filter(id => id !== activeTabId);
      const errs = await Promise.all(rest.map(id => fetchTabState(id).then(() => null, (err) => err)));
      const unauthorized = errs.find(e => e?.unauthorized);
      if (unauthorized) throw unauthorized;
      if (rest.length) renderTabBar();
    } catch (err) {
      if (err && err.unauthorized) {
        showToast('Session token invalid or expired. Please re-pair.');
        localStorage.removeItem('ag_remote_token');
        pairingModal.classList.remove('hidden');
        return;
      }
      if (!relayMode || relay.isReady()) updateStatus('disconnected', 'Disconnected');
    }
  }

  function renderTabBar() {
    tabBar.classList.toggle('hidden', tabs.size < 2);
    tabBar.innerHTML = '';
    for (const [id, t] of tabs) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(id === activeTabId));
      btn.dataset.status = t.approval ? 'awaiting_approval' : t.status;
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = t.name;
      const badge = document.createElement('span');
      badge.className = 'tab-badge';
      badge.setAttribute('aria-hidden', 'true');
      btn.append(label, badge);
      btn.setAttribute('aria-label', `${t.name}${t.approval ? ', needs you' : t.status === 'generating' ? ', working' : ''}`);
      btn.addEventListener('click', () => switchTab(id));
      tabBar.appendChild(btn);
    }
    const active = tabBar.querySelector('[aria-selected="true"]');
    if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function renderActiveTab() {
    const t = tabFor(activeTabId);
    renderSnapshot({ status: t.status, messages: t.messages, pendingApproval: t.approval, lastActivity: t.lastActivity });
    renderTabBar();
    updateActiveSessionLabel();
  }

  function switchTab(id) {
    if (!tabs.has(id)) return;
    activeTabId = id;
    try { localStorage.setItem('ag_remote_tab', id); } catch (_) {}
    hideToast();
    renderActiveTab();
    // Keeps older clients and the no-windowId default in step with what this phone shows.
    if (id) api('POST', '/api/windows/select', { windowId: id }).catch(() => {});
  }

  async function updateActiveSessionLabel() {
    if (!linked()) return;
    const id = activeTabId;
    const t = tabFor(id);
    sessionLabel.textContent = t.title || t.name;
    try {
      const res = await api('GET', `/api/sessions${windowQuery(id)}`);
      if (!res.ok || id !== activeTabId) return;
      const data = res.data;
      const current = data.sessions?.find(s => s.isCurrent);
      t.title = current ? current.title : '';
      sessionLabel.textContent = tabs.size > 1 ? (t.title || t.name) : (t.title ? `${t.name} · ${t.title}` : t.name);
    } catch (_) {}
  }


  // 3. WebSocket Connection & Event Handler
  function connectWebSocket() {
    if (relayMode) {
      if (relay) relay.ensureConnected();
      return;
    }
    if (!token || (ws && ws.readyState === WebSocket.OPEN)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isReconnecting = false;
        reconnectAttempts = 0;
        resyncState();
      };

      ws.onmessage = (event) => {
        try {
          const e = JSON.parse(event.data);
          handleAdapterEvent(e);
        } catch (_) {}
      };

      ws.onclose = () => {
        updateStatus('disconnected', 'Disconnected');
        sessionLabel.textContent = 'Reconnecting...';
        scheduleReconnect();
      };

      ws.onerror = () => {
        updateStatus('disconnected', 'Connection Error');
      };
    } catch (err) {
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (isReconnecting) return;
    isReconnecting = true;
    const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), 5000);
    reconnectAttempts++;
    setTimeout(() => {
      isReconnecting = false;
      connectWebSocket();
    }, delay);
  }

  async function handleWindowsChanged(windows) {
    const added = syncTabs(windows || [], null);
    await Promise.all(added.map(id => fetchTabState(id).catch(() => {})));
    if (!tabs.has(activeTabId) || added.includes(activeTabId)) renderActiveTab();
  }

  function handleAdapterEvent(event) {
    if (!event) return;
    if (event.type === 'windows_changed') {
      handleWindowsChanged(event.windows);
      return;
    }

    // Events without a windowId come from a single-window server and belong to the visible tab.
    const id = event.windowId || (tabs.has(activeTabId) ? activeTabId : '');
    if (event.windowId && !tabs.has(event.windowId)) return; // window not known yet; windows_changed follows
    const t = tabFor(id);
    const visible = id === activeTabId;

    if (event.type === 'message') {
      // Drop the optimistic copy of a prompt once the IDE records it.
      if (event.message.role === 'user') {
        const i = t.messages.findIndex(m => String(m.id).startsWith('local-') && m.text === event.message.text);
        if (i >= 0) {
          const [dup] = t.messages.splice(i, 1);
          if (visible) chatFeed.querySelector(`[data-msg-id="${dup.id}"]`)?.remove();
        }
      }
      t.messages.push(event.message);
      t.lastActivity = Math.max(t.lastActivity || 0, Number(event.message.ts) || Date.now());
      if (visible) appendChatMessage(event.message);
    } else if (event.type === 'approval_requested') {
      t.approval = event.approval;
      t.status = 'awaiting_approval';
      t.lastActivity = Date.now();
      if (visible) {
        showApproval(event.approval);
        updateStatus('awaiting_approval');
      } else {
        showToast(`${t.name} needs you`, { label: 'View', run: () => switchTab(id) });
        if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      }
    } else if (event.type === 'status_changed') {
      t.status = event.status;
      if (event.status !== 'disconnected') t.lastActivity = Date.now();
      if (event.status !== 'awaiting_approval') t.approval = null;
      if (visible) {
        updateStatus(event.status);
        if (event.status !== 'awaiting_approval') hideApproval();
      }
    } else if (event.type === 'session_changed') {
      // The IDE moved to another conversation; its messages follow as 'message' events.
      t.messages = [];
      t.approval = null;
      t.title = '';
      t.lastActivity = 0; // the new conversation's messages bring their own times
      if (visible) {
        renderSnapshot({ status: t.status, messages: [], pendingApproval: null });
        updateActiveSessionLabel();
      }
    } else if (event.type === 'adapter_error') {
      if (visible) showToast(event.error);
    }
    if (visible) updateLastActive(t.status, t.lastActivity);
    renderTabBar();
  }

  // 4. UI Rendering Functions

  // "Last active 3 h ago" when the shown conversation is idle and has been quiet this long
  const QUIET_MS = 10 * 60 * 1000;

  function formatAgo(ms) {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  }

  function updateLastActive(status, lastActivity) {
    const quietFor = lastActivity ? Date.now() - lastActivity : 0;
    const show = status === 'idle' && quietFor >= QUIET_MS;
    lastActiveLine.classList.toggle('hidden', !show);
    if (show) lastActiveLine.textContent = `Last active ${formatAgo(quietFor)}`;
  }

  // Keeps "… ago" current while the phone app is open
  setInterval(() => {
    const t = tabs.get(activeTabId || '');
    if (t) updateLastActive(t.status, t.lastActivity);
  }, 60000);

  function renderSnapshot(snapshot) {
    updateStatus(snapshot.status);
    updateLastActive(snapshot.status, snapshot.lastActivity);

    // The empty state lives inside the feed, so keep it when clearing.
    chatFeed.replaceChildren(emptyState);
    if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) {
      emptyState.classList.add('hidden');
      snapshot.messages.forEach(msg => appendChatMessage(msg, false));
      scrollToBottom();
    } else {
      emptyState.classList.remove('hidden');
    }

    if (snapshot.pendingApproval) {
      showApproval(snapshot.pendingApproval);
    } else {
      hideApproval();
    }
  }

  function updateStatus(status, customText) {
    statusBadge.setAttribute('data-status', status || 'disconnected');
    document.body.dataset.status = status || 'disconnected';
    const labels = {
      'idle': 'Ready',
      'generating': 'Working',
      'awaiting_approval': 'Needs you',
      'disconnected': 'Offline'
    };
    statusText.textContent = customText || labels[status] || status;

    if (status === 'generating') {
      btnStop.classList.remove('hidden');
    } else {
      btnStop.classList.add('hidden');
    }
  }

  function appendChatMessage(msg, shouldScroll = true) {
    if (!msg || (!msg.text && !msg.images?.length)) return;
    emptyState.classList.add('hidden');

    const bubble = document.createElement('div');
    bubble.className = `chat-message ${msg.role === 'user' ? 'user' : 'agent'}`;
    bubble.dataset.msgId = msg.id;

    const author = document.createElement('div');
    author.className = 'chat-author';
    author.textContent = msg.role === 'user' ? 'You' : 'Antigravity';

    const text = document.createElement('div');
    text.className = 'chat-text';
    renderMessageText(text, msg.text);

    bubble.appendChild(author);
    if (msg.images?.length) {
      const thumbs = document.createElement('div');
      thumbs.className = 'chat-images';
      for (const src of msg.images) {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'Attached image';
        thumbs.appendChild(img);
      }
      bubble.appendChild(thumbs);
    }
    if (msg.text) bubble.appendChild(text);
    chatFeed.appendChild(bubble);

    if (shouldScroll) scrollToBottom();
  }

  // Agent replies cite files as markdown links with long file:/// URLs. Show
  // just the file name for those (full path on long-press/hover), and make
  // web links tappable. Built with DOM nodes, so message text is never parsed as HTML.
  const MD_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

  function renderMessageText(el, raw) {
    let last = 0;
    for (const m of raw.matchAll(MD_LINK)) {
      el.append(raw.slice(last, m.index));
      el.append(linkNode(m[1], m[2]));
      last = m.index + m[0].length;
    }
    el.append(raw.slice(last));
  }

  function linkNode(label, url) {
    if (/^https?:\/\//i.test(url)) {
      const a = document.createElement('a');
      a.className = 'chat-link';
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label;
      return a;
    }
    // file:/// or a bare path: there is nothing to open on the phone
    const span = document.createElement('span');
    span.className = 'chat-file';
    span.textContent = label.replace(/^`|`$/g, '').split(/[\\/]/).pop() || label;
    let path = url;
    try { path = decodeURIComponent(url.replace(/^file:\/\/\/?/i, '')); } catch { /* keep raw */ }
    span.title = path;
    return span;
  }

  function scrollToBottom() {
    chatFeed.scrollTop = chatFeed.scrollHeight;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showApproval(approval) {
    currentApproval = approval;
    const kindLabels = {
      run_command: 'Terminal',
      ask_question: 'Question',
      write_to_file: 'New file',
      replace_file_content: 'File edit',
      multi_replace_file_content: 'File edit'
    };
    approvalKind.textContent = kindLabels[approval.kind] || approval.kind;

    const isQuestion = approval.kind === 'ask_question' || (Array.isArray(approval.options) && approval.options.length > 0);

    if (isQuestion) {
      if (approvalBadge) approvalBadge.textContent = 'The agent has a question';
      approvalDesc.textContent = approval.question || approval.description || 'Please select an option:';
      approvalDetail.classList.add('hidden');
      approvalActions.classList.add('hidden');
      approvalOptions.classList.remove('hidden');
      approvalOptions.innerHTML = '';

      const selectedOptions = new Set();
      const optionsList = Array.isArray(approval.options) ? approval.options : [];

      optionsList.forEach((optText) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'option-item';
        item.innerHTML = `
          <span class="option-radio-dot"></span>
          <span class="option-text">${escapeHtml(optText)}</span>
        `;
        item.addEventListener('click', () => {
          if (approval.isMultiSelect) {
            if (selectedOptions.has(optText)) {
              selectedOptions.delete(optText);
              item.classList.remove('selected');
            } else {
              selectedOptions.add(optText);
              item.classList.add('selected');
            }
            btnSubmitChoice.disabled = selectedOptions.size === 0;
          } else {
            // Single select: highlight and update submit button
            approvalOptions.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
            selectedOptions.clear();
            selectedOptions.add(optText);
            item.classList.add('selected');
            btnSubmitChoice.disabled = false;
            const preview = optText.length > 25 ? optText.slice(0, 25) + '...' : optText;
            btnSubmitChoice.textContent = `Submit: "${preview}"`;
          }
        });
        approvalOptions.appendChild(item);
      });

      // Submit Bar
      const submitBar = document.createElement('div');
      submitBar.className = 'option-submit-bar';

      const btnSubmitChoice = document.createElement('button');
      btnSubmitChoice.className = 'btn btn-approve';
      btnSubmitChoice.textContent = 'Submit answer';
      btnSubmitChoice.disabled = true;
      btnSubmitChoice.addEventListener('click', () => {
        if (selectedOptions.size > 0) {
          const chosen = Array.from(selectedOptions).join(', ');
          submitApprovalResponse(chosen);
        }
      });
      submitBar.appendChild(btnSubmitChoice);

      // Custom write-in answer box
      const writeInBox = document.createElement('div');
      writeInBox.className = 'option-writein';
      const writeInInput = document.createElement('input');
      writeInInput.type = 'text';
      writeInInput.placeholder = 'Or type your own reply';
      const btnWriteInSubmit = document.createElement('button');
      btnWriteInSubmit.className = 'btn btn-always';
      btnWriteInSubmit.textContent = 'Reply';
      const handleWriteIn = () => {
        const text = writeInInput.value.trim();
        if (text) submitApprovalResponse(text);
      };
      btnWriteInSubmit.addEventListener('click', handleWriteIn);
      writeInInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleWriteIn();
        }
      });
      writeInBox.appendChild(writeInInput);
      writeInBox.appendChild(btnWriteInSubmit);
      submitBar.appendChild(writeInBox);

      approvalOptions.appendChild(submitBar);

    } else {
      // Standard tool confirmation (e.g. run_command, write_to_file)
      if (approvalBadge) approvalBadge.textContent = 'Permission needed';
      approvalDesc.textContent = approval.description || 'Pending confirmation';
      approvalDetail.textContent = approval.detail || JSON.stringify(approval, null, 2);
      approvalDetail.classList.remove('hidden');
      approvalOptions.classList.add('hidden');
      approvalOptions.innerHTML = '';
      approvalActions.classList.remove('hidden');
      if (approvalCwd) {
        approvalCwd.textContent = approval.cwd ? `in ${approval.cwd}` : '';
        approvalCwd.classList.toggle('hidden', !approval.cwd);
      }
      // Only offer the options the IDE accepts for this request.
      const actions = Array.isArray(approval.actions) ? approval.actions : ['allow_once', 'deny'];
      const btnAlways = document.getElementById('btnAlwaysAllow');
      btnApprove.classList.toggle('hidden', !actions.includes('allow_once'));
      if (btnAlways) btnAlways.classList.toggle('hidden', !actions.includes('allow_conversation'));
      btnDeny.classList.toggle('hidden', !actions.includes('deny'));
      if (approvalDenyNote) {
        approvalDenyNote.value = '';
        approvalDenyNote.classList.toggle('hidden', !actions.includes('deny'));
      }
      if (approvalIdeOnly) approvalIdeOnly.classList.toggle('hidden', actions.length > 0);
      setApprovalBusy(false);
    }

    approvalCard.classList.remove('hidden');
  }

  function hideApproval() {
    currentApproval = null;
    approvalCard.classList.add('hidden');
    if (approvalOptions) {
      approvalOptions.innerHTML = '';
      approvalOptions.classList.add('hidden');
    }
  }

  async function submitApprovalResponse(responseText) {
    if (!currentApproval || !linked()) return;
    const approvalId = currentApproval.id;
    const tabId = activeTabId;
    hideApproval();

    // Optimistically show user response in chat
    addLocalMessage(responseText, tabId);

    try {
      const res = await api('POST', '/api/approve', withWindow({ id: approvalId, response: responseText }, tabId));
      if (!res.ok) showToast(res.data.error || 'Failed to submit response');
    } catch (err) {
      showToast('Network error submitting response.');
    }
  }

  let toastTimer = null;
  let toastAction = null;
  const toastActionBtn = document.getElementById('toastAction');
  toastActionBtn.addEventListener('click', () => {
    const run = toastAction;
    hideToast();
    if (run) run();
  });

  /** Snackbar; `action` adds a button such as { label: 'View', run: fn }. */
  function showToast(msg, action) {
    toastMessage.textContent = msg;
    toastAction = action ? action.run : null;
    toastActionBtn.textContent = action ? action.label : '';
    toastActionBtn.classList.toggle('hidden', !action);
    toastBanner.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, action ? 10000 : 6000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastAction = null;
    toastBanner.classList.add('hidden');
  }

  function addLocalMessage(text, tabId, images) {
    const msg = { id: `local-${Date.now()}`, role: 'user', text, ts: Date.now(), images };
    tabFor(tabId).messages.push(msg);
    if (tabId === activeTabId) appendChatMessage(msg);
  }

  // Images picked on the phone, already compressed: { mimeType, data (base64), src (data: URL) }
  const MAX_ATTACHMENTS = 4;
  const MAX_IMAGE_EDGE = 1600;
  const TARGET_IMAGE_BYTES = 400 * 1024;
  let attachments = [];

  function updateSendEnabled() {
    btnSend.disabled = promptInput.value.trim().length === 0 && attachments.length === 0;
  }

  function loadImage(file) {
    if (window.createImageBitmap) return createImageBitmap(file);
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
      img.src = url;
    });
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /** Downscales and re-encodes as JPEG until it fits TARGET_IMAGE_BYTES, so it travels fast over the relay. */
  async function compressImage(file) {
    const img = await loadImage(file);
    let scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
    for (;;) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent PNG areas would turn black in JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.85, 0.72, 0.6]) {
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', q));
        if (blob && (blob.size <= TARGET_IMAGE_BYTES || (q === 0.6 && scale < 0.3))) {
          const data = await blobToBase64(blob);
          return { mimeType: 'image/jpeg', data, src: `data:image/jpeg;base64,${data}` };
        }
      }
      scale *= 0.75;
    }
  }

  function renderAttachTray() {
    attachTray.innerHTML = '';
    attachTray.classList.toggle('hidden', attachments.length === 0);
    attachments.forEach((a, i) => {
      const item = document.createElement('div');
      item.className = 'attach-item';
      const img = document.createElement('img');
      img.src = a.src;
      img.alt = `Attachment ${i + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'attach-remove';
      remove.setAttribute('aria-label', 'Remove image');
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachTray();
        updateSendEnabled();
      });
      item.append(img, remove);
      attachTray.appendChild(item);
    });
  }

  async function addAttachments(files) {
    const room = MAX_ATTACHMENTS - attachments.length;
    const picked = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (picked.length > room) showToast(`Up to ${MAX_ATTACHMENTS} images per message.`);
    btnAttach.disabled = true;
    try {
      for (const file of picked.slice(0, Math.max(0, room))) {
        try {
          attachments.push(await compressImage(file));
        } catch (_) {
          showToast('Could not read that image.');
        }
        renderAttachTray();
      }
    } finally {
      btnAttach.disabled = false;
      updateSendEnabled();
    }
  }

  // 5. User Action Handlers
  async function sendPrompt(text) {
    if ((!text.trim() && attachments.length === 0) || !linked()) return;
    const tabId = activeTabId;
    const sending = attachments;

    // Optimistic UI append
    addLocalMessage(text.trim(), tabId, sending.map(a => a.src));
    promptInput.value = '';
    promptInput.style.height = 'auto';
    attachments = [];
    renderAttachTray();
    updateSendEnabled();

    const body = { text: text.trim() };
    if (sending.length) body.images = sending.map(a => ({ mimeType: a.mimeType, data: a.data }));
    let failed = false;
    try {
      const res = await api('POST', '/api/prompt', withWindow(body, tabId), sending.length ? 60000 : undefined);
      if (!res.ok) {
        failed = true;
        showToast(res.data.error || 'Failed to send prompt');
      }
    } catch (err) {
      failed = true;
      showToast('Network error sending prompt.');
    }
    // Give the images back so they can be resent, unless new ones were picked meanwhile
    if (failed && sending.length && attachments.length === 0) {
      attachments = sending;
      renderAttachTray();
      updateSendEnabled();
    }
  }

  function setApprovalBusy(busy) {
    for (const b of approvalActions.querySelectorAll('button')) b.disabled = busy;
    approvalCard.classList.toggle('busy', busy);
  }

  // Keeps the card visible until the IDE confirms; shows the real error otherwise.
  async function sendApprovalDecision(endpoint, payload, failMsg) {
    if (!currentApproval || !linked()) return;
    const approvalId = currentApproval.id;
    const tabId = activeTabId;
    setApprovalBusy(true);
    try {
      const res = await api('POST', endpoint, withWindow({ id: approvalId, ...payload }, tabId));
      if (res.ok) {
        const t = tabFor(tabId);
        if (t.approval && t.approval.id === approvalId) t.approval = null;
        if (currentApproval && currentApproval.id === approvalId) hideApproval();
        renderTabBar();
        if (navigator.vibrate) navigator.vibrate(20);
        return;
      }
      showToast(res.data.error || failMsg);
    } catch (err) {
      showToast('Network error: nothing was sent to the IDE.');
    }
    setApprovalBusy(false);
  }

  function approveCurrent(option = 'allow_once') {
    return sendApprovalDecision('/api/approve', { option }, 'Failed to approve action');
  }

  function denyCurrent() {
    const reason = approvalDenyNote ? approvalDenyNote.value.trim() : '';
    return sendApprovalDecision('/api/deny', reason ? { reason } : {}, 'Failed to deny action');
  }

  async function stopCurrent() {
    if (!linked()) return;
    try {
      const res = await api('POST', '/api/stop', withWindow({}));
      if (!res.ok) {
        showToast(res.data.error || 'Failed to stop the agent.');
        return;
      }
      showToast('Stop sent to the IDE.');
    } catch (err) {
      showToast('Network error: stop was not sent.');
    }
  }

  // 6. Event Listeners
  btnApprove.addEventListener('click', () => approveCurrent('allow_once'));
  const btnAlwaysAllow = document.getElementById('btnAlwaysAllow');
  if (btnAlwaysAllow) {
    btnAlwaysAllow.addEventListener('click', () => approveCurrent('allow_conversation'));
  }
  btnDeny.addEventListener('click', denyCurrent);
  btnStop.addEventListener('click', stopCurrent);
  toastClose.addEventListener('click', hideToast);

  const pairError = document.getElementById('pairError');
  const btnCancelPair = document.getElementById('btnCancelPair');

  function showPairError(msg) {
    pairError.textContent = msg;
    pairError.classList.remove('hidden');
  }

  // Keep the current pairing until a new PIN succeeds, so opening this by mistake costs nothing.
  const btnRePair = document.getElementById('btnRePair');
  if (btnRePair) {
    btnRePair.addEventListener('click', () => {
      if (relayMode) {
        showRelayPairing();
        return;
      }
      pairError.classList.add('hidden');
      btnCancelPair.classList.toggle('hidden', !token);
      pairingModal.classList.remove('hidden');
      tokenInput.focus();
    });
  }
  btnCancelPair.addEventListener('click', () => {
    pairingModal.classList.add('hidden');
    tokenInput.value = '';
  });

  btnAttach.addEventListener('click', () => attachInput.click());
  attachInput.addEventListener('change', () => {
    const files = attachInput.files;
    if (files && files.length) addAttachments(files);
    attachInput.value = ''; // lets the same image be picked again
  });

  // Pasting an image (e.g. from the clipboard on a tablet or desktop browser) attaches it
  promptInput.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });

  promptInput.addEventListener('input', () => {
    updateSendEnabled();
    // Auto-expand textarea
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 120)}px`;
  });

  promptForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendPrompt(promptInput.value);
  });

  // Enter to send (Shift+Enter for newline)
  promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!btnSend.disabled) {
        sendPrompt(promptInput.value);
      }
    }
  });

  // Auto-format 6-digit PIN or 6-char code with space after 3 chars (e.g. 849 201 or K7A 9P2)
  tokenInput.addEventListener('input', () => {
    const val = tokenInput.value;
    // If input looks like a URL/link, don't format with spaces
    if (tokenInput.getAttribute('inputmode') === 'url' || /[/:#.]/.test(val)) {
      return;
    }
    let clean = val.replace(/[\s-]/g, '');
    if (clean.length > 6) clean = clean.slice(0, 6);
    if (clean.length > 3) {
      tokenInput.value = `${clean.slice(0, 3)} ${clean.slice(3)}`;
    } else {
      tokenInput.value = clean;
    }
  });

  async function connectWithRelayRoomAndSecret(newRoom, newSecret) {
    try {
      localStorage.setItem(RELAY_ROOM_KEY, newRoom);
    } catch (_) {}

    relayRoom = newRoom;
    relayMode = true;
    window.history.replaceState(null, document.title, `/p/${newRoom}`);

    btnSaveToken.disabled = true;
    btnSaveToken.textContent = 'Connecting...';
    pairError.classList.add('hidden');

    if (relay) {
      try { relay.stop(); } catch (_) {}
      relay = null;
    }

    const { RelayLink } = await import('/relay-link.js');
    relay = new RelayLink({
      room: newRoom,
      secret: newSecret,
      onEvent: handleAdapterEvent,
      onState: (state) => {
        btnSaveToken.disabled = false;
        btnSaveToken.textContent = 'Connect';
        handleRelayState(state);
      },
      onPairError: (code) => {
        btnSaveToken.disabled = false;
        btnSaveToken.textContent = 'Connect';
        showRelayPairing(RELAY_PAIR_ERRORS[code] || 'Pairing failed. Show a new QR code on your PC and scan it.');
      }
    });
    relay.start();
  }

  async function handleTokenConnect() {
    const rawVal = tokenInput.value.trim();
    if (!rawVal) {
      showPairError(isRelayHost
        ? 'Enter the 6-character code or link from your PC.'
        : 'Enter the 6-digit PIN or pairing code shown on your PC.');
      tokenInput.focus();
      return;
    }

    // 1. Check if input is a pairing link (e.g. https://remote.taqnik.in/p/<room>#<secret>, /p/<room>#<secret>, or remote.taqnik.in/p/...)
    let linkUrl = rawVal;
    if (!linkUrl.includes('://') && linkUrl.includes('/p/')) {
      linkUrl = `${window.location.protocol}//${linkUrl}`;
    }

    let parsedLink = null;
    try {
      parsedLink = new URL(linkUrl, window.location.origin);
    } catch (_) {}

    const roomMatch = parsedLink ? parsedLink.pathname.match(/^\/p\/([A-Za-z0-9_-]{22})\/?$/) : null;
    const hasSecret = parsedLink && parsedLink.hash && parsedLink.hash.length > 1;

    if (roomMatch || (parsedLink && parsedLink.pathname.includes('/p/')) || (rawVal.includes('#') && rawVal.includes('/p/'))) {
      if (!roomMatch || !hasSecret) {
        showPairError('That is not a complete pairing link. Make sure to copy the full link including the # code from the QR.');
        return;
      }
      await connectWithRelayRoomAndSecret(roomMatch[1], parsedLink.hash.slice(1));
      return;
    }

    const cleanCode = rawVal.replace(/[\s-]/g, '');

    // 2. Check 6-char alphanumeric short code (works across networks via relay)
    if (/^[A-Za-z0-9]{6}$/.test(cleanCode)) {
      // If code contains letters, OR we are running on the hosted relay, query relay /code/<CODE>
      if (/[A-Za-z]/.test(cleanCode) || isRelayHost) {
        btnSaveToken.disabled = true;
        btnSaveToken.textContent = 'Connecting...';
        pairError.classList.add('hidden');

        const relayBase = isRelayHost ? window.location.origin : 'https://remote.taqnik.in';
        try {
          const res = await fetch(`${relayBase}/code/${encodeURIComponent(cleanCode.toUpperCase())}`, {
            headers: { 'Accept': 'application/json' }
          });
          if (res.ok) {
            const data = await res.json();
            if (data.room && data.fragment) {
              await connectWithRelayRoomAndSecret(data.room, data.fragment);
              return;
            }
          }
          if (res.status === 429) {
            btnSaveToken.disabled = false;
            btnSaveToken.textContent = 'Connect';
            showPairError('Too many tries. Wait a minute, then enter the code again or scan the QR code.');
            return;
          }
        } catch (_) {}

        btnSaveToken.disabled = false;
        btnSaveToken.textContent = 'Connect';

        if (isRelayHost && /^\d{6}$/.test(cleanCode)) {
          showPairError('This looks like a local Wi-Fi PIN. If your phone is on cellular data, use the 6-character Pairing Code shown on your PC or scan the QR code.');
          return;
        }

        showPairError('Pairing code expired or not found. Check the code or show a new QR code on your PC.');
        return;
      }
    }

    // 3. Wi-Fi 6-digit PIN flow (local LAN / Tailscale)
    if (!/^\d{6}$/.test(cleanCode)) {
      showPairError(isRelayHost ? 'Enter a 6-character pairing code or link.' : 'Enter the 6-digit PIN shown on your PC.');
      tokenInput.focus();
      return;
    }

    pairError.classList.add('hidden');
    btnSaveToken.disabled = true;
    btnSaveToken.textContent = 'Connecting...';

    try {
      const pairRes = await fetch(`/pair?t=${encodeURIComponent(cleanCode)}`, {
        headers: { 'Accept': 'application/json' }
      });
      const data = await pairRes.json();
      if (pairRes.ok && data.token) {
        token = data.token;
        localStorage.setItem('ag_remote_token', token);
        pairingModal.classList.add('hidden');
        tokenInput.value = '';
        if (ws) {
          ws.close();
          ws = null;
        }
        startApp();
      } else if (!data.error || data.error.startsWith('Invalid')) {
        showPairError('That PIN is not valid. Each PIN works once, and scanning the QR code uses it. Click AG-Remote on your PC for a fresh PIN.');
      } else {
        showPairError(data.error);
      }
    } catch (err) {
      showPairError('Could not reach your PC. Check that the phone is on the same Wi-Fi.');
    } finally {
      btnSaveToken.disabled = false;
      btnSaveToken.textContent = 'Connect';
    }
  }

  btnSaveToken.addEventListener('click', handleTokenConnect);
  tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleTokenConnect();
    }
  });

  // Switch Active Session & Windows
  const btnSwitchSession = document.getElementById('btnSwitchSession');
  if (btnSwitchSession) {
    btnSwitchSession.addEventListener('click', openSessionsModal);
  }

  const btnCloseSessionsModal = document.getElementById('btnCloseSessionsModal');
  if (btnCloseSessionsModal) {
    btnCloseSessionsModal.addEventListener('click', () => {
      const modal = document.getElementById('sessionsModal');
      if (modal) modal.classList.add('hidden');
    });
  }

  async function openSessionsModal() {
    if (!linked()) return;
    const modal = document.getElementById('sessionsModal');
    const list = document.getElementById('sessionsList');
    if (!modal || !list) return;

    list.innerHTML = '<div class="list-empty">Loading windows and conversations...</div>';
    modal.classList.remove('hidden');

    try {
      // 1. Fetch live active windows from hub
      let windows = [];
      let selectedWinId = null;
      try {
        const winRes = await api('GET', '/api/windows');
        if (winRes.ok) {
          windows = winRes.data.windows || [];
          selectedWinId = winRes.data.selectedId;
        }
      } catch (_) {}

      // 2. Fetch sessions
      const tabId = activeTabId;
      const res = await api('GET', `/api/sessions${windowQuery(tabId)}`);
      const data = res.ok ? res.data : { sessions: [] };
      list.innerHTML = '';

      // If active windows are registered, render them at the top
      if (windows.length > 0) {
        const winHeader = document.createElement('div');
        winHeader.className = 'list-subheader';
        winHeader.textContent = `Open IDE windows (${windows.length})`;
        list.appendChild(winHeader);

        windows.forEach(w => {
          const isSelected = tabs.has(activeTabId) ? w.windowId === activeTabId : w.windowId === selectedWinId;
          const wItem = document.createElement('div');
          wItem.className = `session-item ${isSelected ? 'current' : ''}`;
          wItem.innerHTML = `
            <div class="session-item-title">${escapeHtml(w.workspaceName)} ${w.isFocused ? '<span class="focused-tag">Focused</span>' : ''}</div>
            <div class="session-item-sub">
              <span>${escapeHtml(w.workspacePath)}</span>
              <span>${isSelected ? 'Showing' : ''}</span>
            </div>
          `;
          wItem.addEventListener('click', async () => {
            modal.classList.add('hidden');
            if (!tabs.has(w.windowId)) await resyncState();
            switchTab(w.windowId);
          });
          list.appendChild(wItem);
        });

        const divider = document.createElement('div');
        divider.className = 'list-divider';
        list.appendChild(divider);
      }

      // Render workspace sessions
      const sessHeader = document.createElement('div');
      sessHeader.className = 'list-subheader';
      sessHeader.textContent = tabId && tabs.has(tabId) ? `Conversations in ${tabFor(tabId).name}` : 'Conversations';
      list.appendChild(sessHeader);

      if (!data.sessions || data.sessions.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'list-empty';
        emptyMsg.textContent = 'No matching conversations found.';
        list.appendChild(emptyMsg);
        return;
      }

      data.sessions.forEach(s => {
        const item = document.createElement('div');
        item.className = `session-item ${s.isCurrent ? 'current' : ''}`;
        const wsName = s.workspace ? s.workspace.split(/[\\/]/).pop() : 'Workspace';
        const ago = formatTimeAgo(s.mtime);

        item.innerHTML = `
          <div class="session-item-title">${escapeHtml(s.title || 'Untitled conversation')}</div>
          <div class="session-item-sub">
            <span>${escapeHtml(wsName)}</span>
            <span>${ago}</span>
          </div>
        `;

        item.addEventListener('click', async () => {
          try {
            item.classList.add('busy');
            const switchRes = await api('POST', '/api/sessions/select', withWindow({ id: s.id }, tabId));
            if (switchRes.ok) {
              modal.classList.add('hidden');
              await fetchTabState(tabId).catch(() => {});
              if (tabId === activeTabId) renderActiveTab();
            } else {
              showToast('Could not switch to selected session');
            }
          } catch (_) {
            showToast('Network error switching session');
          }
        });

        list.appendChild(item);
      });
    } catch (err) {
      list.innerHTML = '<div class="list-empty error">Could not load conversations.</div>';
    }
  }


  function formatTimeAgo(mtime) {
    const diff = Math.floor((Date.now() - mtime) / 1000);
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function handleAppWake() {
    if (relayMode && relay) {
      relay.wake();
    } else if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      // A socket still opening is left to finish: waking fires several events at once.
      connectWebSocket();
    }
    resyncState();
    startVisibilityHeartbeat();
    if (document.visibilityState === 'visible') clearNotifications();
  }

  // Notifications: the app on screen shows everything they said, so it clears them; a tapped one
  // says what it was about while the app reconnects (sw.js posts it, or caches it for a fresh window).
  function clearNotifications() {
    if (!pushSupported) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.getNotifications())
      .then((list) => list.forEach((n) => n.close()))
      .catch(() => {});
  }

  const NOTICE_MAX_AGE_MS = 2 * 60 * 1000;

  function showNotice(notice) {
    if (!notice || notice.type !== 'ag-notice' || typeof notice.text !== 'string' || !notice.text) return;
    if (!(Date.now() - Number(notice.at) < NOTICE_MAX_AGE_MS)) return;
    showToast(notice.text);
  }

  async function takeCachedNotice() {
    try {
      const cache = await caches.open('ag-remote-notice');
      const res = await cache.match('/__notice');
      if (!res) return;
      await cache.delete('/__notice');
      showNotice(await res.json());
    } catch (_) {}
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type !== 'ag-notice') return;
      showNotice(e.data);
      caches.open('ag-remote-notice').then((c) => c.delete('/__notice')).catch(() => {});
    });
  }
  if ('caches' in window) takeCachedNotice();

  function handleAppSleep() {
    stopVisibilityHeartbeat();
    reportVisibility();
  }

  // Auto-resync when phone wakes up or tab returns to view (Requirement F7: < 3s resync)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      handleAppWake();
    } else {
      handleAppSleep();
    }
  });

  window.addEventListener('pageshow', handleAppWake);
  window.addEventListener('focus', handleAppWake);
  window.addEventListener('online', handleAppWake);
  window.addEventListener('pagehide', handleAppSleep);
  window.addEventListener('freeze', handleAppSleep);

  // A fresh relay QR opened while this page is already showing the room only changes the #fragment,
  // which doesn't reload the page. Start over so the new secret is used.
  window.addEventListener('hashchange', () => {
    if (relayMode && window.location.hash.length > 1) window.location.reload();
  });

  // 7. Register Service Worker for PWA (Requirement F9)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  // Initialize
  initAuth();
})();
