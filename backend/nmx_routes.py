"""NMX-specific FastAPI routes.

Port of nmx_view/src/lib/h5wasm-loader.ts logic to Python.
Endpoints:
  GET  /current-file  -- return the currently active file path (or null)
  POST /current-file  -- set the currently active file path
  GET  /info          -- detect file type + enumerate panels (clears cache for the file)
  GET  /event-image   -- bin NXevent_data into a 2D detector image for a TOF range
  GET  /lauetof-slice -- return a single TOF slice from an NXlauetof 3D dataset
"""
from __future__ import annotations

import base64

import h5py
import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import ORJSONResponse
from pydantic import BaseModel

from . import event_cache as cache

# ── Current-file state ────────────────────────────────────────
_current_file: str | None = None

router = APIRouter()


# ── Pydantic response models ──────────────────────────────────

class PanelGeometry(BaseModel):
    origin: list[float]
    fast_axis: list[float]
    slow_axis: list[float]
    x_pixel_size: float
    y_pixel_size: float
    source_distance: float
    n_rows: int
    n_cols: int


class EventPanelInfo(BaseModel):
    path: str
    name: str
    num_events: int
    detector_shape: list[int]
    tof_min: float
    tof_max: float


class LauetofPanelInfo(BaseModel):
    path: str
    name: str
    shape: list[int]                # [rows, cols, numTofBins]
    tof_bins: list[float]
    geometry: PanelGeometry | None


class FileInfo(BaseModel):
    type: str                       # "NXevent_data" | "NXlauetof" | "unknown"
    event_panels: list[EventPanelInfo] = []
    lauetof_panels: list[LauetofPanelInfo] = []


class ImageResult(BaseModel):
    image_b64: str      # base64-encoded little-endian float32 array
    shape: list[int]    # [rows, cols]
    total_events: int


# ── Helpers ────────────────────────────────────────────────────

def _read_str(ds: h5py.Dataset) -> str:
    v = ds[()]
    if isinstance(v, bytes):
        return v.decode().strip()
    if isinstance(v, np.ndarray):
        item = v.flat[0]
        return item.decode().strip() if isinstance(item, bytes) else str(item).strip()
    return str(v).strip()


def _tof_to_ns_factor(ds: h5py.Dataset) -> float:
    """Return multiplier to convert the dataset's TOF values to nanoseconds."""
    unit = ds.attrs.get("units") or ds.attrs.get("unit")
    if unit is None:
        return 1.0
    if isinstance(unit, bytes):
        unit = unit.decode()
    if isinstance(unit, np.ndarray):
        unit = unit.flat[0]
        if isinstance(unit, bytes):
            unit = unit.decode()
    unit = str(unit).strip().lower()
    table: dict[str, float] = {
        "s": 1e9, "second": 1e9, "seconds": 1e9,
        "ms": 1e6, "millisecond": 1e6, "milliseconds": 1e6,
        "us": 1e3, "µs": 1e3, "microsecond": 1e3, "microseconds": 1e3,
        "ns": 1.0, "nanosecond": 1.0, "nanoseconds": 1.0,
    }
    return table.get(unit, 1.0)


def _find_event_group(panel_group: h5py.Group) -> h5py.Group | None:
    """Find the subgroup (or the group itself) that contains event_id."""
    if "event_id" in panel_group:
        return panel_group
    if "data" in panel_group and isinstance(panel_group["data"], h5py.Group):
        if "event_id" in panel_group["data"]:
            return panel_group["data"]
    for key in panel_group:
        child = panel_group[key]
        if not isinstance(child, h5py.Group):
            continue
        nx = child.attrs.get("NX_class", b"")
        if isinstance(nx, bytes):
            nx = nx.decode()
        if nx == "NXevent_data" or "event_id" in child:
            return child
    return None


def _detect_file_type(f: h5py.File) -> str:
    for path in ("entry/definition", "entry/definitions"):
        if path in f:
            try:
                if _read_str(f[path]) == "NXlauetof":
                    return "NXlauetof"
            except Exception:
                pass
    if "entry/instrument" in f:
        inst = f["entry/instrument"]
        for key in inst:
            child = inst[key]
            if isinstance(child, h5py.Group) and _find_event_group(child) is not None:
                return "NXevent_data"
    return "unknown"


def _read_distance_m(f: h5py.File, path: str) -> float | None:
    ds = f.get(path)
    if ds is None or not isinstance(ds, h5py.Dataset):
        return None
    val = float(np.asarray(ds).flat[0])
    unit = ds.attrs.get("units") or ds.attrs.get("unit")
    if unit is not None:
        u = (unit.decode() if isinstance(unit, bytes) else str(unit)).strip().lower()
        if u == "mm":
            val *= 1e-3
        elif u == "cm":
            val *= 1e-2
    return val


def _read_vec3(f: h5py.File, path: str) -> list[float] | None:
    ds = f.get(path)
    if ds is None or not isinstance(ds, h5py.Dataset):
        return None
    v = np.asarray(ds, dtype=np.float64).flatten()
    if len(v) < 3:
        return None
    return [float(v[0]), float(v[1]), float(v[2])]


def _read_panel_geometry(
    f: h5py.File, panel_path: str, n_rows: int, n_cols: int
) -> PanelGeometry | None:
    try:
        origin = _read_vec3(f, f"{panel_path}/origin")
        fast_axis = _read_vec3(f, f"{panel_path}/fast_axis")
        slow_axis = _read_vec3(f, f"{panel_path}/slow_axis")
        x_px = _read_distance_m(f, f"{panel_path}/x_pixel_size")
        y_px = _read_distance_m(f, f"{panel_path}/y_pixel_size")
        src_dist = _read_distance_m(f, "entry/instrument/source/distance")
        if any(v is None for v in (origin, fast_axis, slow_axis, x_px, y_px, src_dist)):
            return None
        return PanelGeometry(
            origin=origin,
            fast_axis=fast_axis,
            slow_axis=slow_axis,
            x_pixel_size=x_px,
            y_pixel_size=y_px,
            source_distance=src_dist,
            n_rows=n_rows,
            n_cols=n_cols,
        )
    except Exception:
        return None


def _detector_shape_for_panel(
    f: h5py.File, panel_path: str, panel_group: h5py.Group
) -> list[int]:
    """Infer [rows, cols] from detector_number or pixel offset datasets."""
    if "detector_number" in panel_group:
        dn = panel_group["detector_number"]
        if len(dn.shape) >= 2:
            return [dn.shape[0], dn.shape[1]]
        n = int(round(dn.shape[0] ** 0.5))
        return [n, n]
    xo = f.get(f"{panel_path}/x_pixel_offset")
    yo = f.get(f"{panel_path}/y_pixel_offset")
    if xo is not None and yo is not None:
        nx = xo.shape[1] if len(xo.shape) > 1 else xo.shape[0]
        ny = yo.shape[0]
        return [ny, nx]
    return [1280, 1280]


def _find_event_panels(f: h5py.File) -> list[EventPanelInfo]:
    panels = []
    if "entry/instrument" not in f:
        return panels
    inst = f["entry/instrument"]
    for key in inst:
        child = inst[key]
        if not isinstance(child, h5py.Group):
            continue
        panel_path = f"entry/instrument/{key}"
        ev = _find_event_group(child)
        if ev is None or "event_id" not in ev:
            continue
        num_events = int(ev["event_id"].shape[0])
        det_shape = _detector_shape_for_panel(f, panel_path, child)

        tof_min, tof_max = 0.0, 0.0
        eto = ev.get("event_time_offset")
        if eto is not None:
            raw = np.asarray(eto, dtype=np.float64)
            factor = _tof_to_ns_factor(eto)
            if factor != 1.0:
                raw = raw * factor
            if len(raw):
                tof_min, tof_max = float(raw.min()), float(raw.max())

        panels.append(EventPanelInfo(
            path=panel_path,
            name=key,
            num_events=num_events,
            detector_shape=det_shape,
            tof_min=tof_min,
            tof_max=tof_max,
        ))
    return panels


def _find_lauetof_panels(f: h5py.File) -> list[LauetofPanelInfo]:
    panels = []
    if "entry/instrument" not in f:
        return panels
    inst = f["entry/instrument"]
    for key in inst:
        child = inst[key]
        if not isinstance(child, h5py.Group):
            continue
        panel_path = f"entry/instrument/{key}"

        # Find 3D data dataset
        data_ds = None
        if "data" in child and isinstance(child["data"], h5py.Dataset) and len(child["data"].shape) == 3:
            data_ds = child["data"]
        else:
            for ck in child:
                ds = child[ck]
                if isinstance(ds, h5py.Dataset) and len(ds.shape) == 3:
                    data_ds = ds
                    break
        if data_ds is None:
            continue

        # Find time_of_flight
        tof_ds = None
        if "time_of_flight" in child and isinstance(child["time_of_flight"], h5py.Dataset):
            tof_ds = child["time_of_flight"]
        else:
            for ck in child:
                sub = child[ck]
                if isinstance(sub, h5py.Group) and "time_of_flight" in sub:
                    tof_ds = sub["time_of_flight"]
                    break
        if tof_ds is None:
            continue

        tof_raw = np.asarray(tof_ds, dtype=np.float64)
        factor = _tof_to_ns_factor(tof_ds)
        if factor != 1.0:
            tof_raw = tof_raw * factor
        tof_bins = tof_raw.tolist()

        rows, cols, nbins = data_ds.shape
        geom = _read_panel_geometry(f, panel_path, rows, cols)
        panels.append(LauetofPanelInfo(
            path=panel_path,
            name=key,
            shape=[rows, cols, nbins],
            tof_bins=tof_bins,
            geometry=geom,
        ))
    return panels


def _load_and_cache_events(
    f: h5py.File, panel_path: str, file_path: str
) -> cache.CachedEventData:
    """Load event data from an open h5py file and store in cache."""
    panel_group = f[panel_path]
    ev = _find_event_group(panel_group)
    if ev is None:
        raise ValueError(f"No event data group in {panel_path}")

    event_id = np.asarray(ev["event_id"], dtype=np.float64)
    eto_ds = ev["event_time_offset"]
    tof_ns = np.asarray(eto_ds, dtype=np.float64)
    factor = _tof_to_ns_factor(eto_ds)
    if factor != 1.0:
        tof_ns = tof_ns * factor

    det_shape = _detector_shape_for_panel(f, panel_path, panel_group)
    rows, cols = det_shape

    # Load detector_number
    det_num = None
    for src in (panel_group, ev):
        if "detector_number" in src:
            det_num = np.asarray(src["detector_number"], dtype=np.int32).flatten()
            break
    if det_num is None:
        # Identity mapping
        det_num = np.arange(rows * cols, dtype=np.int32)

    pixel_id_min = int(det_num.min())
    total_px = rows * cols

    pixel_to_flat = np.full(total_px, -1, dtype=np.int32)
    rel = det_num.astype(np.int64) - pixel_id_min
    valid_mask = (rel >= 0) & (rel < total_px)
    flat_indices = np.where(valid_mask)[0]
    pixel_to_flat[rel[valid_mask]] = flat_indices

    is_identity = bool(np.array_equal(pixel_to_flat, np.arange(total_px, dtype=np.int32)))

    tof_min = float(tof_ns.min()) if len(tof_ns) else 0.0
    tof_max = float(tof_ns.max()) if len(tof_ns) else 0.0

    data = cache.CachedEventData(
        event_id=event_id,
        tof_ns=tof_ns,
        detector_shape=(rows, cols),
        pixel_id_min=pixel_id_min,
        pixel_to_flat=pixel_to_flat,
        is_identity=is_identity,
        tof_min=tof_min,
        tof_max=tof_max,
    )
    cache.put(file_path, panel_path, data)
    return data


def _compute_event_image(
    ed: cache.CachedEventData, tof_min: float, tof_max: float
) -> tuple[np.ndarray, int]:
    rows, cols = ed.detector_shape
    total_px = rows * cols
    image = np.zeros(total_px, dtype=np.float32)

    mask = (ed.tof_ns >= tof_min) & (ed.tof_ns <= tof_max)
    pids = (ed.event_id[mask] - ed.pixel_id_min).astype(np.int64)
    valid = (pids >= 0) & (pids < total_px)
    pids = pids[valid]

    if ed.is_identity:
        np.add.at(image, pids, 1)
    else:
        flat_idx = ed.pixel_to_flat[pids]
        good = flat_idx >= 0
        np.add.at(image, flat_idx[good], 1)

    return image, int(image.sum())


def _encode_image(image: np.ndarray, shape: tuple[int, int], total_events: int) -> ImageResult:
    arr_f32 = image.astype(np.float32)
    b64 = base64.b64encode(arr_f32.tobytes()).decode("ascii")
    return ImageResult(image_b64=b64, shape=list(shape), total_events=total_events)


# ── Endpoints ──────────────────────────────────────────────────

class CurrentFile(BaseModel):
    file: str | None


@router.get("/current-file")
def get_current_file() -> ORJSONResponse:
    """Return the file path the viewer should display, or null if none is set."""
    return ORJSONResponse({"file": _current_file})


@router.post("/current-file")
def set_current_file(body: CurrentFile) -> ORJSONResponse:
    """Set the file path the viewer should display."""
    global _current_file
    _current_file = body.file
    return ORJSONResponse({"file": _current_file})


@router.get("/info")
def get_file_info(file: str) -> ORJSONResponse:
    """Return file type and all panel metadata. Clears stale event cache for this file."""
    cache.clear_file(file)
    try:
        with h5py.File(file, "r") as f:
            file_type = _detect_file_type(f)
            if file_type == "NXevent_data":
                panels = _find_event_panels(f)
                return ORJSONResponse(FileInfo(
                    type=file_type, event_panels=panels
                ).model_dump())
            elif file_type == "NXlauetof":
                panels = _find_lauetof_panels(f)
                return ORJSONResponse(FileInfo(
                    type=file_type, lauetof_panels=panels
                ).model_dump())
            else:
                return ORJSONResponse(FileInfo(type="unknown").model_dump())
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"Cannot open file: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/event-image")
def get_event_image(
    file: str, panel_path: str, tof_min: float, tof_max: float
) -> ORJSONResponse:
    """Bin NXevent_data into a 2D detector image for the given TOF range."""
    try:
        ed = cache.get(file, panel_path)
        if ed is None:
            with h5py.File(file, "r") as f:
                ed = _load_and_cache_events(f, panel_path, file)
        image, total = _compute_event_image(ed, tof_min, tof_max)
        result = _encode_image(image, ed.detector_shape, total)
        return ORJSONResponse(result.model_dump())
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"Cannot open file: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/lauetof-slice")
def get_lauetof_slice(
    file: str, panel_path: str, slice_index: int
) -> ORJSONResponse:
    """Return one TOF slice from an NXlauetof 3D dataset."""
    try:
        with h5py.File(file, "r") as f:
            panel_group = f[panel_path]
            data_ds = None
            if "data" in panel_group and isinstance(panel_group["data"], h5py.Dataset) and len(panel_group["data"].shape) == 3:
                data_ds = panel_group["data"]
            else:
                for ck in panel_group:
                    ds = panel_group[ck]
                    if isinstance(ds, h5py.Dataset) and len(ds.shape) == 3:
                        data_ds = ds
                        break
            if data_ds is None:
                raise ValueError(f"No 3D dataset found in {panel_path}")
            rows, cols, nbins = data_ds.shape
            idx = max(0, min(nbins - 1, slice_index))
            raw = np.asarray(data_ds[:, :, idx], dtype=np.float32)
        image = raw.flatten()
        total = int(image.sum())
        result = _encode_image(image, (rows, cols), total)
        return ORJSONResponse(result.model_dump())
    except OSError as e:
        raise HTTPException(status_code=404, detail=f"Cannot open file: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
