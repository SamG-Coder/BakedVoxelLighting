// Menu work is event-driven; nothing is polled by the render loop.
export function installGameMenu({ start, pause, controls, ambience }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("settingsDialog");
  let session = false,
    mode = true;
  const preferenceKey = "bvl-game-settings-v1";
  let preferences = {};
  try {
    preferences = JSON.parse(localStorage.getItem(preferenceKey) || "{}");
  } catch {
    /* Private browsing or stale preferences must not prevent playing. */
  }
  if (!preferences || typeof preferences !== "object") preferences = {};
  const save = () => {
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(preferences));
    } catch {
      /* Settings still apply for this session if storage is unavailable. */
    }
  };
  for (const id of [
    "soundVolume",
    "sensitivity",
    "invertY",
    "showStats",
    "dayCycle",
  ]) {
    const input = $(id);
    if (input.type === "checkbox") {
      if (typeof preferences[id] === "boolean") input.checked = preferences[id];
    } else if (Number.isFinite(Number(preferences[id]))) {
      input.value = String(
        Math.max(
          Number(input.min),
          Math.min(Number(input.max), Number(preferences[id])),
        ),
      );
    }
    const apply = () => {
      preferences[id] =
        input.type === "checkbox" ? input.checked : Number(input.value);
      if (id === "sensitivity") {
        controls.sensitivity = Number(input.value);
        $("sensitivityValue").textContent =
          `${Number(input.value).toFixed(1)}×`;
      } else if (id === "invertY") controls.invertY = input.checked;
      else if (id === "showStats")
        document.body.classList.toggle("show-stats", input.checked);
      else if (id === "soundVolume")
        ambience.setVolume(Number(input.value) / 100);
    };
    apply();
    input.addEventListener(input.type === "range" ? "input" : "change", () => {
      apply();
      save();
    });
  }
  $("dayCycle").dispatchEvent(new Event("change"));
  const categories = Array.from(dialog.querySelectorAll("[data-category]"));
  function select(button) {
    for (const item of categories) {
      const active = item === button;
      item.setAttribute("aria-pressed", String(active));
      $("settings-" + item.dataset.category).hidden = !active;
    }
  }
  for (const button of categories) button.onclick = () => select(button);
  $("settingsOpen").onclick = () => {
    dialog.showModal();
    categories.find((b) => b.getAttribute("aria-pressed") === "true").focus();
  };
  $("settingsClose").onclick = () => dialog.close();
  dialog.addEventListener("close", () => $("settingsOpen").focus());
  function launch(walk, fresh = false) {
    mode = walk;
    $("menuMessage").textContent = "";
    if (dialog.open) dialog.close();
    start(walk, fresh);
  }
  $("explore").onclick = () => launch(true, true);
  $("fly").onclick = () => launch(false);
  $("resume").onclick = () => launch(mode);
  $("pauseGame").onclick = () => api.show();
  controls.enabled = false;
  for (const id of ["explore", "fly"]) $(id).disabled = true;
  const api = {
    ready() {
      for (const id of ["explore", "fly"]) $(id).disabled = false;
      $("loadingStatus").classList.add("ready");
    },
    captured() {
      session = true;
      $("resume").hidden = false;
      $("resume").textContent = mode ? "Resume walk" : "Resume flight";
      $("menuMessage").textContent = "";
    },
    show() {
      pause();
      document.body.classList.remove("exploring", "immersive");
      (session ? $("resume") : $("explore")).focus();
    },
  };
  return api;
}
