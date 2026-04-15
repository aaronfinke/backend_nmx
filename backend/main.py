#!/usr/bin/env python
"""NMX backend: h5grove generic HDF5 access + NMX-specific event/slice endpoints."""
from __future__ import annotations

import argparse
import os

# Disable HDF5 file locking (read-only server)
os.environ["HDF5_USE_FILE_LOCKING"] = "FALSE"

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from h5grove.fastapi_utils import router as h5grove_router, settings as h5grove_settings
from .nmx_routes import router as nmx_router

app = FastAPI(title="NMX Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Generic HDF5 access (browse any dataset/attribute in any file)
app.include_router(h5grove_router, prefix="/h5grove")

# NMX-specific: file type detection, event binning, TOF slicing
app.include_router(nmx_router, prefix="/nmx")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-p", "--port", type=int, default=8000)
    parser.add_argument("--host", default="localhost")
    parser.add_argument(
        "--basedir",
        default=None,
        help="Base directory for h5grove file access (optional)",
    )
    args = parser.parse_args()

    if args.basedir:
        h5grove_settings.base_dir = args.basedir

    uvicorn.run(
        "backend.main:app",
        host=args.host,
        port=args.port,
        log_level="info",
        reload=True,
    )


if __name__ == "__main__":
    main()
