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

  // 1. Token Initialization & Pairing Exchange
  async function initAuth() {
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

  async function resyncState() {
    if (!token) return;
    try {
      const res = await fetch('/api/state', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (res.status === 401) {
        showToast('Session token invalid or expired. Please re-pair.');
        localStorage.removeItem('ag_remote_token');
        pairingModal.classList.remove('hidden');
        return;
      }

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const snapshot = await res.json();
      renderSnapshot(snapshot);
      updateActiveSessionLabel();
    } catch (err) {
      updateStatus('disconnected', 'Disconnected');
    }
  }

  async function updateActiveSessionLabel() {
    if (!token) return;
    try {
      // 1. Try checking active windows from coordinator hub
      const winRes = await fetch('/api/windows', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (winRes.ok) {
        const winData = await winRes.json();
        const currentWin = winData.windows?.find(w => w.windowId === winData.selectedId) || winData.windows?.[0];
        if (currentWin) {
          sessionLabel.textContent = `[${currentWin.workspaceName}] Active`;
          return;
        }
      }

      // 2. Fallback to sessions endpoint
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        const current = data.sessions?.find(s => s.isCurrent);
        if (current) {
          const wsName = current.workspace ? current.workspace.split(/[\\/]/).pop() : '';
          sessionLabel.textContent = wsName ? `[${wsName}] ${current.title}` : current.title;
        }
      }
    } catch (_) {}
  }


  // 3. WebSocket Connection & Event Handler
  function connectWebSocket() {
    if (!token || (ws && ws.readyState === WebSocket.OPEN)) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        isReconnecting = false;
        reconnectAttempts = 0;
        sessionLabel.textContent = 'Active Session';
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

  function handleAdapterEvent(event) {
    if (!event) return;

    if (event.type === 'message') {
      appendChatMessage(event.message);
    } else if (event.type === 'approval_requested') {
      showApproval(event.approval);
      updateStatus('awaiting_approval', 'Approval Needed');
    } else if (event.type === 'status_changed') {
      updateStatus(event.status);
      if (event.status !== 'awaiting_approval') {
        hideApproval();
      }
    } else if (event.type === 'session_changed') {
      // The IDE moved to another conversation; its messages follow as 'message' events.
      chatFeed.innerHTML = '';
      emptyState.classList.remove('hidden');
      hideApproval();
      updateActiveSessionLabel();
    } else if (event.type === 'adapter_error') {
      showToast(event.error);
    }
  }

  // 4. UI Rendering Functions
  function renderSnapshot(snapshot) {
    updateStatus(snapshot.status);

    if (Array.isArray(snapshot.messages) && snapshot.messages.length > 0) {
      emptyState.classList.add('hidden');
      chatFeed.innerHTML = '';
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
    const labels = {
      'idle': '● Ready',
      'generating': '⚡ Thinking...',
      'awaiting_approval': '🔔 Action Required',
      'disconnected': '✖ Offline'
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
    approvalKind.textContent = approval.kind;

    const isQuestion = approval.kind === 'ask_question' || (Array.isArray(approval.options) && approval.options.length > 0);

    if (isQuestion) {
      if (approvalBadge) approvalBadge.textContent = '❓ Question from Agent';
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
      btnSubmitChoice.style.width = '100%';
      btnSubmitChoice.textContent = 'Submit Selected Answer';
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
      writeInInput.placeholder = 'Or type custom reply...';
      const btnWriteInSubmit = document.createElement('button');
      btnWriteInSubmit.className = 'btn btn-primary';
      btnWriteInSubmit.style.fontSize = '12px';
      btnWriteInSubmit.style.padding = '8px 12px';
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
      if (approvalBadge) approvalBadge.textContent = '🔔 Action Permission Required';
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
    if (!currentApproval || !token) return;
    const approvalId = currentApproval.id;
    hideApproval();

    // Optimistically show user response in chat
    appendChatMessage({
      id: `local-${Date.now()}`,
      role: 'user',
      text: responseText,
      ts: Date.now()
    });

    try {
      const res = await fetch('/api/approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ id: approvalId, response: responseText })
      });

      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to submit response');
      }
    } catch (err) {
      showToast('Network error submitting response.');
    }
  }

  function showToast(msg) {
    toastMessage.textContent = msg;
    toastBanner.classList.remove('hidden');
  }

  function hideToast() {
    toastBanner.classList.add('hidden');
  }

  // 5. User Action Handlers
  async function sendPrompt(text) {
    if (!text.trim() || !token) return;

    // Optimistic UI append
    appendChatMessage({
      id: `local-${Date.now()}`,
      role: 'user',
      text: text.trim(),
      ts: Date.now()
    });
    promptInput.value = '';
    btnSend.disabled = true;

    try {
      const res = await fetch('/api/prompt', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ text: text.trim() })
      });

      if (!res.ok) {
        const data = await res.json();
        showToast(data.error || 'Failed to send prompt');
      }
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
    if (!currentApproval || !token) return;
    const approvalId = currentApproval.id;
    setApprovalBusy(true);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ id: approvalId, ...payload })
      });
      if (res.ok) {
        if (currentApproval && currentApproval.id === approvalId) hideApproval();
        if (navigator.vibrate) navigator.vibrate(20);
        return;
      }
      const data = await res.json().catch(() => ({}));
      showToast(data.error || failMsg);
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
    if (!token) return;
    try {
      const res = await fetch('/api/stop', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showToast(data.error || 'Failed to stop the agent.');
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
    promptInput.style.height = `${Math.min(promptInput.scrollHeight, 100)}px`;
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
    if (!token) return;
    const modal = document.getElementById('sessionsModal');
    const list = document.getElementById('sessionsList');
    if (!modal || !list) return;

    list.innerHTML = '<div style="color:#94a3b8; font-size:12px; padding:8px;">Loading active windows & sessions...</div>';
    modal.classList.remove('hidden');

    try {
      // 1. Fetch live active windows from hub
      let windows = [];
      let selectedWinId = null;
      try {
        const winRes = await fetch('/api/windows', {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (winRes.ok) {
          const winData = await winRes.json();
          windows = winData.windows || [];
          selectedWinId = winData.selectedId;
        }
      } catch (_) {}

      // 2. Fetch sessions
      const res = await fetch('/api/sessions', {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = res.ok ? await res.json() : { sessions: [] };
      list.innerHTML = '';

      // If active windows are registered, render them at the top
      if (windows.length > 0) {
        const winHeader = document.createElement('div');
        winHeader.style.cssText = 'font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#6366f1; font-weight:700; margin:4px 0 6px 4px;';
        winHeader.textContent = `🟢 Active IDE Windows (${windows.length})`;
        list.appendChild(winHeader);

        windows.forEach(w => {
          const isSelected = w.windowId === selectedWinId;
          const wItem = document.createElement('div');
          wItem.className = `session-item ${isSelected ? 'current' : ''}`;
          wItem.innerHTML = `
            <div class="session-item-title">${isSelected ? '⭐ ' : ''}📁 ${escapeHtml(w.workspaceName)} ${w.isFocused ? '<span style="font-size:11px; color:#10b981;">(Focused)</span>' : ''}</div>
            <div class="session-item-sub">
              <span>${escapeHtml(w.workspacePath)}</span>
              <span>PID: ${w.pid || 'Active'}</span>
            </div>
          `;
          wItem.addEventListener('click', async () => {
            wItem.style.opacity = '0.5';
            try {
              const selRes = await fetch('/api/windows/select', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ windowId: w.windowId })
              });
              if (selRes.ok) {
                modal.classList.add('hidden');
                await resyncState();
                await updateActiveSessionLabel();
              }
            } catch (_) {}
          });
          list.appendChild(wItem);
        });

        const divider = document.createElement('div');
        divider.style.cssText = 'height:1px; background:#334155; margin:10px 0;';
        list.appendChild(divider);
      }

      // Render workspace sessions
      const sessHeader = document.createElement('div');
      sessHeader.style.cssText = 'font-size:11px; text-transform:uppercase; letter-spacing:0.5px; color:#94a3b8; font-weight:700; margin:4px 0 6px 4px;';
      sessHeader.textContent = '💬 Sessions in Workspace';
      list.appendChild(sessHeader);

      if (!data.sessions || data.sessions.length === 0) {
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'color:#94a3b8; font-size:12px; padding:8px;';
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
          <div class="session-item-title">${s.isCurrent ? '⭐ ' : ''}${escapeHtml(s.title || 'Untitled Session')}</div>
          <div class="session-item-sub">
            <span>📁 ${escapeHtml(wsName)}</span>
            <span>${ago}</span>
          </div>
        `;

        item.addEventListener('click', async () => {
          try {
            item.style.opacity = '0.5';
            const switchRes = await fetch('/api/sessions/select', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
              },
              body: JSON.stringify({ id: s.id })
            });
            if (switchRes.ok) {
              modal.classList.add('hidden');
              await resyncState();
              await updateActiveSessionLabel();
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
      list.innerHTML = '<div style="color:#f87171; font-size:12px; padding:8px;">Failed to load sessions.</div>';
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
    if (document.visibilityState === 'visible') {
      resyncState();
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        connectWebSocket();
      }
    }
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
