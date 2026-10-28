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
  const relayRoom = (() => {
    const m = window.location.pathname.match(/^\/p\/([A-Za-z0-9_-]{22})\/?$/);
    if (m) return m[1];
    if (window.location.protocol !== 'https:') return null;
    try { return localStorage.getItem(RELAY_ROOM_KEY); } catch (_) { return null; }
  })();
  const relayMode = !!relayRoom;
  let relay = null; // RelayLink (relay-link.js) in relay mode

  /** Paired with a PC (it may still be unreachable right now). */
  function linked() {
    return relayMode ? !!relay : !!token;
  }

  /** One API call over whichever transport this page uses. Resolves { ok, status, data }. */
  async function api(method, path, body) {
    if (relayMode) {
      if (!relay) throw new Error('not-connected');
      return relay.request(method, path, body);
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
    'timeout': 'Your PC did not answer. Check that Antigravity is open, then scan a new QR code.'
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

  function handleRelayState(state) {
    if (state === 'ready') {
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
    const labels = {
      'connecting': 'Connecting...',
      'pairing': 'Pairing...',
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
    // may not share the browser's storage. There, pasting the QR's link pairs instead.
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    pairHint.textContent = standalone
      ? 'Point your camera at the QR code from AG-Remote on your PC, press and hold the link it shows, choose Copy Link, and paste it here.'
      : 'Scan the QR code from AG-Remote on your PC (click AG-Remote in the IDE status bar). It works on any network.';
    pinLabel.classList.add('hidden');
    tokenInput.classList.toggle('hidden', !standalone);
    btnSaveToken.classList.toggle('hidden', !standalone);
    if (standalone) {
      tokenInput.removeAttribute('maxlength');
      tokenInput.setAttribute('inputmode', 'url');
      tokenInput.placeholder = 'Paste the pairing link';
    }
    btnCancelPair.classList.toggle('hidden', !(relay && relay.isReady()));
    if (error) showPairError(error);
    else pairError.classList.add('hidden');
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

  function reportVisibility() {
    if (relay && relay.isReady()) api('POST', '/api/push/visible', { visible: document.visibilityState === 'visible' }).catch(() => {});
  }

  /** Each connect: tell the PC whether we're on screen, and re-send our subscription in case it lost it. */
  async function pushOnReady() {
    reportVisibility();
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
    if (!tabs.has(key)) tabs.set(key, { name: 'Antigravity', status: 'disconnected', messages: [], approval: null, title: '' });
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
    const t = tabFor(id);
    t.status = snap.status;
    t.messages = Array.isArray(snap.messages) ? snap.messages : [];
    t.approval = snap.pendingApproval || null;
  }

  async function resyncState() {
    if (!linked() || (relayMode && !relay.isReady())) return;
    try {
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
      await Promise.all([...tabs.keys()].map(id => fetchTabState(id)));
      renderActiveTab();
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
    renderSnapshot({ status: t.status, messages: t.messages, pendingApproval: t.approval });
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
      if (visible) appendChatMessage(event.message);
    } else if (event.type === 'approval_requested') {
      t.approval = event.approval;
      t.status = 'awaiting_approval';
      if (visible) {
        showApproval(event.approval);
        updateStatus('awaiting_approval');
      } else {
        showToast(`${t.name} needs you`, { label: 'View', run: () => switchTab(id) });
        if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      }
    } else if (event.type === 'status_changed') {
      t.status = event.status;
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
      if (visible) {
        renderSnapshot({ status: t.status, messages: [], pendingApproval: null });
        updateActiveSessionLabel();
      }
    } else if (event.type === 'adapter_error') {
      if (visible) showToast(event.error);
    }
    renderTabBar();
  }

  // 4. UI Rendering Functions
  function renderSnapshot(snapshot) {
    updateStatus(snapshot.status);

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
    if (!msg || !msg.text) return;
    emptyState.classList.add('hidden');

    const bubble = document.createElement('div');
    bubble.className = `chat-message ${msg.role === 'user' ? 'user' : 'agent'}`;
    bubble.dataset.msgId = msg.id;

    const author = document.createElement('div');
    author.className = 'chat-author';
    author.textContent = msg.role === 'user' ? 'You' : 'Antigravity';

    const text = document.createElement('div');
    text.className = 'chat-text';
    text.textContent = msg.text;

    bubble.appendChild(author);
    bubble.appendChild(text);
    chatFeed.appendChild(bubble);

    if (shouldScroll) scrollToBottom();
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

  function addLocalMessage(text, tabId) {
    const msg = { id: `local-${Date.now()}`, role: 'user', text, ts: Date.now() };
    tabFor(tabId).messages.push(msg);
    if (tabId === activeTabId) appendChatMessage(msg);
  }

  // 5. User Action Handlers
  async function sendPrompt(text) {
    if (!text.trim() || !linked()) return;
    const tabId = activeTabId;

    // Optimistic UI append
    addLocalMessage(text.trim(), tabId);
    promptInput.value = '';
    promptInput.style.height = 'auto';
    btnSend.disabled = true;

    try {
      const res = await api('POST', '/api/prompt', withWindow({ text: text.trim() }, tabId));
      if (!res.ok) showToast(res.data.error || 'Failed to send prompt');
    } catch (err) {
      showToast('Network error sending prompt.');
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

  promptInput.addEventListener('input', () => {
    btnSend.disabled = promptInput.value.trim().length === 0;
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

  // Auto-format 6-digit PIN with space after 3 digits (e.g. 849 201)
  tokenInput.addEventListener('input', () => {
    let clean = tokenInput.value.replace(/[^\d]/g, '');
    if (clean.length > 6) clean = clean.slice(0, 6);
    if (clean.length > 3) {
      tokenInput.value = `${clean.slice(0, 3)} ${clean.slice(3)}`;
    } else {
      tokenInput.value = clean;
    }
  });

  async function handleTokenConnect() {
    if (relayMode) {
      let link = null;
      try { link = new URL(tokenInput.value.trim()); } catch (_) {}
      if (!link || link.origin !== window.location.origin || !/^\/p\/[A-Za-z0-9_-]{22}\/?$/.test(link.pathname) || link.hash.length < 2) {
        showPairError('That is not a pairing link. Copy the link from the QR code on your PC.');
        return;
      }
      // Same room: only the #fragment changes, and the hashchange handler reloads with the new secret.
      window.location.href = link.href;
      return;
    }
    const cleanPin = tokenInput.value.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(cleanPin)) {
      showPairError('Enter the 6-digit PIN shown on your PC.');
      tokenInput.focus();
      return;
    }

    pairError.classList.add('hidden');
    btnSaveToken.disabled = true;
    btnSaveToken.textContent = 'Connecting...';

    try {
      const pairRes = await fetch(`/pair?t=${encodeURIComponent(cleanPin)}`, {
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
        // Codes are single-use and the QR code carries the same code, so a scanned PIN is already spent.
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

  // Auto-resync when phone wakes up or tab returns to view (Requirement F7: < 3s resync)
  document.addEventListener('visibilitychange', () => {
    if (relayMode) reportVisibility();
    if (document.visibilityState === 'visible') {
      resyncState();
      if (relayMode || !ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
    }
  });

  // A fresh relay QR opened while this page is already showing the room only changes the #fragment,
  // which doesn't reload the page. Start over so the new secret is used.
  window.addEventListener('hashchange', () => {
    if (relayMode && window.location.hash.length > 1) window.location.reload();
  });

  window.addEventListener('online', () => {
    resyncState();
    connectWebSocket();
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
