// Explicit opt-in capture controls. Uses the shipped renderer and world assets.

// Capture the normal requestAnimationFrame loop against real elapsed time.

export function installShowcase(w, diagnostics) {
  const shots = [
    { name: "Woodland path", route: 0, anchor: [0, 50], hour: 9.2 },

    { name: "Meadow trail", route: 1, anchor: [85, -45], hour: 13.4 },

    { name: "Towards the river", route: 2, anchor: [-180, -130], hour: 17.0 },

    { name: "Lanterns after dark", route: 0, anchor: [0, 50], hour: 0.7 },
  ];

  const panel = document.createElement("section");

  panel.id = "showcase";

  panel.style.cssText =
    "position:fixed;z-index:10000;left:16px;top:16px;padding:14px;background:#10251eee;color:white;font:13px system-ui;max-width:450px";

  panel.innerHTML =
    "<strong>HD showcase · 2 minutes</strong><p>Four 30-second path walks · 1920 × 1080 · 30 fps<br>Real-time capture · live walking and streaming.</p>";

  const select = document.createElement("select");

  shots.forEach((shot, i) => select.add(new Option(shot.name, String(i))));

  panel.append(select);

  const preview = document.createElement("button");
  preview.textContent = "Preview selected walk";
  panel.append(preview);

  const record = document.createElement("button");
  record.textContent = "Record 30-second chapter";
  panel.append(record);

  const status = document.createElement("pre");
  status.id = "showcase-status";
  panel.append(status);

  const download = document.createElement("a");
  download.textContent = "Download chapter";
  download.hidden = true;
  panel.append(download);

  document.body.append(panel);

  let base = performance.now() / 1000,
    busy = false,
    url;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const tracks = shots.map((shot) => {
    const path = w.routes[shot.route],
      lengths = [0];

    for (let i = 1; i < path.length; i++)
      lengths.push(
        lengths.at(-1) +
          Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]),
      );

    let nearest = 0;

    path.forEach((p, i) => {
      if (
        Math.hypot(p[0] - shot.anchor[0], p[1] - shot.anchor[1]) <
        Math.hypot(
          path[nearest][0] - shot.anchor[0],
          path[nearest][1] - shot.anchor[1],
        )
      )
        nearest = i;
    });

    return {
      path,
      lengths,
      start: Math.min(lengths[nearest], lengths.at(-1) - 85),
    };
  });

  function sample(track, d) {
    d = Math.max(0, Math.min(d, track.lengths.at(-1)));

    let i = 1;
    while (i < track.lengths.length - 1 && track.lengths[i] < d) i++;

    const t =
        (d - track.lengths[i - 1]) /
        (track.lengths[i] - track.lengths[i - 1] || 1),
      a = track.path[i - 1],
      b = track.path[i];

    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }

  function pose(id, t) {
    const track = tracks[id],
      d = track.start + t * 54,
      [x, z] = sample(track, d),
      [tx, tz] = sample(track, d + 13);

    const y = w.terrainCameraFloor(x, z) + 0.04,
      heading = Math.atan2(tx - x, tz - z) + Math.sin(t * Math.PI * 2) * 0.13;

    w.camera.position.set(x, y, z);

    w.camera.lookAt(
      x + Math.sin(heading) * 18,
      y + 0.1,
      z + Math.cos(heading) * 18,
    );
    w.camera.updateMatrixWorld();
  }

  function setup(id) {
    w.capture.pause();
    w.capture.resize(1920, 1080);
    w.controls.enabled = false;
    w.controls.update = () => {};

    document.body.classList.add("exploring");

    w.capture.setHour(shots[id].hour);

    const torch = document.querySelector("#torch");
    if (torch.checked !== (id === 3)) torch.click();
  }

  async function settle(id, t) {
    pose(id, t);
    let stable = 0;
    const start = performance.now();

    while (performance.now() - start < 180000) {
      w.capture.render(base);
      base += 1 / 30;
      await delay(50);

      const p = diagnostics.preparation;

      if (
        !diagnostics.baking &&
        !p?.renderer?.pending &&
        !p?.uploads?.pendingBytes &&
        !diagnostics.treeStreaming?.pending &&
        !diagnostics.grassStreaming?.active &&
        !diagnostics.grassStreaming?.queued
      )
        stable++;
      else stable = 0;

      status.textContent = `Preparing ${shots[id].name}\n${Math.round((performance.now() - start) / 1000)} seconds · ${Math.round(t * 100)}% along path`;

      if (stable > 10) return;
    }

    throw Error("World preparation did not settle; recording stopped.");
  }

  async function run(capture) {
    if (busy) return;
    busy = true;
    preview.disabled = record.disabled = select.disabled = true;

    try {
      const id = Number(select.value);
      setup(id);

      await settle(id, 0); // Settle the starting view only; the walk streams live.

      if (!capture) {
        status.textContent = "Preview ready · path centre, walking height";
        return;
      }

      const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8"].find(
        (type) => MediaRecorder.isTypeSupported(type),
      );

      if (!mimeType)
        throw Error("HD live video capture is unavailable in this browser.");

      const chunks = [],
        stream = w.renderer.domElement.captureStream(30);

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 16000000,
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };

      let failure;

      const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
      });

      recorder.onerror = (e) => {
        failure = e.error || Error("Recording failed");
      };

      w.capture.resume();

      const started = performance.now();
      let last = started,
        maxFrame = 0,
        frames = 0;

      recorder.start(1000);

      try {
        while (performance.now() - started < 30000) {
          const now = await new Promise(requestAnimationFrame);

          maxFrame = Math.max(maxFrame, now - last);
          last = now;
          frames++;

          pose(id, Math.min(1, (now - started) / 30000));

          status.textContent = `Recording live · ${shots[id].name}\n${Math.floor((now - started) / 1000)} / 30 seconds`;

          if (failure) throw failure;
        }
      } finally {
        if (recorder.state !== "inactive") recorder.stop();

        await stopped;
        stream.getTracks().forEach((track) => track.stop());

        w.capture.pause();
      }

      if (failure) throw failure;

      if (url) URL.revokeObjectURL(url);

      url = URL.createObjectURL(new Blob(chunks, { type: mimeType }));
      download.href = url;
      download.download = `BakedVoxelLighting-live-chapter-${id + 1}.webm`;
      download.hidden = false;

      status.textContent = JSON.stringify(
        {
          completed: true,
          live: true,
          chapter: id + 1,
          name: shots[id].name,
          animationFrames: frames,
          maxFrameMs: maxFrame,
          width: 1920,
          height: 1080,
          elapsedSeconds: (performance.now() - started) / 1000,
          source: location.href,
          errors: diagnostics.errors,
        },
        null,
        2,
      );

      base += 30;
    } catch (error) {
      status.textContent = String(error.stack || error);
    } finally {
      busy = false;
      preview.disabled = record.disabled = select.disabled = false;
    }
  }

  preview.onclick = () => run(false);
  record.onclick = () => run(true);

  status.textContent = "Choose a chapter, preview, then record.";
}
