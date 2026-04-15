/**
 * HTTP client for the NMX FastAPI backend.
 *
 * Converts snake_case API responses to the camelCase types used
 * by the existing rendering layer (DetectorImageResult, PanelGeometry, etc.).
 */

import type { PanelGeometry } from "./dspacing";
import type { DetectorImageResult } from "./event-data";

export type NexusFileType = "NXevent_data" | "NXlauetof" | "unknown";

// ── Types mirroring the backend Pydantic models ───────────────

interface ApiPanelGeometry {
  origin: [number, number, number];
  fast_axis: [number, number, number];
  slow_axis: [number, number, number];
  x_pixel_size: number;
  y_pixel_size: number;
  source_distance: number;
  n_rows: number;
  n_cols: number;
}

interface ApiEventPanelInfo {
  path: string;
  name: string;
  num_events: number;
  detector_shape: [number, number];
  tof_min: number;
  tof_max: number;
}

interface ApiLauetofPanelInfo {
  path: string;
  name: string;
  shape: [number, number, number];
  tof_bins: number[];
  geometry: ApiPanelGeometry | null;
}

interface ApiFileInfo {
  type: NexusFileType;
  event_panels?: ApiEventPanelInfo[];
  lauetof_panels?: ApiLauetofPanelInfo[];
}

interface ApiImageResult {
  image_b64: string;    // base64-encoded little-endian float32
  shape: [number, number];
  total_events: number;
}

// ── Public types (camelCase, compatible with existing components) ─

export interface EventPanelInfo {
  path: string;
  name: string;
  numEvents: number;
  tofMin: number;
  tofMax: number;
}

export interface LauetofPanelInfo {
  path: string;
  name: string;
  shape: [number, number, number];
  tofBins: Float64Array;
  geometry: PanelGeometry | null;
}

export interface FileInfo {
  type: NexusFileType;
  eventPanels: EventPanelInfo[];
  lauetofPanels: LauetofPanelInfo[];
}

// ── Converters ────────────────────────────────────────────────

function convertGeometry(api: ApiPanelGeometry): PanelGeometry {
  return {
    origin: api.origin,
    fastAxis: api.fast_axis,
    slowAxis: api.slow_axis,
    xPixelSize: api.x_pixel_size,
    yPixelSize: api.y_pixel_size,
    sourceDistance: api.source_distance,
    nRows: api.n_rows,
    nCols: api.n_cols,
  };
}

/** Decode base64 float32 bytes → Float64Array (for DetectorImageResult.image). */
function decodeImageB64(b64: string): Float64Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const f32 = new Float32Array(bytes.buffer);
  const f64 = new Float64Array(f32.length);
  for (let i = 0; i < f32.length; i++) f64[i] = f32[i];
  return f64;
}

function convertImageResult(api: ApiImageResult): DetectorImageResult {
  return {
    image: decodeImageB64(api.image_b64),
    shape: api.shape,
    totalEvents: api.total_events,
  };
}

// ── API calls ─────────────────────────────────────────────────

async function apiFetch<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text().catch(() => resp.statusText);
    throw new Error(`API ${url}: ${resp.status} ${body}`);
  }
  return resp.json() as Promise<T>;
}

/**
 * Fetch the file path the backend wants the viewer to display.
 * Returns null if no file is set.
 */
export async function fetchCurrentFile(): Promise<string | null> {
  const data = await apiFetch<{ file: string | null }>("/api/nmx/current-file");
  return data.file;
}

/**
 * Fetch file type and panel metadata from the backend.
 * Clears the server-side event cache for this file (safe for reload).
 */
export async function fetchFileInfo(filePath: string): Promise<FileInfo> {
  const data = await apiFetch<ApiFileInfo>(
    `/api/nmx/info?file=${encodeURIComponent(filePath)}`
  );
  return {
    type: data.type,
    eventPanels: (data.event_panels ?? []).map((p) => ({
      path: p.path,
      name: p.name,
      numEvents: p.num_events,
      tofMin: p.tof_min,
      tofMax: p.tof_max,
    })),
    lauetofPanels: (data.lauetof_panels ?? []).map((p) => ({
      path: p.path,
      name: p.name,
      shape: p.shape,
      tofBins: new Float64Array(p.tof_bins),
      geometry: p.geometry ? convertGeometry(p.geometry) : null,
    })),
  };
}

/**
 * Fetch a binned 2D detector image for a given TOF range (NXevent_data).
 */
export async function fetchEventImage(
  filePath: string,
  panelPath: string,
  tofMin: number,
  tofMax: number
): Promise<DetectorImageResult> {
  const data = await apiFetch<ApiImageResult>(
    `/api/nmx/event-image?file=${encodeURIComponent(filePath)}` +
      `&panel_path=${encodeURIComponent(panelPath)}` +
      `&tof_min=${tofMin}&tof_max=${tofMax}`
  );
  return convertImageResult(data);
}

/**
 * Fetch a single TOF slice from an NXlauetof 3D dataset.
 */
export async function fetchLauetofSlice(
  filePath: string,
  panelPath: string,
  sliceIndex: number
): Promise<DetectorImageResult> {
  const data = await apiFetch<ApiImageResult>(
    `/api/nmx/lauetof-slice?file=${encodeURIComponent(filePath)}` +
      `&panel_path=${encodeURIComponent(panelPath)}` +
      `&slice_index=${sliceIndex}`
  );
  return convertImageResult(data);
}
