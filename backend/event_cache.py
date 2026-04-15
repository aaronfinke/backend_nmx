"""In-memory LRU cache for loaded NXevent_data arrays.

Stores pre-processed numpy arrays so repeated event-image requests
for the same panel don't re-read from disk.
"""
from __future__ import annotations

from dataclasses import dataclass
from threading import Lock

import numpy as np

MAX_CACHE_SIZE = 10


@dataclass
class CachedEventData:
    event_id: np.ndarray    # float64, pixel IDs
    tof_ns: np.ndarray      # float64, time-of-flight in nanoseconds
    detector_shape: tuple[int, int]
    pixel_id_min: int
    pixel_to_flat: np.ndarray   # int32, length = rows*cols
    is_identity: bool
    tof_min: float
    tof_max: float


_cache: dict[tuple[str, str], CachedEventData] = {}
_lock = Lock()


def get(file_path: str, panel_path: str) -> CachedEventData | None:
    with _lock:
        return _cache.get((file_path, panel_path))


def put(file_path: str, panel_path: str, data: CachedEventData) -> None:
    with _lock:
        if len(_cache) >= MAX_CACHE_SIZE:
            oldest = next(iter(_cache))
            del _cache[oldest]
        _cache[(file_path, panel_path)] = data


def clear_file(file_path: str) -> None:
    """Evict all cached panels for a given file (called on reload)."""
    with _lock:
        keys = [k for k in _cache if k[0] == file_path]
        for k in keys:
            del _cache[k]
