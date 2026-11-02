// Offscreen audio pipeline for tab volume boost. Created on demand by the
// background worker; lives only while at least one boost is active.
//
// One AudioContext, one chain per boosted tab:
//
//   tabCapture MediaStream -> MediaStreamAudioSourceNode -> GainNode (1.0–6.0)
//     -> DynamicsCompressorNode (soft limiter) -> AudioContext.destination
//
// Capture redirects the tab's audio into this graph — the tab itself goes
// quiet and its sound reaches the speakers only through the gain chain, at
// unity when boost is 100 % (which is why no pipeline is ever created at
// 100 %) and amplified above that. Everything stays on-device: nothing is
// recorded, buffered or sent anywhere.
//
// Gain changes adjust the existing GainNode (setTargetAtTime for a smooth,
// click-free ramp) and never restart the capture. Resetting to 100 % stops
// the stream's tracks and disconnects the chain; when the last boost goes,
// the AudioContext is closed and the document reports idle so the background
// can tear the document down.
//
// Cancellation: every start carries the worker's request id. A stop for a
// tab whose getUserMedia() is still in flight marks that request cancelled,
// so when the stream eventually resolves its tracks are stopped immediately
// and no graph is built — no orphaned capture, no leaked audio, no lingering
// recording indicator, no result that could resurrect a stopped boost.

const chains = new Map(); // tabId -> { stream, source, gain, limiter, onEnded }
const starting = new Map(); // tabId -> { reqId, cancelled } — gUM in flight
let ctx = null;

async function getCtx() {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  return ctx;
}

function send(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // extension context going away; nothing to report to
  }
}

function gainMultiplier(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, n / 100));
}

function stopTracks(stream) {
  for (const track of stream.getTracks()) track.stop();
}

async function start(msg) {
  const existing = chains.get(msg.tabId);
  if (existing) {
    // one pipeline per tab: a second start (stale click) only re-points gain
    setGain(existing, msg.gain);
    send({ type: 'mcp-boost-result', tabId: msg.tabId, ok: true, gain: msg.gain, reqId: msg.reqId });
    return;
  }
  if (starting.has(msg.tabId)) {
    // supersede the older attempt: its stream, if it ever resolves, is
    // dropped on the cancellation check below
    starting.get(msg.tabId).cancelled = true;
  }
  const req = { reqId: msg.reqId, cancelled: false };
  starting.set(msg.tabId, req);
  // true when this request is no longer the tab's live attempt
  const stale = () => req.cancelled || starting.get(msg.tabId) !== req;

  // consume the worker's one-time streamId — the documented flow for turning
  // tabCapture.getMediaStreamId output into a real MediaStream
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    });
  } catch (e) {
    if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
    if (!req.cancelled) {
      send({
        type: 'mcp-boost-result',
        tabId: msg.tabId,
        ok: false,
        error: String(e?.message ?? e),
        reqId: msg.reqId,
      });
    }
    return;
  }

  if (stale()) {
    // cancelled while getUserMedia() was in flight: release the capture
    // immediately and establish nothing
    stopTracks(stream);
    if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
    void maybeCloseCtx();
    return;
  }

  const nodes = []; // every node built for this attempt, for failure cleanup
  try {
    const context = await getCtx();
    // ownership after AudioContext initialization: a stop that arrived while
    // the context was starting must win
    if (stale()) {
      stopTracks(stream);
      if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
      void maybeCloseCtx();
      return;
    }
    const source = context.createMediaStreamSource(stream);
    nodes.push(source);
    const gain = context.createGain();
    nodes.push(gain);
    gain.gain.value = gainMultiplier(msg.gain);
    // soft limiter after the gain: tames the worst peaks at high boost —
    // this reduces, never eliminates, distortion at 400 %+ (documented)
    const limiter = context.createDynamicsCompressor();
    nodes.push(limiter);
    limiter.threshold.value = -6;
    limiter.knee.value = 2;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    source.connect(gain).connect(limiter).connect(context.destination);

    // last ownership check before the chain becomes visible: a stop that
    // arrived during graph construction wins
    if (stale()) {
      stopTracks(stream);
      disposeNodes(nodes);
      if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
      void maybeCloseCtx();
      return;
    }

    const onEnded = () => {
      chains.delete(msg.tabId);
      send({ type: 'mcp-boost-ended', tabId: msg.tabId });
    };
    for (const track of stream.getTracks()) track.addEventListener('ended', onEnded);

    // the chain remembers its request id: a delayed stop from an older
    // request can never tear down this pipeline
    chains.set(msg.tabId, { reqId: msg.reqId, stream, source, gain, limiter, onEnded });
    if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
    send({ type: 'mcp-boost-result', tabId: msg.tabId, ok: true, gain: msg.gain, reqId: msg.reqId });
  } catch (e) {
    // a half-built graph is never left behind: tracks stopped, every node
    // created so far disconnected, an unused context closed
    stopTracks(stream);
    disposeNodes(nodes);
    if (starting.get(msg.tabId) === req) starting.delete(msg.tabId);
    void maybeCloseCtx();
    if (!req.cancelled) {
      send({
        type: 'mcp-boost-result',
        tabId: msg.tabId,
        ok: false,
        error: String(e?.message ?? e),
        reqId: msg.reqId,
      });
    }
  }
}

function disposeNodes(nodes) {
  for (const n of nodes) {
    try {
      n.disconnect();
    } catch {
      // already disconnected
    }
  }
}

/** Close the shared context once no successful pipeline needs it. */
async function maybeCloseCtx() {
  if (chains.size) return;
  if (ctx) {
    await ctx.close().catch(() => {});
    ctx = null;
  }
}

function setGain(chain, pct) {
  if (!ctx) return;
  chain.gain.gain.setTargetAtTime(gainMultiplier(pct), ctx.currentTime, 0.05);
}

async function stop(tabId, reqId) {
  // cancel a pending getUserMedia for THIS request only: a delayed stop that
  // belongs to an older request must not touch a newer, restarted attempt
  const pendingReq = starting.get(tabId);
  if (pendingReq && (reqId === undefined || pendingReq.reqId === reqId)) {
    pendingReq.cancelled = true;
  }
  const chain = chains.get(tabId);
  if (!chain) {
    await maybeCloseCtx();
    return;
  }
  if (reqId !== undefined && chain.reqId !== reqId) {
    return; // a newer pipeline owns this tab
  }
  chains.delete(tabId);
  for (const track of chain.stream.getTracks()) {
    track.removeEventListener('ended', chain.onEnded);
    track.stop();
  }
  disposeNodes([chain.source, chain.gain, chain.limiter]);
  await maybeCloseCtx();
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;
  // ONLY offscreen-facing types are handled here. The popup's original
  // 'mcp-boost-*' broadcasts also reach this document; ignoring them is what
  // guarantees one capture attempt per stream id (the worker forwards
  // exactly one offscreen-start per tab).
  if (msg.type === 'mcp-boost-offscreen-start') void start(msg);
  else if (msg.type === 'mcp-boost-offscreen-gain') {
    const chain = chains.get(msg.tabId);
    if (chain) setGain(chain, msg.gain);
  } else if (msg.type === 'mcp-boost-offscreen-stop') void stop(msg.tabId, msg.reqId);
});
