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
      <div className={`flex items-center justify-center bg-gradient-to-br from-fuchsia-500/40 via-amber-500/35 to-cyan-500/35 ${className}`}>
        <span className="px-3 text-center text-xl font-semibold text-white/95 drop-shadow-sm">{name}</span>
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
      className="rounded-full border border-white/25 bg-white/10 px-3 py-1 text-xs uppercase text-zinc-100"
    >
      {tag}
    </span>
  );

  const filteredCount = filteredDrinks.length;
  const showEmpty = !loading && drinks.length === 0;
  const showNoSearchResult = !loading && drinks.length > 0 && filteredCount === 0;

  return (
    <div className="relative h-full w-full overflow-hidden bg-surface text-zinc-100">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(249,115,22,0.28),transparent_35%),radial-gradient(circle_at_85%_25%,rgba(168,85,247,0.25),transparent_35%),radial-gradient(circle_at_65%_80%,rgba(14,165,233,0.18),transparent_40%)]" />
      <div className="relative mx-auto flex h-full w-full max-w-[1280px] flex-col gap-4 px-3 py-3 sm:px-4 sm:py-4">
        <header className="glass-panel flex min-h-20 items-center justify-between rounded-2xl px-4 py-3 sm:px-6">
          <div className="flex items-center gap-4">
            <div className="rounded-xl bg-gradient-to-br from-amber-400/30 via-fuchsia-400/20 to-cyan-400/20 p-3 text-amber-200 ring-1 ring-white/30">
              <Martini size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Drink Mixer</h1>
              {statusText !== "Ready" && (
                <p className="text-base text-zinc-300">{statusText}</p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView("home")}
              className="min-h-12 rounded-xl border border-white/25 bg-white/10 px-4 text-base font-medium transition hover:bg-white/20 active:scale-[0.98]"
            >
              Home
            </button>
            <button
              onClick={() => setView("admin")}
              className="flex min-h-12 items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-4 text-base font-medium transition hover:bg-white/20 active:scale-[0.98]"
            >
              <Settings size={18} />
              Admin
            </button>
            <div className={`rounded-xl px-4 py-2 text-base font-semibold ${busy ? "bg-amber-300 text-zinc-900" : "bg-emerald-300 text-zinc-900"}`}>
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
              className="grid min-h-0 flex-1 grid-cols-12 gap-4"
            >
              <aside className="glass-panel col-span-12 flex min-h-0 flex-col rounded-2xl p-4 md:col-span-4 md:p-5">
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-white/20 bg-black/20 px-3 py-3">
                  <Search size={20} className="text-zinc-300" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search drinks..."
                    className="w-full bg-transparent text-lg outline-none placeholder:text-zinc-400"
                  />
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <button
                    onClick={() => setActiveTag("all")}
                    className={`min-h-11 rounded-full px-4 text-base capitalize transition ${activeTag === "all" ? "bg-white text-zinc-900" : "border border-white/20 bg-white/10 hover:bg-white/20"}`}
                  >
                    All
                  </button>
                  {TAGS.map((tag) => (
                    <button
                      key={tag}
                      onClick={() => setActiveTag(tag)}
                      className={`min-h-11 rounded-full px-4 text-base capitalize transition ${activeTag === tag ? "bg-white text-zinc-900" : "border border-white/20 bg-white/10 hover:bg-white/20"}`}
                    >
                      {tag}
                    </button>
                  ))}
                </div>

                {loading && (
                  <div className="flex-1 space-y-3">
                    <div className="h-12 animate-pulse rounded-xl bg-white/10" />
                    <div className="h-52 animate-pulse rounded-xl bg-white/10" />
                    <div className="h-24 animate-pulse rounded-xl bg-white/10" />
                  </div>
                )}

                {!loading && view === "home" && (
                  <div className="flex-1 rounded-2xl border border-white/20 bg-black/20 p-4 text-base text-zinc-300">
                    Tap any cocktail card to open details and start mixing.
                  </div>
                )}

                {!loading && view === "detail" && selectedDrink && (
                  <div className="rounded-2xl border border-white/25 bg-black/20 p-3 sm:p-4">
                    <button
                      onClick={() => setView("home")}
                      className="mb-3 flex min-h-11 items-center gap-2 rounded-xl border border-white/25 bg-white/10 px-4 text-base transition hover:bg-white/20 active:scale-[0.98]"
                    >
                      <ArrowLeft size={18} />
                      Back
                    </button>
                    <DrinkImage
                      imagePath={selectedDrink.image}
                      name={selectedDrink.name}
                      className="mb-4 h-48 w-full rounded-xl object-cover ring-1 ring-white/20 sm:h-56"
                    />
                    <h2 className="mb-2 text-2xl font-semibold sm:text-3xl">{selectedDrink.name}</h2>
                    <p className="mb-3 text-base text-zinc-300">{selectedDrink.description || "House-crafted balance of premium ingredients."}</p>
                    <div className="mb-4 flex flex-wrap gap-2">{(selectedDrink.tags || []).map(renderTag)}</div>
                    <div className="mb-5 space-y-2 text-base text-zinc-200">
                      {selectedDrink.ingredients.map((ing, i) => (
                        <div key={`${ing.pump}-${i}`} className="flex min-h-11 items-center justify-between rounded-xl border border-white/20 bg-white/10 px-3">
                          <span>{ing.name || `Pump ${ing.pump}`}</span>
                          <span className="font-semibold">{ing.ml} ml</span>
                        </div>
                      ))}
                    </div>
                    <button
                      disabled={busy || starting}
                      onClick={startMix}
                      className="min-h-14 w-full rounded-xl bg-gradient-to-r from-amber-300 via-orange-300 to-fuchsia-300 px-4 text-lg font-semibold text-zinc-900 transition hover:brightness-105 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {starting ? "Starting..." : busy ? "Machine Busy" : "Make Drink"}
                    </button>
                  </div>
                )}
              </aside>

              <div className="glass-panel col-span-12 min-h-0 rounded-2xl p-3 md:col-span-8 md:p-4">
                <div className="mb-3 flex items-center justify-between px-2">
                  <h2 className="text-2xl font-semibold sm:text-3xl">Cocktails</h2>
                </div>

                {showEmpty && (
                  <div className="flex h-[40vh] min-h-52 items-center justify-center rounded-2xl border border-white/20 bg-black/20 p-6 text-center">
                    <div>
                      <Martini className="mx-auto mb-3 text-zinc-400" size={36} />
                      <p className="text-xl font-medium">No drinks configured</p>
                      <p className="mt-1 text-base text-zinc-400">Add recipes in your config to populate this menu.</p>
                    </div>
                  </div>
                )}

                {showNoSearchResult && (
                  <div className="flex h-[40vh] min-h-52 items-center justify-center rounded-2xl border border-white/20 bg-black/20 p-6 text-center text-zinc-300">
                    No drinks match your search.
                  </div>
                )}

                {!showEmpty && !showNoSearchResult && (
                  <div className="grid max-h-full grid-cols-2 gap-3 overflow-y-auto p-1 lg:grid-cols-3">
                    {loading &&
                      Array.from({ length: 6 }).map((_, idx) => (
                        <div key={idx} className="h-56 animate-pulse rounded-2xl bg-white/10" />
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
                      className={`group min-h-[230px] overflow-hidden rounded-2xl border text-left transition ${selectedDrink?.id === drink.id ? "border-amber-300/70 ring-2 ring-amber-200/40" : "border-white/20"} ${busy ? "opacity-75" : "hover:-translate-y-0.5 hover:border-white/35"} bg-black/20`}
                    >
                      <div className="relative">
                        <DrinkImage imagePath={drink.image} name={drink.name} className="h-40 w-full object-cover" />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />
                      </div>
                      <div className="p-3 sm:p-4">
                        <h3 className="line-clamp-1 text-xl font-semibold">{drink.name}</h3>
                        <div className="mt-2 flex flex-wrap gap-2">{(drink.tags || []).slice(0, 3).map(renderTag)}</div>
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
              className="glass-panel flex flex-1 flex-col justify-center rounded-2xl p-5 sm:p-8"
            >
              <div className="mx-auto w-full max-w-4xl">
                <div className="mb-4 flex items-center gap-3 text-cyan-200">
                  <Waves size={24} />
                  <span className="text-lg">Precision Pour Sequence Active</span>
                </div>
                <h2 className="mb-2 text-4xl font-semibold tracking-tight sm:text-5xl">Preparing Your Cocktail</h2>
                <div className="mb-4 h-9 w-full overflow-hidden rounded-full bg-black/30 ring-1 ring-white/20">
                  <motion.div
                    className="h-full bg-gradient-to-r from-cyan-300 via-emerald-300 to-amber-300"
                    animate={{ width: `${Math.max(0, Math.min(100, progress.pct))}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
                <div className="mb-8 flex items-center justify-between text-xl">
                  <span>{Math.round(progress.pct)}%</span>
                  <span>Est. remaining: {makeEtaText(progress.etaSeconds)}</span>
                </div>
                <button
                  onClick={stopMix}
                  className="flex min-h-14 w-full items-center justify-center gap-2 rounded-xl bg-red-500/90 px-4 text-2xl font-semibold transition hover:bg-red-500 active:scale-[0.99]"
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
              className="glass-panel flex flex-1 flex-col items-center justify-center rounded-2xl p-8 text-center"
            >
              <div className="mb-4 rounded-full bg-emerald-400/20 p-4 text-emerald-300">
                <Sparkles size={36} />
              </div>
              <h2 className="mb-2 text-4xl font-semibold">Cocktail Complete</h2>
              <p className="mb-8 text-xl text-zinc-300">Serve immediately for peak flavor and temperature.</p>
              <button
                onClick={() => {
                  setView("home");
                  setProgress({ runId: null, pct: 0, ingredient: "", etaSeconds: 0 });
                }}
                className="min-h-14 rounded-xl bg-gradient-to-r from-emerald-300 to-cyan-300 px-10 text-lg font-semibold text-zinc-900 transition hover:brightness-110 active:scale-[0.99]"
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
              className="glass-panel flex flex-1 flex-col items-center justify-center rounded-2xl border-red-300/40 p-8 text-center"
            >
              <div className="mb-4 rounded-full bg-red-400/20 p-4 text-red-300">
                <AlertTriangle size={36} />
              </div>
              <h2 className="mb-2 text-4xl font-semibold">Machine Stopped</h2>
              <p className="mb-8 text-xl text-zinc-200">{errorText || "An unexpected error occurred."}</p>
              <button
                onClick={() => {
                  setErrorText("");
                  setView("home");
                  syncStatus().catch(() => {});
                }}
                className="min-h-14 rounded-xl bg-gradient-to-r from-amber-300 to-orange-300 px-10 text-lg font-semibold text-zinc-900 transition hover:brightness-110 active:scale-[0.99]"
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
              className="glass-panel flex min-h-0 flex-1 flex-col rounded-2xl p-5 sm:p-6"
            >
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Beaker size={24} className="text-cyan-200" />
                  <h2 className="text-3xl font-semibold">Calibration</h2>
                </div>
                <button
                  onClick={() => setView("home")}
                  className="min-h-12 rounded-xl border border-white/25 bg-white/10 px-4 text-base transition hover:bg-white/20 active:scale-[0.98]"
                >
                  Back
                </button>
              </div>
              <p className="mb-4 text-base text-zinc-300">Tune each pump flow rate for accurate pours. Values shown are ml/sec.</p>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                {adminPumps.map((pump) => (
                  <div key={pump.pump} className={`rounded-2xl border border-white/20 bg-black/20 p-4 ${pump.enabled ? "" : "opacity-60"}`}>
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <div className="text-xl font-semibold">Pump {pump.pump}</div>
                        <div className="text-sm text-zinc-400">
                          GPIO: {pump.gpio_pin}{pump.enabled ? "" : " - disabled"}
                        </div>
                      </div>
                      <div className="rounded-xl bg-white/10 px-3 py-1 text-lg font-semibold">
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
                      className="h-3 w-full accent-cyan-300"
                    />
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between">
                <div className="text-sm text-zinc-400">{adminSavedAt ? `Last saved at ${adminSavedAt}` : "No pending changes saved yet."}</div>
                <button
                  onClick={saveCalibration}
                  disabled={busy || calibrationSaving}
                  className="min-h-12 rounded-xl bg-gradient-to-r from-cyan-300 to-emerald-300 px-6 text-lg font-semibold text-zinc-900 transition hover:brightness-105 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
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
