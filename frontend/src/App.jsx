import { AnimatePresence, motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  Beaker,
  Martini,
  Search,
  Settings,
  ShieldAlert,
  Sparkles,
  Waves
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8000";
const WS_BASE = API_BASE.replace(/^http/, "ws");
const TAGS = ["classic", "sweet", "strong", "sour"];

const toImageUrl = (image) => {
  if (!image) return "";
  if (image.startsWith("http")) return image;
  if (image.startsWith("/")) return `${API_BASE}${image}`;
  return `${API_BASE}/assets/drinks/${image}`;
};

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

const resolveImageCandidates = (imagePath) => {
  if (!imagePath) return [];
  const normalized = imagePath.trim();
  if (!normalized) return [];
  const hasExt = /\.[a-z0-9]+$/i.test(normalized);
  if (hasExt) return [normalized];
  return IMAGE_EXTENSIONS.map((ext) => `${normalized}${ext}`);
};

function DrinkImage({ imagePath, name, className }) {
  const candidates = useMemo(() => resolveImageCandidates(imagePath), [imagePath]);
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [imagePath]);

  const currentCandidate = candidates[candidateIndex];
  const src = currentCandidate ? toImageUrl(currentCandidate) : "";

  if (!src) {
    return (
      <div className={`photo-missing flex items-center justify-center ${className}`}>
        <span className="px-3 text-center text-lg font-semibold uppercase tracking-wide drop-shadow-sm">
          Add photo
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={name}
      onError={() => {
        if (candidateIndex < candidates.length - 1) {
          setCandidateIndex((idx) => idx + 1);
        } else {
          setCandidateIndex(candidates.length);
        }
      }}
      className={className}
    />
  );
}

const makeEtaText = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "--";
  const rounded = Math.max(1, Math.round(seconds));
  const m = Math.floor(rounded / 60);
  const s = rounded % 60;
  if (!m) return `${s}s`;
  return `${m}m ${s}s`;
};

function App() {
  const [drinks, setDrinks] = useState([]);
  const [selectedDrink, setSelectedDrink] = useState(null);
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState("all");
  const [view, setView] = useState("home");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [statusText, setStatusText] = useState("Ready");
  const [errorText, setErrorText] = useState("");
  const [adminPumps, setAdminPumps] = useState([]);
  const [adminSavedAt, setAdminSavedAt] = useState("");
  const [calibrationSaving, setCalibrationSaving] = useState(false);
  const [progress, setProgress] = useState({
    runId: null,
    pct: 0,
    ingredient: "",
    etaSeconds: 0
  });

  const fetchDrinks = async () => {
    const res = await fetch(`${API_BASE}/api/drinks`);
    if (!res.ok) throw new Error("Failed to load drinks");
    const data = await res.json();
    setDrinks(data);
    if (data.length && !selectedDrink) {
      setSelectedDrink(data[0]);
    }
    return data;
  };

  const fetchConfig = async () => {
    const res = await fetch(`${API_BASE}/api/config`);
    if (!res.ok) return null;
    return res.json();
  };

  const toAdminPumps = (configData, drinkList) => {
    if (configData?.pumps?.length) {
      return configData.pumps.map((p) => ({
        pump: p.pump,
        gpio_pin: p.gpio_pin,
        ml_per_second: p.ml_per_second,
        enabled: p.enabled !== false
      }));
    }
    const discovered = new Set();
    for (const drink of drinkList) {
      for (const ingredient of drink.ingredients || []) {
        discovered.add(Number(ingredient.pump));
      }
    }
    return Array.from(discovered)
      .sort((a, b) => a - b)
      .map((pump) => ({ pump, gpio_pin: "-", ml_per_second: 0, enabled: true }));
  };

  const syncStatus = async () => {
    const res = await fetch(`${API_BASE}/api/status`);
    if (!res.ok) return;
    const data = await res.json();
    const state = data?.state ?? "idle";
    if (state === "mixing") {
      setBusy(true);
      setView("mixing");
      setStatusText("Mixing in progress");
      setProgress((prev) => ({
        ...prev,
        runId: data.run_id ?? prev.runId,
        pct: data.progress ?? prev.pct,
        ingredient: data.current_ingredient ?? prev.ingredient
      }));
      return;
    }
    if (state === "error") {
      setBusy(false);
      setErrorText(data.error || "Mixing failed.");
      setView("error");
      return;
    }
    if (state === "stopped") {
      setBusy(false);
      setErrorText(data.error || "Emergency stop activated.");
      setView("error");
      return;
    }
    setBusy(false);
  };

  useEffect(() => {
    setStatusText("Loading menu...");
    Promise.all([fetchDrinks(), fetchConfig(), syncStatus()])
      .then(([drinkList, configData]) => {
        setAdminPumps(toAdminPumps(configData, drinkList));
        setStatusText("Ready");
      })
      .catch((err) => {
        setErrorText(err.message || "Failed to initialize");
        setView("error");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const ws = new WebSocket(`${WS_BASE}/ws/progress`);
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.event === "started") {
        setBusy(true);
        setView("mixing");
        setStarting(false);
        setStatusText("Mixing started");
        setProgress({ runId: data.run_id, pct: 0, ingredient: "", etaSeconds: 0 });
      } else if (data.event === "pouring") {
        setProgress((prev) => ({
          ...prev,
          runId: data.run_id ?? prev.runId,
          pct: data.progress ?? prev.pct,
          ingredient: data.ingredient_name ?? "",
          etaSeconds: data.remaining_seconds ?? data.run_seconds ?? prev.etaSeconds
        }));
      } else if (data.event === "step_done") {
        setProgress((prev) => ({
          ...prev,
          pct: data.progress ?? prev.pct,
          etaSeconds: data.remaining_seconds ?? prev.etaSeconds
        }));
      } else if (data.event === "completed") {
        setBusy(false);
        setProgress((prev) => ({ ...prev, pct: 100, etaSeconds: 0 }));
        setView("success");
        setStatusText("Drink complete");
      } else if (data.event === "error") {
        setBusy(false);
        setStarting(false);
        setErrorText(data.message || "Mixing failed.");
        setView("error");
      } else if (data.event === "stopped") {
        setBusy(false);
        setStarting(false);
        setErrorText(data.message || "Emergency stop activated.");
        setView("error");
      }
    };
    ws.onclose = () => setStatusText("Connection idle");
    return () => ws.close();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      syncStatus().catch(() => {});
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  const filteredDrinks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return drinks.filter((d) => {
      const nameMatch = d.name.toLowerCase().includes(q);
      const descMatch = (d.description || "").toLowerCase().includes(q);
      const tagMatch = activeTag === "all" || (d.tags || []).includes(activeTag);
      return (nameMatch || descMatch) && tagMatch;
    });
  }, [drinks, query, activeTag]);

  const startMix = async () => {
    if (!selectedDrink || busy) return;
    try {
      setStatusText("Starting mixer...");
      setStarting(true);
      const res = await fetch(`${API_BASE}/api/mix/${selectedDrink.id}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "Unable to start drink");
      }
    } catch (err) {
      setStarting(false);
      setErrorText(err.message || "Unable to start drink");
      setView("error");
    }
  };

  const stopMix = async () => {
    try {
      await fetch(`${API_BASE}/api/stop`, { method: "POST" });
      setBusy(false);
      setStarting(false);
      setErrorText("Emergency stop activated.");
      setView("error");
    } catch {
      setStarting(false);
      setErrorText("Failed to send stop signal.");
      setView("error");
    }
  };

  const saveCalibration = async () => {
    try {
      setCalibrationSaving(true);
      const res = await fetch(`${API_BASE}/api/config/calibration`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pumps: adminPumps.map(({ pump, ml_per_second }) => ({ pump, ml_per_second }))
        })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || "Failed to save calibration");
      }
      const data = await res.json();
      setAdminPumps(toAdminPumps(data, drinks));
      setAdminSavedAt(new Date().toLocaleTimeString());
      setStatusText("Calibration saved");
    } catch (err) {
      setErrorText(err.message || "Failed to save calibration");
      setView("error");
    } finally {
      setCalibrationSaving(false);
    }
  };

  const updatePumpRate = (pumpNumber, value) => {
    setAdminPumps((prev) =>
      prev.map((pump) =>
        pump.pump === pumpNumber ? { ...pump, ml_per_second: Number(value) } : pump
      )
    );
  };

  const renderTag = (tag) => (
    <span
      key={tag}
      className="rounded-md border border-black/20 bg-[#f1eadf] px-2 py-1 text-[11px] font-black uppercase text-[#3d3427]"
    >
      {tag}
    </span>
  );

  const filteredCount = filteredDrinks.length;
  const showEmpty = !loading && drinks.length === 0;
  const showNoSearchResult = !loading && drinks.length > 0 && filteredCount === 0;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#f1eadf] text-[#17130d]">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.72),rgba(231,217,196,0.62)),radial-gradient(circle_at_50%_0%,rgba(255,211,90,0.22),transparent_42%)]" />
      <div className="relative mx-auto flex h-full w-full max-w-[1024px] flex-col gap-2 px-2 py-2 sm:gap-3 sm:px-3 sm:py-3">
        <header className="glass-panel flex min-h-14 items-center justify-between rounded-xl px-3 py-2 sm:min-h-16 sm:px-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-[#17130d] p-2 text-[#ffd35a] ring-2 ring-[#d9b65b]/45">
              <Martini size={24} />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight sm:text-2xl">Drink Mixer</h1>
              {statusText !== "Ready" && (
                <p className="text-sm font-semibold text-zinc-300 sm:text-base">{statusText}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView("home")}
              className="sun-button min-h-12 rounded-lg px-4 text-base font-bold transition hover:brightness-95"
            >
              Home
            </button>
            <button
              onClick={() => setView("admin")}
              className="sun-button flex min-h-12 items-center gap-2 rounded-lg px-4 text-base font-bold transition hover:brightness-95"
            >
              <Settings size={18} />
              Admin
            </button>
            <div className={`rounded-lg border-2 border-black/20 px-4 py-2 text-base font-black ${busy ? "bg-[#ffd35a] text-zinc-950" : "bg-[#2f8f5b] text-white"}`}>
              {busy ? "Busy" : "Ready"}
            </div>
          </div>
        </header>

        <AnimatePresence mode="wait">
          {(view === "home" || view === "detail") && (
            <motion.section
              key={view}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="grid min-h-0 flex-1 grid-cols-12 gap-2 sm:gap-3"
            >
              <aside className="glass-panel col-span-12 flex min-h-0 flex-col rounded-xl p-3 md:col-span-4 md:p-3">
                <div className="mb-2 flex min-h-12 items-center gap-2 rounded-lg border-2 border-black/15 bg-white px-3 py-2">
                  <Search size={20} className="text-[#5a4e3d]" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drinks..."
                    className="w-full bg-transparent text-lg font-semibold text-[#17130d] outline-none placeholder:text-[#5a4e3d]"
                  />
                </div>
                <div className="mb-2 flex flex-wrap gap-2">
                  <button
                    onClick={() => setActiveTag("all")}
                    className={`min-h-11 rounded-lg px-4 text-base font-bold capitalize transition ${activeTag === "all" ? "bg-[#17130d] text-white" : "sun-button"}`}
                  >
                    All
                  </button>
                  {TAGS.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setActiveTag(tag)}
                      className={`min-h-11 rounded-lg px-4 text-base font-bold capitalize transition ${activeTag === tag ? "bg-[#17130d] text-white" : "sun-button"}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>

                {loading && (
                  <div className="flex-1 space-y-3">
                    <div className="h-12 animate-pulse rounded-lg bg-black/10" />
                    <div className="h-52 animate-pulse rounded-lg bg-black/10" />
                    <div className="h-24 animate-pulse rounded-lg bg-black/10" />
                  </div>
                )}

                {!loading && view === "home" && (
                  <div className="flex-1 rounded-lg border-2 border-black/15 bg-[#fffaf0] p-3 text-base font-semibold text-zinc-300">
                    Tap a photo to choose a cocktail.
                  </div>
                )}

                {!loading && view === "detail" && selectedDrink && (
                  <div className="rounded-lg border-2 border-black/15 bg-[#fffaf0] p-3">
                    <button
                      onClick={() => setView("home")}
                      className="sun-button mb-2 flex min-h-11 items-center gap-2 rounded-lg px-4 text-base font-bold transition hover:brightness-95"
                    >
                      <ArrowLeft size={18} />
                      Back
                    </button>
                    <DrinkImage
                      imagePath={selectedDrink.image}
                      name={selectedDrink.name}
                      className="mb-3 h-32 w-full rounded-lg object-cover ring-2 ring-black/15 sm:h-40"
                    />
                    <h2 className="mb-1 text-2xl font-black sm:text-3xl">{selectedDrink.name}</h2>
                    <p className="mb-2 line-clamp-2 text-sm font-semibold text-zinc-300 sm:text-base">{selectedDrink.description || "House-crafted balance of premium ingredients."}</p>
                    <div className="mb-3 flex flex-wrap gap-2">{(selectedDrink.tags || []).slice(0, 3).map(renderTag)}</div>
                    <div className="mb-3 max-h-28 space-y-1 overflow-y-auto text-base text-zinc-200 sm:max-h-36">
                      {selectedDrink.ingredients.map((ing, i) => (
                        <div key={`${ing.pump}-${i}`} className="flex min-h-10 items-center justify-between rounded-lg border border-black/15 bg-white px-3 font-semibold">
                          <span>{ing.name || `Pump ${ing.pump}`}</span>
                          <span className="font-semibold">{ing.ml} ml</span>
                        </div>
                      ))}
                    </div>
                    <button
                      disabled={busy || starting}
                      onClick={startMix}
                      className="sun-primary min-h-14 w-full rounded-lg px-4 text-lg font-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {starting ? "Starting..." : busy ? "Machine Busy" : "Make Drink"}
                    </button>
                  </div>
                )}
              </aside>

              <div className="glass-panel col-span-12 min-h-0 rounded-xl p-2 md:col-span-8 md:p-3">
                <div className="mb-2 flex items-center justify-between px-1">
                  <h2 className="text-xl font-black sm:text-2xl">Cocktails</h2>
                  <span className="rounded-lg bg-[#17130d] px-3 py-1 text-sm font-black text-white">
                    {filteredCount}
                  </span>
                </div>

                {showEmpty && (
                  <div className="flex h-[40vh] min-h-52 items-center justify-center rounded-lg border-2 border-black/15 bg-[#fffaf0] p-6 text-center">
                    <div>
                      <Martini className="mx-auto mb-3 text-zinc-400" size={36} />
                      <p className="text-xl font-black">No drinks configured</p>
                      <p className="mt-1 text-base font-semibold text-zinc-400">Add recipes in your config to populate this menu.</p>
                    </div>
                  </div>
                )}

                {showNoSearchResult && (
                  <div className="flex h-[40vh] min-h-52 items-center justify-center rounded-lg border-2 border-black/15 bg-[#fffaf0] p-6 text-center text-lg font-black text-zinc-300">
                    No drinks match your search.
                  </div>
                )}

                {!showEmpty && !showNoSearchResult && (
                  <div className="grid max-h-full grid-cols-2 gap-2 overflow-y-auto p-1">
                    {loading &&
                      Array.from({ length: 6 }).map((_, idx) => (
                        <div key={idx} className="h-44 animate-pulse rounded-lg bg-black/10" />
                      ))}
                    {!loading &&
                      filteredDrinks.map((drink) => (
                    <motion.button
                      whileTap={{ scale: 0.985 }}
                      key={drink.id}
                      onClick={() => {
                        setSelectedDrink(drink);
                        setView("detail");
                      }}
                      className={`group min-h-[170px] overflow-hidden rounded-lg border-2 bg-white text-left shadow-sm transition sm:min-h-[190px] ${selectedDrink?.id === drink.id ? "border-[#e7a92f] ring-4 ring-[#ffd35a]/45" : "border-black/15"} ${busy ? "opacity-75" : "hover:border-black/35"}`}
                    >
                      <div className="relative">
                        <DrinkImage imagePath={drink.image} name={drink.name} className="h-28 w-full object-cover sm:h-32" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-transparent" />
                      </div>
                      <div className="p-2 sm:p-3">
                        <h3 className="line-clamp-1 text-xl font-black text-[#17130d]">{drink.name}</h3>
                        <div className="mt-1 flex flex-wrap gap-1">{(drink.tags || []).slice(0, 2).map(renderTag)}</div>
                      </div>
                    </motion.button>
                      ))}
                </div>
                )}
              </div>
            </motion.section>
          )}

          {view === "mixing" && (
            <motion.section
              key="mixing"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="glass-panel flex flex-1 flex-col justify-center rounded-xl p-5 sm:p-6"
            >
              <div className="mx-auto w-full max-w-4xl">
                <div className="mb-3 flex items-center gap-3 text-[#245f53]">
                  <Waves size={24} />
                  <span className="text-lg font-black">Precision Pour Sequence Active</span>
                </div>
                <h2 className="mb-3 text-3xl font-black tracking-tight sm:text-5xl">Preparing Your Cocktail</h2>
                <div className="mb-3 h-10 w-full overflow-hidden rounded-lg bg-white ring-2 ring-black/20">
                  <motion.div
                    className="h-full bg-gradient-to-r from-[#245f53] via-[#2f8f5b] to-[#ffd35a]"
                    animate={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
                <div className="mb-5 flex items-center justify-between text-xl font-black">
                  <span>{Math.round(progress.pct)}%</span>
                  <span>Est. remaining: {makeEtaText(progress.etaSeconds)}</span>
                </div>
                <button
                  onClick={stopMix}
                  className="sun-danger flex min-h-16 w-full items-center justify-center gap-2 rounded-lg px-4 text-2xl font-black transition hover:brightness-105"
                >
                  <ShieldAlert size={22} />
                  Emergency Stop
                </button>
              </div>
            </motion.section>
          )}

          {view === "success" && (
            <motion.section
              key="success"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="glass-panel flex flex-1 flex-col items-center justify-center rounded-xl p-8 text-center"
            >
              <div className="mb-4 rounded-full bg-[#2f8f5b] p-4 text-white">
                <Sparkles size={36} />
              </div>
              <h2 className="mb-2 text-4xl font-black">Cocktail Complete</h2>
              <p className="mb-8 text-xl font-semibold text-zinc-300">Serve immediately for peak flavor and temperature.</p>
              <button
                onClick={() => {
                  setView("home");
                  setProgress({ runId: null, pct: 0, ingredient: "", etaSeconds: 0 });
                }}
                className="sun-primary min-h-14 rounded-lg px-10 text-lg font-black transition hover:brightness-105"
              >
                Back to Menu
              </button>
            </motion.section>
          )}

          {view === "error" && (
            <motion.section
              key="error"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="glass-panel flex flex-1 flex-col items-center justify-center rounded-xl border-red-700/50 p-8 text-center"
            >
              <div className="mb-4 rounded-full bg-[#d91f2f] p-4 text-white">
                <AlertTriangle size={36} />
              </div>
              <h2 className="mb-2 text-4xl font-black">Machine Stopped</h2>
              <p className="mb-8 text-xl font-semibold text-zinc-200">{errorText || "An unexpected error occurred."}</p>
              <button
                onClick={() => {
                  setErrorText("");
                  setView("home");
                  syncStatus().catch(() => {});
                }}
                className="sun-primary min-h-14 rounded-lg px-10 text-lg font-black transition hover:brightness-105"
              >
                Return to Menu
              </button>
            </motion.section>
          )}

          {view === "admin" && (
            <motion.section
              key="admin"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="glass-panel flex min-h-0 flex-1 flex-col rounded-xl p-4 sm:p-5"
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Beaker size={24} className="text-[#245f53]" />
                  <h2 className="text-3xl font-black">Calibration</h2>
                </div>
                <button
                  onClick={() => setView("home")}
                  className="sun-button min-h-12 rounded-lg px-4 text-base font-bold transition hover:brightness-95"
                >
                  Back
                </button>
              </div>
              <p className="mb-3 text-base font-semibold text-zinc-300">Tune each pump flow rate for accurate pours. Values shown are ml/sec.</p>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
                {adminPumps.map((pump) => (
                  <div key={pump.pump} className={`rounded-lg border-2 border-black/15 bg-[#fffaf0] p-3 ${pump.enabled ? "" : "opacity-60"}`}>
                    <div className="mb-2 flex items-center justify-between">
                      <div>
                        <div className="text-xl font-black">Pump {pump.pump}</div>
                        <div className="text-sm font-semibold text-zinc-400">
                          GPIO: {pump.gpio_pin}{pump.enabled ? "" : " - disabled"}
                        </div>
                      </div>
                      <div className="rounded-lg border border-black/15 bg-white px-3 py-1 text-lg font-black">
                        {Number(pump.ml_per_second).toFixed(2)} ml/s
                      </div>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="30"
                      step="0.1"
                      value={pump.ml_per_second}
                      onChange={(e) => updatePumpRate(pump.pump, e.target.value)}
                      className="h-4 w-full accent-[#245f53]"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm font-semibold text-zinc-400">{adminSavedAt ? `Last saved at ${adminSavedAt}` : "No pending changes saved yet."}</div>
                <button
                  onClick={saveCalibration}
                  disabled={busy || calibrationSaving}
                  className="sun-primary min-h-12 rounded-lg px-6 text-lg font-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {calibrationSaving ? "Saving..." : "Save Calibration"}
                </button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export default App;
