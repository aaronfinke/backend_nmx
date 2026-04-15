# NMX Viewer — Backend + Frontend

Interactive neutron diffraction detector data visualizer with a very simple backend. An [h5grove](https://github.com/silx-kit/h5grove/)/[FastAPI](https://fastapi.tiangolo.com) backend reads HDF5/NeXus files and serves processed detector images over HTTP; a React/TypeScript frontend handles rendering only.

## Repository layout

```
backend/          FastAPI server — HDF5 I/O, event binning, file-serving API
nmx_view/         React/TypeScript viewer SPA
```

## How it works

```
┌─────────────────────────────────────────────────────────┐
│  External process / script                              │
│  POST /nmx/current-file  {"file": "/data/run42.h5"}    │
└───────────────────────┬─────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────┐
│  FastAPI backend  (localhost:8000)                      │
│                                                         │
│  /nmx/current-file   ← stores active file path         │
│  /nmx/info           ← detect format, enumerate panels │
│  /nmx/event-image    ← bin events → 2D image           │
│  /nmx/lauetof-slice  ← read one TOF slice              │
│  /h5grove/*          ← generic HDF5 access             │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTP (proxied via Vite in dev)
                        ▼
┌─────────────────────────────────────────────────────────┐
│  React viewer  (localhost:5173)                         │
│                                                         │
│  Polls /nmx/current-file every 2 s                     │
│  On change → fetch panel info → fetch images           │
│  TOF slider → debounced fetch of new images            │
│  Rendering: @h5web/lib (color scaling, heatmap)        │
└─────────────────────────────────────────────────────────┘
```

### Supported NeXus formats

| Format | How it works |
|--------|--------------|
| `NXevent_data` | Raw neutron events (`event_id` + `event_time_offset`). Backend bins them into a 2D detector image per TOF range. Event arrays are cached in memory after the first request. |
| `NXlauetof` | Pre-binned 3D array `[rows, cols, tof_bins]`. Backend reads one slice per request; no caching needed. |

Format is auto-detected from `entry/definition` or by scanning `entry/instrument/` for event data groups.

---

## Setup

### Python environment

```bash
# From repo root
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt   # includes h5grove
```

### Frontend

```bash
cd nmx_view
npm install
```

---

## Running

**Terminal 1 — backend:**
```bash
source .venv/bin/activate
python -m backend.main --port 8000
```

**Terminal 2 — frontend dev server:**
```bash
cd nmx_view
npm run dev
# → http://localhost:5173/nmx_view/
```

The Vite dev server proxies `/api/*` to `http://127.0.0.1:8000`, so no CORS configuration is needed during development.

---

## Controlling which file is displayed

The viewer shows "Waiting for file from backend…" until a file is set. Set it via the API:

```bash
# Load a file
curl -X POST http://localhost:8000/nmx/current-file \
  -H "Content-Type: application/json" \
  -d '{"file": "/data/experiment.nxs"}'

# Query what is currently loaded
curl http://localhost:8000/nmx/current-file

# Clear (viewer returns to waiting state)
curl -X POST http://localhost:8000/nmx/current-file \
  -H "Content-Type: application/json" \
  -d '{"file": null}'
```

Any process with HTTP access to the backend can drive the viewer — a data acquisition script, a pipeline orchestrator, a Jupyter notebook, etc.

---

## API reference

All endpoints are under `http://localhost:8000`.

### `GET /nmx/current-file`
Returns the file path currently set for the viewer.
```json
{"file": "/data/run42.h5"}
```

### `POST /nmx/current-file`
Sets the active file. Body: `{"file": "<path>"}` or `{"file": null}`.

### `GET /nmx/info?file=<path>`
Detects file format and returns panel metadata. Also clears the server-side event cache for that file, so it is safe to call on reload.

Response:
```json
{
  "type": "NXevent_data",
  "event_panels": [
    {
      "path": "entry/instrument/panel1",
      "name": "panel1",
      "num_events": 4200000,
      "detector_shape": [128, 128],
      "tof_min": 0.0,
      "tof_max": 71000.0
    }
  ],
  "lauetof_panels": []
}
```

### `GET /nmx/event-image?file=<path>&panel_path=<path>&tof_min=<ns>&tof_max=<ns>`
Bins NXevent_data events within the TOF range into a 2D detector image.

Response:
```json
{
  "image_b64": "<base64-encoded little-endian float32>",
  "shape": [128, 128],
  "total_events": 18340
}
```

`image_b64` decodes to a flat `float32` array of length `shape[0] * shape[1]`, row-major.

### `GET /nmx/lauetof-slice?file=<path>&panel_path=<path>&slice_index=<int>`
Returns one TOF slice from an NXlauetof 3D dataset. Same response format as `/nmx/event-image`.

### `GET /h5grove/data?file=<path>&path=<hdf5path>`
Raw dataset access via h5grove (useful for debugging). See [h5grove docs](https://h5grove.readthedocs.io) for the full surface (`/meta`, `/attr`, `/stats`, `/paths`).

---

## Architecture notes

**Event cache** (`backend/event_cache.py`): loaded event arrays (`event_id`, `event_time_offset`, pixel mapping) are kept in a process-level LRU dict (max 10 panels, keyed by `(file_path, panel_path)`). This means the first `/nmx/event-image` call for a panel is slow (disk read); subsequent calls with different TOF ranges are fast (numpy in-memory binning).

**Image encoding**: images are returned as base64 `float32` rather than JSON arrays. For a 128×128 panel this is ~86 KB on the wire; for a 1280×1280 panel ~6.5 MB. This is roughly 3× smaller and much faster to parse than equivalent JSON.

**File access**: the backend opens any path the OS user running the server can read. No path restriction is enforced by default — add authentication and path whitelisting if the server is exposed beyond localhost.
