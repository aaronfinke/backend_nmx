import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import "@h5web/lib/dist/styles.css";
import { ScaleType } from "@h5web/lib";
import { ColorBar } from "./components/ViridisColorBar";
import type { ColorMap, ColorScaleType, Domain } from "@h5web/lib";
import { DetectorImage } from "./components/DetectorImage";
import { TofRangeSlider } from "./components/TofRangeSlider";
import {
  fetchCurrentFile,
  fetchFileInfo,
  fetchEventImage,
  fetchLauetofSlice,
  type NexusFileType,
  type EventPanelInfo,
  type LauetofPanelInfo,
} from "./lib/api-client";
import type { DetectorImageResult } from "./lib/event-data";
import "./App.css";

/** Reserve px for header, TOF slider, status bar, padding */
const CHROME_HEIGHT = 160;
/** Width reserved for the shared color bar + domain inputs */
const COLORBAR_WIDTH = 80;

function useChartSize(panelCount: number) {
  const compute = () => {
    const gap = 8;
    const totalGap = (Math.max(panelCount, 1) - 1) * gap;
    const availW = window.innerWidth - 40 - totalGap - COLORBAR_WIDTH;
    const availH = window.innerHeight - CHROME_HEIGHT;
    const perPanel = availW / Math.max(panelCount, 1);
    const s = Math.min(perPanel, availH);
    return Math.max(Math.floor(s), 100);
  };

  const [size, setSize] = useState(compute);

  useEffect(() => {
    const onResize = () => setSize(compute());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  useEffect(() => {
    setSize(compute());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelCount]);

  return size;
}

function App() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [fileType, setFileType] = useState<NexusFileType>("unknown");
  const [panels, setPanels] = useState<EventPanelInfo[]>([]);
  const [lauetofPanels, setLauetofPanels] = useState<LauetofPanelInfo[]>([]);
  const [detectorImages, setDetectorImages] = useState<(DetectorImageResult | null)[]>([]);
  const [tofRange, setTofRange] = useState<[number, number]>([0, 0]);
  const tofUnit = "µs";
  const [tofAbsMin, setTofAbsMin] = useState(0);
  const [tofAbsMax, setTofAbsMax] = useState(0);
  const [colorScale, setColorScale] = useState<ColorScaleType>(ScaleType.Linear);
  const [colorMap, setColorMap] = useState<ColorMap>("Viridis");
  const [imageComputing, setImageComputing] = useState(false);
  const [domainMin, setDomainMin] = useState<string>("");
  const [domainMax, setDomainMax] = useState<string>("");
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadProgressLabel, setLoadProgressLabel] = useState("");
  const [fileName, setFileName] = useState("");
  const [viewMode, setViewMode] = useState<"overview" | number>("overview");
  const [showHelp, setShowHelp] = useState(false);

  const filePathRef = useRef<string | null>(null);
  const tofDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasPanels = fileType === "NXlauetof" ? lauetofPanels.length > 0 : panels.length > 0;
  const activePanelCount = fileType === "NXlauetof" ? lauetofPanels.length : panels.length;
  const displayPanelCount = viewMode === "overview" ? activePanelCount : 1;
  const chartSize = useChartSize(displayPanelCount);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "h" || e.key === "H") { e.preventDefault(); setShowHelp((v) => !v); }
      if (e.key === "Escape") setShowHelp(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!hasPanels) return;
    const prevent = (e: DragEvent) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes("Files")) return;
      e.preventDefault(); e.stopPropagation();
      if (e.type === "dragover") e.dataTransfer.dropEffect = "copy";
    };
    window.addEventListener("dragover", prevent, true);
    window.addEventListener("drop", prevent, true);
    return () => {
      window.removeEventListener("dragover", prevent, true);
      window.removeEventListener("drop", prevent, true);
    };
  }, [hasPanels]);

  /** Poll backend every 2 s for the current file; load on change. */
  useEffect(() => {
    const check = async () => {
      try {
        const f = await fetchCurrentFile();
        if (f && f !== filePathRef.current && !loading) {
          await handleFilePath(f);
        }
      } catch {
        // backend not yet ready — ignore
      }
    };
    check(); // immediate check on mount
    pollRef.current = setInterval(check, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Yield to event loop so React can render progress updates. */
  const yieldToUI = () => new Promise<void>((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  const loadEventPanels = useCallback(async (filePath: string, foundPanels: EventPanelInfo[]) => {
    let globalTofMin = Infinity;
    let globalTofMax = -Infinity;
    const totalSteps = foundPanels.length * 2 + 1;
    let step = 0;

    // Compute global TOF range from panel metadata
    for (const p of foundPanels) {
      if (p.tofMin < globalTofMin) globalTofMin = p.tofMin;
      if (p.tofMax > globalTofMax) globalTofMax = p.tofMax;
    }
    const range: [number, number] = [globalTofMin, globalTofMax];
    setTofRange(range);
    setTofAbsMin(globalTofMin);
    setTofAbsMax(globalTofMax);

    // Fetch initial images (full TOF range) for all panels
    const images: (DetectorImageResult | null)[] = new Array(foundPanels.length).fill(null);
    for (let i = 0; i < foundPanels.length; i++) {
      const label = `Loading image for ${foundPanels[i].name}...`;
      setLoadProgressLabel(label);
      setLoadProgress(((++step) / totalSteps) * 100);
      setStatus(label);
      await yieldToUI();

      images[i] = await fetchEventImage(filePath, foundPanels[i].path, globalTofMin, globalTofMax);
      setLoadProgress(((++step) / totalSteps) * 100);
    }
    setDetectorImages(images);
    setLoadProgress(100);
    setLoadProgressLabel("Done!");
    const totalEvents = images.reduce((s, img) => s + (img?.totalEvents ?? 0), 0);
    setStatus(`Loaded ${foundPanels.length} panels — ${totalEvents.toLocaleString()} total events`);
  }, []);

  const loadLauetofPanels = useCallback(async (filePath: string, foundPanels: LauetofPanelInfo[]) => {
    const totalSteps = foundPanels.length + 1;
    let step = 0;

    let globalTofMin = Infinity;
    let globalTofMax = -Infinity;
    for (const p of foundPanels) {
      const pMin = p.tofBins[0];
      const pMax = p.tofBins[p.tofBins.length - 1];
      if (pMin < globalTofMin) globalTofMin = pMin;
      if (pMax > globalTofMax) globalTofMax = pMax;
    }

    const binWidth = foundPanels[0].tofBins.length > 1
      ? foundPanels[0].tofBins[1] - foundPanels[0].tofBins[0]
      : 1;

    setTofAbsMin(globalTofMin);
    setTofAbsMax(globalTofMax);
    setTofRange([globalTofMin, globalTofMin + binWidth]);

    const images: (DetectorImageResult | null)[] = new Array(foundPanels.length).fill(null);
    for (let i = 0; i < foundPanels.length; i++) {
      const p = foundPanels[i];
      const label = `Reading ${p.name} slice 1/${p.shape[2]}...`;
      setLoadProgressLabel(label);
      setLoadProgress(((++step) / totalSteps) * 100);
      setStatus(label);
      await yieldToUI();

      images[i] = await fetchLauetofSlice(filePath, p.path, 0);
    }
    setDetectorImages(images);
    setLoadProgress(100);
    setLoadProgressLabel("Done!");
    const totalCounts = images.reduce((s, img) => s + (img?.totalEvents ?? 0), 0);
    setStatus(`Loaded ${foundPanels.length} panels — slice 1/${foundPanels[0]?.shape[2] ?? 0} — ${totalCounts.toLocaleString()} counts`);
  }, []);

  const handleFilePath = useCallback(async (filePath: string) => {
    setLoading(true);
    setStatus("Contacting backend...");
    try {
      filePathRef.current = filePath;
      setFileName(filePath.split(/[\\/]/).pop() ?? filePath);
      setLoadProgress(0);
      setLoadProgressLabel("Detecting file type...");

      const info = await fetchFileInfo(filePath);
      setFileType(info.type);

      if (info.type === "NXlauetof") {
        if (info.lauetofPanels.length === 0) {
          setStatus("No detector panels found in NXlauetof file.");
          return;
        }
        setLauetofPanels(info.lauetofPanels);
        await loadLauetofPanels(filePath, info.lauetofPanels);
      } else if (info.type === "NXevent_data") {
        if (info.eventPanels.length === 0) {
          setStatus("No NXevent_data detector panels found.");
          return;
        }
        setPanels(info.eventPanels);
        await loadEventPanels(filePath, info.eventPanels);
      } else {
        setStatus("Unrecognised NeXus format (no NXevent_data or NXlauetof found).");
      }
    } catch (err) {
      setStatus(`Error: ${(err as Error).message}`);
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [loadEventPanels, loadLauetofPanels]);

  const handleReload = useCallback(async () => {
    if (!filePathRef.current) return;
    setLoading(true);
    setStatus("Reloading...");
    setLoadProgress(0);
    setLoadProgressLabel("Reloading...");
    setPanels([]);
    setLauetofPanels([]);
    setDetectorImages([]);
    try {
      await handleFilePath(filePathRef.current);
    } finally {
      setLoading(false);
    }
  }, [handleFilePath]);

  const handleTofRangeChange = useCallback(
    (range: [number, number]) => {
      setTofRange(range);
      if (tofDebounceRef.current) clearTimeout(tofDebounceRef.current);
      tofDebounceRef.current = setTimeout(async () => {
        const fp = filePathRef.current;
        if (!fp) return;
        setImageComputing(true);
        try {
          if (fileType === "NXlauetof") {
            const center = (range[0] + range[1]) / 2;
            const updates: Promise<DetectorImageResult>[] = [];
            const indices: number[] = [];
            for (let i = 0; i < lauetofPanels.length; i++) {
              if (viewMode !== "overview" && i !== viewMode) continue;
              const p = lauetofPanels[i];
              let bestIdx = 0;
              let bestDist = Math.abs(p.tofBins[0] - center);
              for (let j = 1; j < p.tofBins.length; j++) {
                const dist = Math.abs(p.tofBins[j] - center);
                if (dist < bestDist) { bestDist = dist; bestIdx = j; }
              }
              updates.push(fetchLauetofSlice(fp, p.path, bestIdx));
              indices.push(i);
            }
            const results = await Promise.all(updates);
            setDetectorImages((prev) => {
              const next = [...prev];
              indices.forEach((pi, ri) => { next[pi] = results[ri]; });
              return next;
            });
            const sliceIdx = (() => {
              const p = lauetofPanels[0];
              if (!p) return 0;
              let best = 0, bestD = Math.abs(p.tofBins[0] - center);
              for (let j = 1; j < p.tofBins.length; j++) {
                const d = Math.abs(p.tofBins[j] - center);
                if (d < bestD) { bestD = d; best = j; }
              }
              return best;
            })();
            setStatus(`${lauetofPanels.length} panels — slice ${sliceIdx + 1}/${lauetofPanels[0]?.shape[2] ?? 0}`);
          } else {
            const updates: Promise<DetectorImageResult>[] = [];
            const indices: number[] = [];
            for (let i = 0; i < panels.length; i++) {
              if (viewMode !== "overview" && i !== viewMode) continue;
              updates.push(fetchEventImage(fp, panels[i].path, range[0], range[1]));
              indices.push(i);
            }
            const results = await Promise.all(updates);
            setDetectorImages((prev) => {
              const next = [...prev];
              indices.forEach((pi, ri) => { next[pi] = results[ri]; });
              return next;
            });
            const totalEvents = results.reduce((s, img) => s + img.totalEvents, 0);
            setStatus(`${panels.length} panels — ${totalEvents.toLocaleString()} events in TOF range`);
          }
        } catch (err) {
          setStatus(`Image error: ${(err as Error).message}`);
        } finally {
          setImageComputing(false);
        }
      }, 80);
    },
    [fileType, panels, lauetofPanels, viewMode]
  );

  const LOG_SCALES: readonly string[] = [ScaleType.Log, ScaleType.SymLog];
  const autoDomain: Domain = useMemo(() => {
    const allVals: number[] = [];
    let valMax = 0;
    for (const img of detectorImages) {
      if (!img) continue;
      for (let j = 0; j < img.image.length; j++) {
        const v = img.image[j];
        if (v > valMax) valMax = v;
        if (v > 0) allVals.push(v);
      }
    }
    if (allVals.length === 0) return [0.1, 1];
    const n = allVals.length;
    let sum = 0;
    for (let j = 0; j < n; j++) sum += allVals[j];
    const mu = sum / n;
    let sumSq = 0;
    for (let j = 0; j < n; j++) sumSq += (allVals[j] - mu) ** 2;
    const sigma = Math.sqrt(sumSq / n);
    return [0, Math.max(Math.min(valMax, mu + 2 * sigma), 1)];
  }, [detectorImages]);

  const sharedDomain: Domain = useMemo(() => {
    let lo = autoDomain[0];
    let hi = autoDomain[1];
    if (domainMin !== "") lo = Number(domainMin);
    if (domainMax !== "") hi = Number(domainMax);
    if (LOG_SCALES.includes(colorScale)) lo = Math.max(lo, 0.1);
    if (hi <= lo) hi = lo + 1;
    return [lo, hi];
  }, [autoDomain, colorScale, domainMin, domainMax]);

  const handleAutoDomain = useCallback(() => { setDomainMin(""); setDomainMax(""); }, []);

  if (!hasPanels || (loading && detectorImages.every((d) => !d))) {
    return (
      <div className="app" data-filetype={fileType}>
        <div className="file-loader">
          <div className="file-loader-content">
            <h2>NMX Event Data Viewer</h2>
            {loading ? (
              <div className="loading-progress">
                <div className="progress-bar-container">
                  <div className="progress-bar-fill" style={{ width: `${Math.min(loadProgress, 100)}%` }} />
                </div>
                <p className="progress-label">{loadProgressLabel || "Loading..."}</p>
                <p className="progress-percent">{Math.round(loadProgress)}%</p>
              </div>
            ) : (
              <p>Waiting for file from backend…</p>
            )}
          </div>
        </div>
        {status && <div className="status-bar">{status}</div>}
      </div>
    );
  }

  return (
    <div className="app" data-filetype={fileType}>
      <header className="app-header">
        <h1>NMX Event Data Viewer</h1>
        {fileName && <span className="file-name-badge">{fileName}</span>}
        <div className="controls">
          <button
            className="reload-btn"
            onClick={handleReload}
            disabled={loading}
            title="Reload file (for SWMR / live data)"
          >
            &#x21bb; Reload
          </button>
          <div className="control-group">
            <label>View:</label>
            <select
              value={viewMode === "overview" ? "overview" : String(viewMode)}
              onChange={(e) => {
                const v = e.target.value;
                setViewMode(v === "overview" ? "overview" : Number(v));
              }}
            >
              <option value="overview">Overview</option>
              {(fileType === "NXlauetof" ? lauetofPanels : panels).map((p, i) => (
                <option key={p.path} value={i}>{p.name}</option>
              ))}
            </select>
          </div>
          <div className="control-group">
            <label>Color scale:</label>
            <select value={colorScale} onChange={(e) => setColorScale(e.target.value as ColorScaleType)}>
              <option value={ScaleType.Log}>Log</option>
              <option value={ScaleType.Linear}>Linear</option>
              <option value={ScaleType.SymLog}>SymLog</option>
              <option value={ScaleType.Sqrt}>Sqrt</option>
            </select>
          </div>
          <div className="control-group">
            <label>Color map:</label>
            <select value={colorMap} onChange={(e) => setColorMap(e.target.value as ColorMap)}>
              <option value="Viridis">Viridis</option>
              <option value="Inferno">Inferno</option>
              <option value="Greys">Greys</option>
            </select>
          </div>
          {fileType === "NXlauetof" && <span className="filetype-badge">NXLaueTOF</span>}
          <button className="help-btn" onClick={() => setShowHelp((v) => !v)} title="Help (H)">?</button>
        </div>
      </header>

      <main className="app-main">
        {detectorImages.length > 0 && (
          <>
            <div className="detector-panels-row">
              {imageComputing && <div className="computing-overlay">Recomputing...</div>}
              {(fileType === "NXlauetof" ? lauetofPanels : panels)
                .map((panel, i) => ({ panel, i }))
                .filter(({ i }) => viewMode === "overview" || i === viewMode)
                .map(({ panel, i }) => {
                  const img = detectorImages[i];
                  if (!img) return null;
                  const lauetofPanel = fileType === "NXlauetof" ? lauetofPanels[i] : null;
                  return (
                    <DetectorImage
                      key={panel.path}
                      imageResult={img}
                      panelName={panel.name}
                      colorScale={colorScale}
                      colorMap={colorMap}
                      size={chartSize}
                      domain={sharedDomain}
                      singlePanel={viewMode !== "overview"}
                      panelGeometry={lauetofPanel?.geometry}
                      tofCenterNs={lauetofPanel ? (tofRange[0] + tofRange[1]) / 2 : undefined}
                    />
                  );
                })}
              <div className="shared-colorbar" style={{ height: chartSize }}>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-max"
                  value={domainMax}
                  placeholder={String(Math.round(sharedDomain[1]))}
                  title="Color bar max"
                  onChange={(e) => setDomainMax(e.target.value)}
                />
                <div className="colorbar-gradient-wrapper">
                  <ColorBar width={30} height={chartSize - 70} colorMap={colorMap} />
                </div>
                <input
                  type="number"
                  className="colorbar-domain-input colorbar-domain-min"
                  value={domainMin}
                  placeholder={String(Math.round(sharedDomain[0]))}
                  title="Color bar min"
                  onChange={(e) => setDomainMin(e.target.value)}
                />
                <button className="colorbar-auto-btn" onClick={handleAutoDomain} title="Reset to optimal range (µ + 2σ)">
                  Auto
                </button>
              </div>
            </div>
            <TofRangeSlider
              tofMin={tofAbsMin}
              tofMax={tofAbsMax}
              tofRange={tofRange}
              onTofRangeChange={handleTofRangeChange}
              unit={tofUnit}
              forceWindowMode={fileType === "NXlauetof"}
              fixedWindowWidthNs={
                fileType === "NXlauetof" && lauetofPanels.length > 0 && lauetofPanels[0].tofBins.length > 1
                  ? lauetofPanels[0].tofBins[1] - lauetofPanels[0].tofBins[0]
                  : undefined
              }
              snapValuesNs={
                fileType === "NXlauetof" && lauetofPanels.length > 0
                  ? Array.from(lauetofPanels[0].tofBins)
                  : undefined
              }
              totalFlightPathM={
                fileType === "NXlauetof" && lauetofPanels.length > 0 && lauetofPanels[0].geometry
                  ? lauetofPanels[0].geometry.sourceDistance +
                    Math.sqrt(
                      lauetofPanels[0].geometry.origin[0] ** 2 +
                      lauetofPanels[0].geometry.origin[1] ** 2 +
                      lauetofPanels[0].geometry.origin[2] ** 2
                    )
                  : undefined
              }
            />
          </>
        )}
      </main>

      <div className="status-bar">{status}</div>

      {showHelp && (
        <div className="help-overlay" onClick={() => setShowHelp(false)}>
          <div className="help-modal" onClick={(e) => e.stopPropagation()}>
            <button className="help-close" onClick={() => setShowHelp(false)}>✕</button>
            <h2>NMX Event Data Viewer — Help</h2>
            <h3>Loading Data</h3>
            <ul>
              <li>Enter the server-side path to an HDF5/NeXus file and click <strong>Load File</strong></li>
              <li>Supported formats: <strong>NXevent_data</strong> (raw events) and <strong>NXLaueTOF</strong> (pre-binned)</li>
              <li>Use <strong>↻ Reload</strong> to re-read the file (useful for SWMR live data)</li>
              <li>Use <strong>📂 New File</strong> to load a different file</li>
            </ul>
            <h3>TOF Slider</h3>
            <ul>
              <li>Drag the two thumbs to set a TOF range for filtering events</li>
              <li>Enable <strong>Window</strong> mode to lock the range width and slide it as a unit</li>
              <li>Press <strong>← / →</strong> arrow keys to step by one current-slice width</li>
              <li>For NXLaueTOF files, the slider snaps to TOF bin centers</li>
            </ul>
            <h3>Views</h3>
            <ul>
              <li><strong>Overview</strong>: all detector panels side by side</li>
              <li><strong>Single panel</strong>: select a panel from the View dropdown for a larger view with zoom</li>
            </ul>
            <h3>Zoom (Single Panel View)</h3>
            <ul>
              <li><strong>Click & drag</strong> to draw a selection box and zoom in</li>
              <li><strong>Shift + drag</strong> to pan</li>
              <li>Click <strong>Reset Zoom</strong> to return to the full view</li>
            </ul>
            <h3>Color Scale</h3>
            <ul>
              <li>Choose scale type (Linear, Log, SymLog, Sqrt) from the dropdown</li>
              <li>Type values in the <strong>Min / Max</strong> inputs on the color bar to override the range</li>
              <li>Click <strong>Auto</strong> to reset to the optimal range (µ&nbsp;+&nbsp;2σ outlier rejection)</li>
            </ul>
            <p className="help-shortcut">Press <kbd>H</kbd> to toggle this help</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
