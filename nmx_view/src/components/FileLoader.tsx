import React, { useState, useCallback } from "react";

interface FileLoaderProps {
  onFilePath: (path: string) => void;
  loading: boolean;
  progress?: number;
  progressLabel?: string;
}

export const FileLoader: React.FC<FileLoaderProps> = ({
  onFilePath,
  loading,
  progress = 0,
  progressLabel = "",
}) => {
  const [inputValue, setInputValue] = useState("");

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const path = inputValue.trim();
      if (path) onFilePath(path);
    },
    [inputValue, onFilePath]
  );

  return (
    <div className="file-loader">
      <div className="file-loader-content">
        <h2>NMX Event Data Viewer</h2>
        <p>Enter the server-side path to an HDF5/NeXus file.</p>
        <p>Supports <strong>NXevent_data</strong> (raw events) and <strong>NXLaueTOF</strong> (pre-binned) formats.</p>
        {loading ? (
          <div className="loading-progress">
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <p className="progress-label">{progressLabel || "Loading file..."}</p>
            <p className="progress-percent">{Math.round(progress)}%</p>
          </div>
        ) : (
          <form className="drop-zone file-path-form" onSubmit={handleSubmit}>
            <label htmlFor="file-path-input" className="file-path-label">
              File path on server
            </label>
            <input
              id="file-path-input"
              type="text"
              className="file-path-input"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="/data/experiment.nxs"
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="submit"
              className="file-input-label"
              disabled={!inputValue.trim()}
            >
              Load File
            </button>
          </form>
        )}
      </div>
    </div>
  );
};
