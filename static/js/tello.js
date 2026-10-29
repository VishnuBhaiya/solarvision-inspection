'use strict';

const TelloApp = (() => {
  const state = {
    connected: false,
    flying: false,
    streaming: false,
    demoMode: false,
    ws: null,
    frameCanvas: null,
    frameCtx: null,
    rawFrameCanvas: null,
    rawFrameCtx: null,
    detectOverlay: true,
    liveInspectBusy: false,
    backendBridge: false,
    realFeedBusy: false,
    statusBusy: false,
    lastLiveInspectAt: 0,
    lastAutoInspectAt: 0,
    lastLiveStoreAt: 0,
    telemetryTimer: null,
    demoFeedTimer: null,
    demoTelemetryTimer: null,
    realFeedTimer: null,
    telemetry: {
      battery: 0,
      altitude: 0,
      speed: 0,
      temp: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      flightTime: 0,
    },
    liveDetections: [],
  };

  function init() {
    state.frameCanvas = Utils.el('liveFeedCanvas');
    state.frameCtx = state.frameCanvas ? state.frameCanvas.getContext('2d') : null;
    state.rawFrameCanvas = document.createElement('canvas');
    state.rawFrameCtx = state.rawFrameCanvas.getContext('2d');
    _setConnStatus('disconnected');
    _updateTelemetryUI();
    _updateControlStates();
    _renderLiveDetections();
    Log.sys('telloLog', 'Tello page ready. Connect uses the real Tello bridge. Demo is manual.');
    if (typeof TelloLiveChart !== 'undefined') TelloLiveChart.init('telloLiveChart');
  }

  async function connect() {
    if (state.connected && state.demoMode) {
      Log.info('telloLog', 'Leaving demo mode and retrying real Tello connection...');
      _stopDemoMode();
      state.connected = false;
      state.streaming = false;
      state.flying = false;
      _hideFeedPlaceholder(false);
      _setLiveBadge(false);
    } else if (state.connected || (state.ws && state.ws.readyState <= 1)) {
      Toast.info('Tello is already connected or connecting');
      return;
    }
    _stopDemoMode();
    _setConnStatus('connecting');
    Log.info('telloLog', 'Checking direct Flask Tello bridge...');
    try {
      const res = await fetch('/api/tello/connect', { method: 'POST' });
      const data = await res.json();
      if (data.success && data.connected) {
        state.backendBridge = true;
        state.demoMode = false;
        state.connected = true;
        state.streaming = false;
        state.liveDetections = [];
        _setConnStatus('connected');
        _clearFeedCanvas();
        _hideFeedPlaceholder(false);
        _setLiveBadge(false);
        _updateControlStates();
        _renderLiveDetections();
        _startStatusPoll();
        Log.ok('telloLog', 'Real Tello connected through Flask UDP bridge');
        Toast.success('Real Tello connected');
        return;
      }
      Log.warn('telloLog', 'Flask Tello bridge did not respond: ' + (data.response || data.error || 'unavailable'));
    } catch (err) {
      Log.warn('telloLog', 'Flask Tello bridge unavailable: ' + (err.message || err));
    }

    const host = Utils.el('telloHost')?.value || location.hostname || '127.0.0.1';
    const port = Utils.el('telloPort')?.value || '8765';
    const wsUrl = `ws://${host}:${port}/tello`;

    _setConnStatus('connecting');
    Log.info('telloLog', `Connecting to Tello bridge at ${wsUrl}`);

    let settled = false;
    try {
      state.ws = new WebSocket(wsUrl);
    } catch (err) {
      _realConnectFailed('Could not open bridge socket: ' + (err.message || err));
      return;
    }

    const fallback = setTimeout(() => {
      if (settled || state.connected) return;
      settled = true;
      try { state.ws.close(); } catch (_) {}
      state.ws = null;
      _realConnectFailed('No bridge response from ' + wsUrl + '.');
    }, 1800);

    state.ws.onopen = () => {
      settled = true;
      clearTimeout(fallback);
      state.demoMode = false;
      state.connected = true;
      state.streaming = false;
      _setConnStatus('connected');
      _updateControlStates();
      Log.ok('telloLog', 'Connected to Tello bridge');
      Toast.success('Tello connected');
      _send({ cmd: 'command' });
      _startTelemetryPoll();
    };

    state.ws.onmessage = (event) => {
      try {
        _handleMessage(JSON.parse(event.data));
      } catch (_) {
        Log.info('telloLog', 'Tello: ' + event.data);
      }
    };

    state.ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      try { state.ws.close(); } catch (_) {}
      state.ws = null;
      _realConnectFailed('Bridge socket failed.');
    };

    state.ws.onclose = () => {
      clearTimeout(fallback);
      if (state.demoMode) return;
      if (!settled) _realConnectFailed('Bridge socket closed before connection completed.');
      else if (!state.connected) _setConnStatus('disconnected');
    };
  }

  function disconnect() {
    try { if (state.ws) state.ws.close(); } catch (_) {}
    state.ws = null;
    state.backendBridge = false;
    _stopDemoMode();
    state.connected = false;
    state.flying = false;
    state.streaming = false;
    state.liveDetections = [];
    _setConnStatus('disconnected');
    _stopRealFeed();
    _clearFeedCanvas();
    _hideFeedPlaceholder(false);
    _updateControlStates();
    _renderLiveDetections();
    Log.sys('telloLog', 'Disconnected');
  }

  function cmd(command) {
    const parts = String(command || '').trim().split(/\s+/);
    const name = parts[0];
    const value = parseInt(parts[1] || '30', 10);
    if (!name) return;
    if (name === 'takeoff') return takeoff();
    if (name === 'land') return land();
    if (name === 'emergency') return emergency();
    if (['forward', 'back', 'left', 'right', 'up', 'down'].includes(name)) return move(name, value);
    if (['cw', 'ccw'].includes(name)) return rotate(name, value);
    _send({ cmd: name, value });
  }

  async function takeoff() {
    if (!state.connected) return Toast.warn('Connect Tello first');
    if (state.flying) return Toast.info('Already airborne');
    if (!state.demoMode) {
      await _send({ cmd: 'command' });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const ok = await _send({ cmd: 'takeoff' });
    if (!ok) return Toast.error('Takeoff command failed');
    state.flying = true;
    _updateControlStates();
    Log.ok('telloLog', 'Takeoff command accepted');
  }

  async function land() {
    if (!state.connected) return Toast.warn('Connect Tello first');
    const ok = await _send({ cmd: 'land' });
    if (!ok) return Toast.error('Land command failed');
    state.flying = false;
    _updateControlStates();
    Log.ok('telloLog', 'Land command accepted');
  }

  async function emergency() {
    state.flying = false;
    await _send({ cmd: 'emergency' });
    _updateControlStates();
    Log.error('telloLog', 'Emergency stop sent');
  }

  async function move(direction, distance) {
    if (!state.connected) return Toast.warn('Connect Tello first');
    if (!state.flying) return Toast.warn('Take off first');
    const ok = await _send({ cmd: direction, distance: distance || 30 });
    if (ok) Log.info('telloLog', `Move ${direction} ${distance || 30} cm accepted`);
  }

  async function rotate(direction, degrees) {
    if (!state.connected) return Toast.warn('Connect Tello first');
    const ok = await _send({ cmd: direction, degrees: degrees || 45 });
    if (ok) Log.info('telloLog', `Rotate ${direction} ${degrees || 45} deg accepted`);
  }

  async function flip(direction) {
    if (!state.connected || !state.flying) return Toast.warn('Take off first');
    await _send({ cmd: 'flip', direction: direction || 'f' });
  }

  function setSpeed(speed) {
    _send({ cmd: 'speed', speed: speed || 30 });
  }

  async function startStream() {
    if (!state.connected) return Toast.warn('Connect Tello first');
    const ok = await _send({ cmd: 'streamon' });
    if (!ok && !state.demoMode) return Toast.error('Tello stream command failed');
    state.streaming = true;
    _hideFeedPlaceholder(true);
    _setLiveBadge(true);
    if (state.demoMode) {
      _startDemoFeed();
    } else if (state.backendBridge) {
      state.liveDetections = [];
      _renderLiveDetections();
      _clearFeedCanvas();
      _startRealFeed();
    }
    Log.ok('telloLog', state.demoMode ? 'Demo video stream started' : 'Tello stream command sent');
  }

  async function stopStream() {
    state.streaming = false;
    await _send({ cmd: 'streamoff' });
    _hideFeedPlaceholder(false);
    _setLiveBadge(false);
    if (state.demoFeedTimer) clearInterval(state.demoFeedTimer);
    state.demoFeedTimer = null;
    _stopRealFeed();
    _clearFeedCanvas();
    Log.info('telloLog', 'Video stream stopped');
  }

  function setBbox(enabled) {
    state.detectOverlay = !!enabled;
    Utils.el('bboxToggleOn')?.classList.toggle('active', state.detectOverlay);
    Utils.el('bboxToggleOff')?.classList.toggle('active', !state.detectOverlay);
    if (state.demoMode) _drawDemoFeed();
    Log.info('telloLog', 'Bbox overlay ' + (state.detectOverlay ? 'on' : 'off'));
  }

  function toggleDetectOverlay() {
    setBbox(!state.detectOverlay);
  }

  async function startMission() {
    if (!state.connected) return Toast.warn('Connect Tello first');
    const rows = parseInt(Utils.el('missionRows')?.value || Utils.el('missionRows2')?.value || '3', 10);
    const cols = parseInt(Utils.el('missionCols')?.value || Utils.el('missionCols2')?.value || '4', 10);
    const alt = parseInt(Utils.el('missionAlt')?.value || Utils.el('missionAlt2')?.value || '150', 10);
    Log.ok('telloLog', `Mission started: ${rows} x ${cols}, altitude ${alt} cm`);
    if (!state.flying) await takeoff();
    if (!state.streaming) await startStream();
  }

  function stopMission() {
    Log.warn('telloLog', 'Mission stopped');
  }

  function startSimFlight() {
    _enterDemoMode();
    takeoff();
  }

  function initKeyboard() {
    if (state.keyboardReady) return;
    state.keyboardReady = true;
    document.addEventListener('keydown', (e) => {
      if (!state.connected || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      const map = {
        w: 'forward 30', s: 'back 30', a: 'left 30', d: 'right 30',
        ArrowUp: 'up 30', ArrowDown: 'down 30', ArrowLeft: 'ccw 30', ArrowRight: 'cw 30',
      };
      if (map[e.key]) {
        e.preventDefault();
        cmd(map[e.key]);
      }
    });
  }

  async function _send(payload) {
    if (state.demoMode) {
      _handleDemoCommand(payload);
      return true;
    }
    if (state.backendBridge) {
      try {
        const response = await fetch('/api/tello/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
        });
        const data = await response.json();
        if (data.success) {
          Log.ok('telloLog', `Tello: ${data.command || payload.cmd} -> ${data.response}`);
          return true;
        }
        Log.error('telloLog', `Tello command failed: ${data.command || payload.cmd} -> ${data.response || data.error || 'no response'}`);
        return false;
      } catch (err) {
        Log.error('telloLog', 'Tello command failed: ' + (err.message || err));
        return false;
      }
    }
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      Log.warn('telloLog', 'No bridge connection');
      return false;
    }
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function _handleMessage(msg) {
    if (msg.type === 'telemetry') return _parseTelemetry(msg.data || msg);
    if (msg.type === 'frame') return _renderFrame(msg.data || msg.frame);
    if (msg.type === 'detections') {
      state.liveDetections = msg.data || [];
      _renderLiveDetections();
      return;
    }
    if (msg.type === 'response') return Log.ok('telloLog', 'Tello: ' + msg.data);
    if (msg.type === 'error') return Log.error('telloLog', msg.data || msg.message || 'Tello error');
    Log.info('telloLog', JSON.stringify(msg));
  }

  function _parseTelemetry(data) {
    if (!data) return;
    Object.assign(state.telemetry, {
      battery: data.bat ?? data.battery ?? state.telemetry.battery,
      altitude: data.h ?? data.altitude ?? state.telemetry.altitude,
      speed: data.vgx ?? data.speed ?? state.telemetry.speed,
      temp: data.temph ?? data.temp ?? state.telemetry.temp,
      yaw: data.yaw ?? state.telemetry.yaw,
      pitch: data.pitch ?? state.telemetry.pitch,
      roll: data.roll ?? state.telemetry.roll,
      flightTime: data.time ?? data.flightTime ?? state.telemetry.flightTime,
    });
    _updateTelemetryUI();
    if (typeof TelloLiveChart !== 'undefined') {
      TelloLiveChart.push(state.telemetry.altitude, state.telemetry.battery);
    }
  }

  function _updateTelemetryUI() {
    const t = state.telemetry;
    Utils.setText('t-battery', t.battery ? `${t.battery}%` : '-');
    Utils.setText('t-height', `${t.altitude || 0} cm`);
    Utils.setText('t-speed', `${t.speed || 0} cm/s`);
    Utils.setText('t-temp', t.temp ? `${t.temp} C` : '-');
    Utils.setText('t-time', `${t.flightTime || 0}s`);
    Utils.setText('tel-battery', t.battery ? `${t.battery}%` : '-');
    Utils.setText('tel-altitude', `${t.altitude || 0} cm`);
    Utils.setText('tel-speed', `${t.speed || 0} cm/s`);
    Utils.setText('tel-temp', t.temp ? `${t.temp} C` : '-');
    Utils.setText('tel-time', `${t.flightTime || 0}s`);
  }

  function _startTelemetryPoll() {
    if (state.telemetryTimer) clearInterval(state.telemetryTimer);
    state.telemetryTimer = setInterval(() => {
      if (state.connected && !state.demoMode) _send({ cmd: 'get_telemetry' });
    }, 700);
  }

  function _startStatusPoll() {
    if (state.telemetryTimer) clearInterval(state.telemetryTimer);
    let t = 0;
    state.telemetryTimer = setInterval(async () => {
      if (!state.connected || !state.backendBridge) return;
      if (state.statusBusy) return;
      state.statusBusy = true;
      t += 1;
      try {
        const res = await fetch('/api/tello/status');
        const data = await res.json();
        if (data.connected) {
          _parseTelemetry({
            bat: data.battery ?? state.telemetry.battery,
            h: data.height ?? state.telemetry.altitude,
            vgx: data.speed ?? state.telemetry.speed,
            temph: data.temp ?? state.telemetry.temp,
            time: data.flight_time ?? t
          });
        } else {
          Log.warn('telloLog', 'Tello status lost; check Wi-Fi connection.');
        }
      } catch (err) {
        Log.warn('telloLog', 'Tello status unavailable: ' + (err.message || err));
      } finally {
        state.statusBusy = false;
      }
    }, 7000);
  }

  function _enterDemoMode() {
    try { if (state.ws) state.ws.close(); } catch (_) {}
    state.ws = null;
    state.demoMode = true;
    state.backendBridge = false;
    state.statusBusy = false;
    state.connected = true;
    state.streaming = true;
    _setConnStatus('connected');
    _hideFeedPlaceholder(true);
    _setLiveBadge(true);
    _updateControlStates();
    _startDemoTelemetry();
    _startDemoFeed();
    Log.warn('telloLog', 'Manual demo mode started. This is not the real Tello feed.');
    Toast.info('Demo mode started');
  }

  function _stopDemoMode() {
    state.demoMode = false;
    if (state.demoFeedTimer) clearInterval(state.demoFeedTimer);
    if (state.demoTelemetryTimer) clearInterval(state.demoTelemetryTimer);
    state.demoFeedTimer = null;
    state.demoTelemetryTimer = null;
  }

  function _startRealFeed() {
    _stopRealFeed();
    let waitingLogged = false;
    const pull = async () => {
      if (!state.streaming || !state.backendBridge || state.demoMode) return;
      if (state.realFeedBusy) return;
      state.realFeedBusy = true;
      try {
        const res = await fetch('/api/tello/video_snapshot?t=' + Date.now(), { cache: 'no-store' });
        if (res.status === 202) {
          if (!waitingLogged) {
            waitingLogged = true;
            Log.info('telloLog', 'Waiting for first real Tello video frame...');
          }
          return;
        }
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          Log.warn('telloLog', data.error || 'Real Tello video frame unavailable');
          return;
        }
        const blob = await res.blob();
        const img = new Image();
        const objectUrl = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          if (!state.streaming || state.demoMode) return;
          state.frameCanvas.width = img.width || 960;
          state.frameCanvas.height = img.height || 540;
          state.rawFrameCanvas.width = state.frameCanvas.width;
          state.rawFrameCanvas.height = state.frameCanvas.height;
          state.rawFrameCtx.drawImage(img, 0, 0);
          state.frameCtx.drawImage(img, 0, 0);
          _maybeAutoInspectLiveFrame();
          if (state.detectOverlay) _drawDetectionOverlay();
        };
        img.onerror = () => URL.revokeObjectURL(objectUrl);
        img.src = objectUrl;
      } catch (err) {
        Log.warn('telloLog', 'Real Tello video fetch failed: ' + (err.message || err));
      } finally {
        state.realFeedBusy = false;
      }
    };
    pull();
    state.realFeedTimer = setInterval(pull, 180);
    Log.info('telloLog', 'Reading real Tello video frames from backend stream bridge...');
  }

  function _stopRealFeed() {
    if (state.realFeedTimer) clearInterval(state.realFeedTimer);
    state.realFeedTimer = null;
    state.realFeedBusy = false;
  }

  function _clearFeedCanvas() {
    if (!state.frameCanvas || !state.frameCtx) return;
    const W = state.frameCanvas.width || 960;
    const H = state.frameCanvas.height || 540;
    state.frameCanvas.width = W;
    state.frameCanvas.height = H;
    state.frameCtx.clearRect(0, 0, W, H);
  }

  function _realConnectFailed(reason) {
    state.backendBridge = false;
    state.demoMode = false;
    state.connected = false;
    state.flying = false;
    state.streaming = false;
    try { if (state.ws) state.ws.close(); } catch (_) {}
    state.ws = null;
    _stopDemoMode();
    _stopRealFeed();
    _clearFeedCanvas();
    _setConnStatus('disconnected');
    _hideFeedPlaceholder(false);
    _setLiveBadge(false);
    _updateControlStates();
    Log.error('telloLog', reason + ' Real Tello requires Wi-Fi connected to TELLO-* and UDP access to 192.168.10.1:8889.');
    Toast.error('Real Tello not reachable');
  }

  function _startDemoTelemetry() {
    if (state.demoTelemetryTimer) clearInterval(state.demoTelemetryTimer);
    let bat = 88;
    let t = 0;
    state.demoTelemetryTimer = setInterval(() => {
      t += 1;
      bat = Math.max(15, bat - 0.04);
      _parseTelemetry({
        bat: Math.round(bat),
        h: state.flying ? 145 + Math.round(Math.sin(t / 4) * 8) : 0,
        vgx: state.flying ? 12 : 0,
        temph: 29,
        yaw: Math.round(Math.sin(t / 6) * 45),
        pitch: state.flying ? 2 : 0,
        roll: state.flying ? -1 : 0,
        time: t,
      });
    }, 700);
  }

  function _startDemoFeed() {
    if (state.demoFeedTimer) clearInterval(state.demoFeedTimer);
    _drawDemoFeed();
    state.demoFeedTimer = setInterval(_drawDemoFeed, 1000);
  }

  function _drawDemoFeed() {
    if (!state.frameCanvas || !state.frameCtx || !state.streaming) return;
    const canvas = state.frameCanvas;
    const ctx = state.frameCtx;
    const W = canvas.width = 960;
    const H = canvas.height = 540;
    const tick = Date.now() / 1000;
    ctx.fillStyle = '#8b6b3e';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#4f8a3c';
    for (let i = 0; i < 15; i++) {
      ctx.globalAlpha = 0.26;
      ctx.fillRect((i * 88 + tick * 16) % (W + 100) - 100, 0, 48, H);
    }
    ctx.globalAlpha = 1;
    const rows = 4, cols = 6, gap = 16, pw = 116, ph = 70;
    const startX = 92 + Math.sin(tick / 3) * 16;
    const startY = 72 + Math.cos(tick / 4) * 10;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = startX + c * (pw + gap);
        const y = startY + r * (ph + gap);
        ctx.fillStyle = '#123b66';
        ctx.fillRect(x, y, pw, ph);
        ctx.strokeStyle = 'rgba(255,255,255,.62)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, pw, ph);
        ctx.strokeStyle = 'rgba(255,255,255,.22)';
        for (let s = 1; s < 4; s++) {
          ctx.beginPath();
          ctx.moveTo(x + s * pw / 4, y + 6);
          ctx.lineTo(x + s * pw / 4, y + ph - 6);
          ctx.stroke();
        }
      }
    }
    state.liveDetections = state.detectOverlay ? [
      { class: 'soiling', confidence: 0.82, priority: 'High', bbox: [210, 130, 362, 230], bbox_format: 'xyxy' },
      { class: 'bird_dropping', confidence: 0.64, priority: 'Medium', bbox: [562, 276, 700, 352], bbox_format: 'xyxy' },
    ] : [];
    _renderLiveDetections();
    if (state.detectOverlay) _drawDetectionOverlay();
  }

  function _renderFrame(base64Data) {
    if (!state.frameCtx || !state.frameCanvas || !base64Data) return;
    const img = new Image();
    img.onload = () => {
      state.frameCanvas.width = img.width || 960;
      state.frameCanvas.height = img.height || 540;
      state.rawFrameCanvas.width = state.frameCanvas.width;
      state.rawFrameCanvas.height = state.frameCanvas.height;
      state.rawFrameCtx.drawImage(img, 0, 0);
      state.frameCtx.drawImage(img, 0, 0);
      if (state.detectOverlay) _drawDetectionOverlay();
      if (!state.demoMode) _maybeAutoInspectLiveFrame();
    };
    img.src = base64Data.startsWith('data:') ? base64Data : 'data:image/jpeg;base64,' + base64Data;
  }

  function _drawDetectionOverlay() {
    const ctx = state.frameCtx;
    if (!ctx) return;
    const colors = { Critical: '#ef4444', High: '#f97316', Medium: '#eab308', Low: '#22c55e' };
    state.liveDetections.forEach(d => {
      const [x1, y1, x2, y2] = d.bbox || [0, 0, 0, 0];
      const w = d.bbox_format === 'xyxy' ? Math.max(1, x2 - x1) : x2;
      const h = d.bbox_format === 'xyxy' ? Math.max(1, y2 - y1) : y2;
      const color = colors[d.priority] || '#f59e0b';
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x1, y1, w, h);
      const label = `${String(d.class || 'defect').replace(/_/g, ' ')} ${Math.round((d.confidence || 0) * 100)}%`;
      ctx.font = 'bold 13px Inter, sans-serif';
      const labelW = ctx.measureText(label).width + 10;
      ctx.fillStyle = color;
      ctx.fillRect(x1, Math.max(0, y1 - 22), labelW, 22);
      ctx.fillStyle = '#111827';
      ctx.fillText(label, x1 + 5, Math.max(15, y1 - 6));
    });
  }

  function _canvasBlob(canvas, type = 'image/jpeg', quality = 0.94) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
  }

  async function inspectFrame() {
    return _inspectLiveFrame(true);
  }

  function _maybeAutoInspectLiveFrame() {
    const now = Date.now();
    if (state.flying) return;
    if (state.liveInspectBusy || now - state.lastAutoInspectAt < 18000) return;
    state.lastAutoInspectAt = now;
    _inspectLiveFrame(false);
  }

  async function _inspectLiveFrame(saveResult) {
    const now = Date.now();
    const minGap = saveResult ? 500 : 18000;
    if (!state.frameCanvas) return;
    if (state.liveInspectBusy) {
      if (saveResult) Toast.info('Finishing previous inspection, try again in a moment');
      return;
    }
    if (!saveResult && now - state.lastLiveInspectAt < minGap) return;
    state.liveInspectBusy = true;
    state.lastLiveInspectAt = now;
    try {
      const inspectCanvas = state.rawFrameCanvas && state.rawFrameCanvas.width
        ? state.rawFrameCanvas
        : state.frameCanvas;
      const blob = await _canvasBlob(inspectCanvas);
      if (!blob) return;
      const fd = new FormData();
      fd.append('frame', blob, 'tello-frame.jpg');
      const panelId = saveResult && typeof Session !== 'undefined' && Session.nextPanelId
        ? Session.nextPanelId()
        : 'P' + String(((Session?.getAll?.().length || 0) % 40) + 1).padStart(2, '0');
      fd.append('panel_id', panelId);
      fd.append('model', document.querySelector('input[name="tmodel"]:checked')?.value || 'yolov26');
      fd.append('conf', Utils.el('telloConfSlider')?.value || '0.25');
      const res = await fetch('/api/tello_frame', { method: 'POST', body: fd });
      const result = await res.json();
      if (!result.success) return;
      result.source = 'Live Tello';
      state.liveDetections = result.detections || state.liveDetections;
      _renderLiveDetections();
      if (state.detectOverlay && state.frameCanvas && state.frameCtx && state.rawFrameCanvas?.width) {
        state.frameCtx.drawImage(state.rawFrameCanvas, 0, 0);
        _drawDetectionOverlay();
      }
      if (saveResult && typeof Session !== 'undefined') {
        Session.addInspection(result);
        state.lastLiveStoreAt = now;
      }
      if (saveResult && typeof broadcastResult === 'function') broadcastResult(result);
      if (saveResult) Toast.success('Live frame inspection saved');
    } catch (err) {
      Log.warn('telloLog', 'Live frame inspection skipped: ' + (err.message || err));
    } finally {
      state.liveInspectBusy = false;
    }
  }

  function _renderLiveDetections() {
    const list = Utils.el('liveDetectionsList');
    if (!list) return;
    const dets = state.liveDetections || [];
    if (!dets.length) {
      list.innerHTML = '<span class="empty-state-mini">No live detections</span>';
      return;
    }
    list.innerHTML = dets.slice(0, 10).map(d => `<div class="live-det-item ${d.priority || 'Low'}"><span style="font-weight:700">${String(d.class || 'defect').replace(/_/g, ' ')}</span><span class="priority-pill ${d.priority || 'Low'}" style="font-size:.6rem">${d.priority || 'Low'}</span><span style="color:var(--dark-4)">${Math.round((d.confidence || 0) * 100)}%</span></div>`).join('');
  }

  function _handleDemoCommand(payload) {
    const raw = String(payload?.cmd || '').toLowerCase();
    if (raw === 'takeoff') state.flying = true;
    if (raw === 'land' || raw === 'emergency') state.flying = false;
    if (raw === 'streamon') state.streaming = true;
    if (raw === 'streamoff') state.streaming = false;
    _hideFeedPlaceholder(!state.streaming);
    _setLiveBadge(state.streaming);
    _updateControlStates();
    Log.ok('telloLog', 'Demo command: ' + raw);
  }

  function _hideFeedPlaceholder(hide) {
    Utils.el('liveFeedPlaceholder')?.classList.toggle('hidden', !!hide);
  }

  function _setLiveBadge(show) {
    const badge = Utils.el('liveOverlayBadge') || Utils.el('liveBadge');
    if (badge) badge.style.display = show ? '' : 'none';
  }

  function _setConnStatus(status) {
    const labels = {
      connected: state.demoMode ? 'Demo Connected' : state.backendBridge ? 'Real Tello Connected' : 'Connected',
      connecting: 'Connecting...',
      disconnected: 'Disconnected',
    };
    const label = labels[status] || labels.disconnected;
    Utils.setText('t-status', ' ' + label);
    Utils.setText('telloStatusBadge', ' ' + label);
    const badge = Utils.el('telloStatusBadge');
    if (badge) {
      badge.classList.toggle('connected', status === 'connected');
      badge.classList.toggle('connecting', status === 'connecting');
    }
    [Utils.el('btnConnectTello'), Utils.el('btnConnectTello2'), Utils.el('btnConnect')].filter(Boolean).forEach(btn => {
      btn.textContent = status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting...' : 'Connect Tello';
      btn.disabled = status === 'connecting';
    });
  }

  function _updateControlStates() {
    document.querySelectorAll('.fc-btn').forEach(btn => {
      const text = btn.textContent.toLowerCase();
      if (text.includes('takeoff')) btn.disabled = !state.connected || state.flying;
      else if (text.includes('land')) btn.disabled = !state.connected;
      else btn.disabled = !state.connected;
    });
  }

  return {
    init, connect, disconnect, cmd,
    takeoff, land, emergency, move, rotate, flip, setSpeed,
    startStream, stopStream, setBbox, toggleDetectOverlay, inspectFrame,
    startMission, stopMission, startSimFlight, initKeyboard,
  };
})();

window.TelloApp = TelloApp;
window.Tello = TelloApp;

document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('page-tello')) {
    TelloApp.init();
    TelloApp.initKeyboard();
  }
});
