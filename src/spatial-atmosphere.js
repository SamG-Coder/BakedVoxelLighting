import { AmbienceEcology } from "./ambience-ecology.js";
import workletURL from "./ambience-worklet.js?worker&url";
import { terrainSample } from "./terrain-field.js";
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
function param(p, v, t, smooth = 0.06) {
  p.setTargetAtTime(v, t, smooth);
}
function position(p, x, y, z, t) {
  param(p.positionX, x, t);
  param(p.positionY, y, t);
  param(p.positionZ, z, t);
}
export function createSpatialAtmosphere(camera, onStatus = () => {}) {
  let context,
    node,
    master,
    initializing,
    muteTimer,
    disposed = false,
    enabled = false,
    userMuted = false;
  let volume = 0.6,
    lastUpdate = -Infinity,
    lastEnvironment = -Infinity;
  const ecology = new AmbienceEcology(terrainSample);
  const panners = [],
    filters = [],
    nodes = [],
    until = new Float64Array(6);
  const environment = { type: "environment", levels: new Float32Array(4) };
  const bird = {
    type: "bird",
    slot: 0,
    kind: 0,
    pitch: 1,
    duration: 2,
    seed: 1,
  };
  const stats = {
    state: "off",
    enabled: false,
    volume,
    voices: 0,
    birdCalls: 0,
    replies: 0,
    lastSound: null,
    territory: null,
    member: null,
    riverDistance: null,
    habitat: "open",
    error: null,
    buses: 10,
  };
  const notify = () => {
    stats.enabled = enabled;
    stats.volume = volume;
    onStatus(stats);
  };
  async function initialize() {
    if (context) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) throw Error("Web Audio is unavailable in this browser");
    context = new Audio({ latencyHint: "interactive" });
    // Resume is invoked in the click/key gesture, before awaiting worklet loading.
    const resumed = context.resume();
    await context.audioWorklet.addModule(workletURL);
    if (disposed) return;
    node = new AudioWorkletNode(context, "woodland-atmosphere", {
      numberOfInputs: 0,
      numberOfOutputs: 10,
      outputChannelCount: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    });
    node.onprocessorerror = () => {
      stats.error = "Atmosphere audio stopped";
      stats.state = "error";
      enabled = false;
      notify();
    };
    master = context.createGain();
    master.gain.value = 0;
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -12;
    limiter.knee.value = 18;
    limiter.ratio.value = 5;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.2;
    master.connect(limiter);
    limiter.connect(context.destination);
    nodes.push(node, master, limiter);
    for (let i = 0; i < 10; i++) {
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = i < 6 ? 7000 : i < 8 ? 3400 : 6000;
      filters.push(filter);
      node.connect(filter, i);
      if (i < 8) {
        const p = context.createPanner();
        p.panningModel = "HRTF";
        p.distanceModel = "inverse";
        p.refDistance = i < 6 ? 9 : 12;
        p.rolloffFactor = 1.35;
        // maxDistance clamps attenuation rather than silencing a source. Keep
        // it beyond the map so old calls cannot retain a loudness floor in flight.
        p.maxDistance = 10000;
        filter.connect(p);
        p.connect(master);
        panners.push(p);
        nodes.push(filter, p);
      } else {
        const p = context.createStereoPanner();
        p.pan.value = i === 8 ? -0.7 : 0.7;
        filter.connect(p);
        p.connect(master);
        nodes.push(filter, p);
      }
    }
    await resumed;
    lastEnvironment = -Infinity;
    lastUpdate = -Infinity;
  }
  async function start() {
    if (disposed) return;
    clearTimeout(muteTimer);
    stats.error = null;
    enabled = true;
    userMuted = false;
    stats.state = "starting";
    notify();
    try {
      if (!initializing) initializing = initialize();
      await initializing;
      if (disposed || !enabled) return;
      if (!document.hidden) await context.resume();
      param(master.gain, volume, context.currentTime, 0.18);
      stats.state = context.state;
      notify();
    } catch (e) {
      stats.error = String(e.message || e);
      stats.state = "error";
      enabled = false;
      for (const n of nodes) n.disconnect();
      nodes.length = panners.length = filters.length = 0;
      context?.close().catch(() => {});
      context = node = master = initializing = undefined;
      notify();
    }
  }
  function mute() {
    enabled = false;
    userMuted = true;
    stats.state = "muted";
    if (master) param(master.gain, 0, context.currentTime, 0.06);
    clearTimeout(muteTimer);
    muteTimer = setTimeout(() => {
      if (!enabled && context && !disposed) context.suspend().catch(() => {});
    }, 250);
    notify();
  }
  async function visibility() {
    if (!context || disposed) return;
    try {
      if (document.hidden) {
        await context.suspend();
      } else if (enabled) {
        await context.resume();
      }
      stats.state = enabled ? context.state : "muted";
      notify();
    } catch (e) {
      stats.error = String(e.message || e);
      notify();
    }
  }
  document.addEventListener("visibilitychange", visibility);
  function update(now, hour) {
    if (
      !node ||
      !enabled ||
      context.state !== "running" ||
      now - lastUpdate < 33
    )
      return;
    lastUpdate = now;
    const t = context.currentTime,
      p = camera.position,
      q = camera.quaternion,
      l = context.listener;
    // Quaternion rotates camera-local forward (0,0,-1) and up (0,1,0).
    position(l, p.x, p.y, p.z, t);
    param(l.forwardX, -2 * (q.x * q.z + q.w * q.y), t, 0.025);
    param(l.forwardY, -2 * (q.y * q.z - q.w * q.x), t, 0.025);
    param(l.forwardZ, -(1 - 2 * (q.x * q.x + q.y * q.y)), t, 0.025);
    param(l.upX, 2 * (q.x * q.y - q.w * q.z), t, 0.025);
    param(l.upY, 1 - 2 * (q.x * q.x + q.z * q.z), t, 0.025);
    param(l.upZ, 2 * (q.y * q.z + q.w * q.x), t, 0.025);
    if (now - lastEnvironment < 250) return;
    lastEnvironment = now;
    const land = terrainSample(p.x, p.z),
      canopy = clamp(Math.max(land.canopy, land.forest || 0), 0, 1);
    stats.habitat = canopy > 0.5 ? "woodland" : "open";
    const altitude = Math.max(0, p.y - land.height - 3),
      proximity = Math.exp(-altitude / 90);
    // River audio is disabled; no hydrology lookup or moving water emitters.
    environment.levels[0] = environment.levels[1] = 0;
    environment.levels[2] = (0.3 + canopy * 0.2) * proximity;
    environment.levels[3] = (0.34 + canopy * 0.24) * proximity;
    node.port.postMessage(environment);
    let voices = 0;
    for (let i = 0; i < 6; i++) if (until[i] > t) voices++;
    stats.voices = voices;
    if (altitude > 60) return;
    let slot = -1;
    for (let i = 0; i < 6; i++)
      if (until[i] <= t) {
        slot = i;
        break;
      }
    if (slot < 0) return;
    const job = ecology.next(t, p.x, p.y, p.z, hour);
    if (!job) return;
    // An idle voice can jump directly to a new resident; an active voice never follows the camera.
    panners[slot].positionX.cancelScheduledValues(t);
    panners[slot].positionY.cancelScheduledValues(t);
    panners[slot].positionZ.cancelScheduledValues(t);
    panners[slot].positionX.setValueAtTime(job.x, t);
    panners[slot].positionY.setValueAtTime(job.y, t);
    panners[slot].positionZ.setValueAtTime(job.z, t);
    const distance = Math.hypot(job.x - p.x, job.y - p.y, job.z - p.z);
    param(
      filters[slot].frequency,
      Math.max(2300, 7600 - distance * 65),
      t,
      0.12,
    );
    bird.slot = slot;
    bird.kind = job.kind;
    bird.pitch = job.pitch;
    bird.duration = job.duration;
    bird.seed = job.seed;
    node.port.postMessage(bird);
    until[slot] = t + bird.duration + 0.3;
    stats.birdCalls++;
    if (job.response) stats.replies++;
    stats.lastSound = job.kind;
    stats.territory = job.territory;
    stats.member = job.member;
  }

  function dispose() {
    disposed = true;
    clearTimeout(muteTimer);
    document.removeEventListener("visibilitychange", visibility);
    for (const n of nodes) n.disconnect();
    context?.close().catch(() => {});
  }
  return {
    stats,
    start,
    update,
    dispose,
    toggle() {
      return enabled ? mute() : start();
    },
    startOnExplore() {
      if (!userMuted) return start();
    },
    setVolume(value) {
      volume = clamp(value, 0, 1);
      if (master) param(master.gain, enabled ? volume : 0, context.currentTime);
      notify();
    },
  };
}
