import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import * as XLSX from "xlsx";

const API = `http://${window.location.hostname}:4000/api/v1`;
const socket = io(`http://${window.location.hostname}:4000`);

interface PartItem {
  part_number: string;
  description: string;
  default_pack_qty?: number;
}

interface ScanLine {
  scan_id: string;
  part_number: string;
  description: string;
  quantity: number;
  scanned_at: string;
}

interface ConsolidatedLine {
  part_number: string;
  description: string;
  total_quantity: number;
  scan_count: number;
}

interface DockBundle {
  dockNumber: string;
  session: {
    session_id: string;
    dock_number: string;
    status: "STAGING" | "READY_FOR_LOADING" | "KEPT";
    obd_number: string | null;
    truck_number: string | null;
  } | null;
  rawLines: ScanLine[];
  consolidated: ConsolidatedLine[];
}

function extractMaterialAndDescription(rows: any[][]): PartItem[] {
  if (!rows || rows.length === 0) return [];

  let headerRowIdx = -1;
  let matCol = -1;
  let descCol = -1;

  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const normalized = rows[r].map((cell) => String(cell || "").trim().toLowerCase());
    const foundMat = normalized.findIndex(
      (h) => h === "material" || h === "part number" || h === "part_number" || h === "material code" || h === "part code"
    );
    const foundDesc = normalized.findIndex(
      (h) => h === "material description" || h === "description" || h === "part description"
    );

    if (foundMat !== -1 && foundDesc !== -1) {
      headerRowIdx = r;
      matCol = foundMat;
      descCol = foundDesc;
      break;
    }
  }

  // Fallback if header row wasn't included in pasted rows:
  // Supports both 17-col SAP rows (Col 0 = Material, Col 3 = Material Description) and 2-col rows (Col 0, Col 1)
  const startRow = headerRowIdx !== -1 ? headerRowIdx + 1 : 0;
  if (matCol === -1 || descCol === -1) {
    matCol = 0;
    const sampleCols = rows[0]?.length || 0;
    descCol = sampleCols >= 4 ? 3 : 1;
  }

  const uniqueMap = new Map<string, string>();
  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const mat = String(row[matCol] || "").trim().toUpperCase();
    const desc = String(row[descCol] || "").trim();
    if (!mat || !desc || mat === "MATERIAL") continue;
    uniqueMap.set(mat, desc);
  }

  return Array.from(uniqueMap.entries()).map(([part_number, description]) => ({
    part_number,
    description,
  }));
}

export default function App() {
  const [tab, setTab] = useState<"STAGING" | "LOADING" | "PARTS" | "HISTORY">("STAGING");
  const [docksOverview, setDocksOverview] = useState<any[]>([]);
  const [selectedDock, setSelectedDock] = useState<string>("");
  const [dockInputText, setDockInputText] = useState<string>("");
  const [bundle, setBundle] = useState<DockBundle | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [copiedField, setCopiedField] = useState<"PARTS" | "QTYS" | null>(null);

  const [partQuery, setPartQuery] = useState<string>("");
  const [partMatches, setPartMatches] = useState<PartItem[]>([]);
  const [showDropdown, setShowDropdown] = useState<boolean>(false);
  const [selectedPart, setSelectedPart] = useState<PartItem | null>(null);
  const [qtyInput, setQtyInput] = useState<string>("");

  const [obdInput, setObdInput] = useState<string>("");
  const [truckInput, setTruckInput] = useState<string>("");

  const [allParts, setAllParts] = useState<PartItem[]>([]);
  const [pasteText, setPasteText] = useState<string>("");
  const [parsedPreview, setParsedPreview] = useState<PartItem[]>([]);
  const [importFileName, setImportFileName] = useState<string>("");
  const [importMode, setImportMode] = useState<"MERGE" | "REPLACE">("MERGE");
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [historyRows, setHistoryRows] = useState<any[]>([]);

  const partInputRef = useRef<HTMLInputElement>(null);
  const qtyInputRef = useRef<HTMLInputElement>(null);

  const loadOverview = async () => {
    const res = await fetch(`${API}/docks/overview`);
    if (res.ok) setDocksOverview(await res.json());
  };

  const loadPartsList = async (q = "") => {
    const res = await fetch(`${API}/parts/search?q=${encodeURIComponent(q)}`);
    if (res.ok) {
      const data = await res.json();
      if (q) setPartMatches(data);
      else setAllParts(data);
    }
  };

  const loadHistory = async () => {
    const res = await fetch(`${API}/history`);
    if (res.ok) setHistoryRows(await res.json());
  };

  useEffect(() => {
    loadOverview();
    loadPartsList();
    socket.on("docks:overview_changed", loadOverview);
    return () => {
      socket.off("docks:overview_changed", loadOverview);
    };
  }, []);

  useEffect(() => {
    if (!selectedDock) return;
    socket.emit("dock:join", selectedDock);

    const onDockChanged = (updated: DockBundle) => {
      setBundle(updated);
      setObdInput(updated.session?.obd_number || "");
      setTruckInput(updated.session?.truck_number || "");
    };
    socket.on("dock:state_changed", onDockChanged);

    return () => {
      socket.emit("dock:leave", selectedDock);
      socket.off("dock:state_changed", onDockChanged);
    };
  }, [selectedDock]);

  const copyAlignedColumn = async (values: Array<string | number>, field: "PARTS" | "QTYS") => {
    if (values.length === 0) return;
    const payload = values.join("\n");
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(payload);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = payload;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand("copy");
        document.body.removeChild(textArea);
      }
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch {
      setErrorMsg("Unable to access clipboard. Please check browser permissions.");
    }
  };

  const handleSelectDock = async (dockRaw: string) => {
    setErrorMsg("");
    const clean = dockRaw.trim().toUpperCase();
    if (!clean) return;
    const dock = /^\d+$/.test(clean) ? `DOCK-${clean}` : clean;

    try {
      const endpoint = tab === "STAGING" ? `${API}/docks/${dock}/session` : `${API}/docks/${dock}/active`;
      const method = tab === "STAGING" ? "POST" : "GET";
      const res = await fetch(endpoint, { method });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load dock");

      setSelectedDock(data.dockNumber);
      setDockInputText(data.dockNumber);
      setBundle(data);
      setObdInput(data.session?.obd_number || "");
      setTruckInput(data.session?.truck_number || "");
      if (tab === "STAGING" && data.session?.status === "STAGING") {
        setTimeout(() => partInputRef.current?.focus(), 50);
      }
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handlePartInputChange = async (val: string) => {
    setPartQuery(val);
    setErrorMsg("");
    const trimmed = val.trim().toUpperCase();
    if (!trimmed) {
      setPartMatches([]);
      setShowDropdown(false);
      setSelectedPart(null);
      return;
    }

    if (/^\d{8,14}$/.test(trimmed)) {
      setShowDropdown(false);
      setSelectedPart(null);
      setErrorMsg("SU barcode detected! Please type or select a valid Part Number from the dropdown.");
      return;
    }

    const res = await fetch(`${API}/parts/search?q=${encodeURIComponent(trimmed)}`);
    if (res.ok) {
      const matches: PartItem[] = await res.json();
      setPartMatches(matches);
      setShowDropdown(matches.length > 0);

      const exact = matches.find((m) => m.part_number.toUpperCase() === trimmed);
      if (exact) {
        selectPartForQty(exact);
      }
    }
  };

  const selectPartForQty = (part: PartItem) => {
    setSelectedPart(part);
    setPartQuery(part.part_number);
    setShowDropdown(false);
    setErrorMsg("");
    setQtyInput("");
    setTimeout(() => qtyInputRef.current?.focus(), 20);
  };

  const handleAddScan = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!bundle?.session) return;
    setErrorMsg("");

    const code = (selectedPart?.part_number || partQuery).trim().toUpperCase();
    if (/^\d{8,14}$/.test(code)) {
      setErrorMsg("SU barcode not allowed. Type or select a Part Number from Part Master.");
      setPartQuery("");
      partInputRef.current?.focus();
      return;
    }

    try {
      const res = await fetch(`${API}/sessions/${bundle.session.session_id}/scans`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ partNumber: code, quantity: Number(qtyInput) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setBundle(data);
      setPartQuery("");
      setSelectedPart(null);
      setQtyInput("");
      partInputRef.current?.focus();
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleDeleteScan = async (scanId: string) => {
    if (!bundle?.session) return;
    const res = await fetch(`${API}/sessions/${bundle.session.session_id}/scans/${scanId}`, { method: "DELETE" });
    if (res.ok) setBundle(await res.json());
  };

  const handleLockStaging = async () => {
    if (!bundle?.session) return;
    setErrorMsg("");
    try {
      const res = await fetch(`${API}/sessions/${bundle.session.session_id}/lock`, { method: "PATCH" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setBundle(data);
    } catch (err: any) {
      setErrorMsg(err.message);
    }
  };

  const handleSaveMetadata = async (field: "obd" | "truck") => {
    if (!bundle?.session) return;
    const payload = field === "obd" ? { obdNumber: obdInput } : { truckNumber: truckInput };
    const res = await fetch(`${API}/sessions/${bundle.session.session_id}/metadata`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) setBundle(await res.json());
  };

  const handleFinalizeLoading = async (action: "COMPLETE" | "KEEP" | "VOID") => {
    if (!bundle?.session) return;
    const res = await fetch(`${API}/sessions/${bundle.session.session_id}/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, truckNumber: truckInput }),
    });
    if (res.ok) {
      const updated = await res.json();
      setBundle(updated);
      if (action === "COMPLETE" || action === "VOID") {
        setSelectedDock("");
        setDockInputText("");
        setObdInput("");
        setTruckInput("");
      }
    }
  };

  const handleExcelFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportFileName(file.name);
    setPasteText("");

    const reader = new FileReader();
    reader.onload = (evt) => {
      const data = new Uint8Array(evt.target?.result as ArrayBuffer);
      const workbook = XLSX.read(data, { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json<any[]>(firstSheet, { header: 1 });
      const extracted = extractMaterialAndDescription(rows);
      setParsedPreview(extracted);
    };
    reader.readAsArrayBuffer(file);
  };

  const handlePasteChange = (val: string) => {
    setPasteText(val);
    setImportFileName("");
    const lines = val.split(/\r?\n/).filter((l) => l.trim());
    const rows = lines.map((line) => (line.includes("\t") ? line.split("\t") : line.split(",")));
    setParsedPreview(extractMaterialAndDescription(rows));
  };

  const handleConfirmImport = async () => {
    if (parsedPreview.length === 0) return;
    setIsImporting(true);
    try {
      const res = await fetch(`${API}/parts/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parts: parsedPreview, mode: importMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Import failed");
      alert(`Successfully imported ${data.importedCount} unique Material + Description records!`);
      setParsedPreview([]);
      setPasteText("");
      setImportFileName("");
      loadPartsList();
    } catch (err: any) {
      alert("Import Error: " + err.message);
    } finally {
      setIsImporting(false);
    }
  };

  const session = bundle?.session;
  const consolidatedList = bundle?.consolidated || [];
  const isStagingEditable = tab === "STAGING" && session?.status === "STAGING";
  const isLockedOrReady = session?.status === "READY_FOR_LOADING" || session?.status === "KEPT";

  return (
    <div>
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span>ATHER DOCK & LOADING OPERATIONS</span>
        </div>
        <div className="nav-tabs">
          <button className={`nav-btn ${tab === "STAGING" ? "active" : ""}`} onClick={() => setTab("STAGING")}>
            1. Staging Bay
          </button>
          <button className={`nav-btn ${tab === "LOADING" ? "active" : ""}`} onClick={() => setTab("LOADING")}>
            2. Loading Gate
          </button>
          <button className={`nav-btn ${tab === "PARTS" ? "active" : ""}`} onClick={() => { setTab("PARTS"); loadPartsList(); }}>
            Part Master Import
          </button>
          <button className={`nav-btn ${tab === "HISTORY" ? "active" : ""}`} onClick={() => { setTab("HISTORY"); loadHistory(); }}>
            Audit History
          </button>
        </div>
      </header>

      <div className="container">
        {(tab === "STAGING" || tab === "LOADING") && (
          <>
            <div className="card" style={{ marginBottom: 14 }}>
              <div className="context-grid">
                <div>
                  <label>Select / Scan Dock Number (1 Active)</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      value={dockInputText}
                      onChange={(e) => setDockInputText(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSelectDock(dockInputText)}
                      placeholder="e.g. DOCK-45"
                    />
                    <button className="btn btn-dark" onClick={() => handleSelectDock(dockInputText)}>Load</button>
                  </div>
                  <div className="dock-chips">
                    {docksOverview.map((d) => (
                      <button
                        key={d.dock_number}
                        className={`chip ${selectedDock === d.dock_number ? "active" : ""} ${d.status === "READY_FOR_LOADING" ? "ready" : ""}`}
                        onClick={() => handleSelectDock(d.dock_number)}
                      >
                        {d.dock_number.replace("DOCK-", "")}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label>Active Dock</label>
                  <input value={selectedDock || "NONE SELECTED"} disabled />
                </div>

                <div>
                  <label>Dock Status</label>
                  <div className={`status-pill st-${session?.status || "IDLE"}`}>
                    {session?.status ? session.status.replace(/_/g, " ") : "CLEAN / IDLE"}
                  </div>
                </div>

                <div>
                  <label>SAP OBD Number</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      value={obdInput}
                      disabled={!session || tab === "LOADING"}
                      onChange={(e) => setObdInput(e.target.value)}
                      onBlur={() => handleSaveMetadata("obd")}
                      onKeyDown={(e) => e.key === "Enter" && handleSaveMetadata("obd")}
                      placeholder={isLockedOrReady ? "Enter SAP OBD #" : "Lock dock first"}
                    />
                  </div>
                </div>

                <div>
                  <label>Truck Number (Editable Both Views)</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input
                      value={truckInput}
                      disabled={!session}
                      onChange={(e) => setTruckInput(e.target.value)}
                      onBlur={() => handleSaveMetadata("truck")}
                      onKeyDown={(e) => e.key === "Enter" && handleSaveMetadata("truck")}
                      placeholder="TN-70-XX-0000"
                    />
                  </div>
                </div>
              </div>

              {errorMsg && <div className="error-box">{errorMsg}</div>}

              {tab === "STAGING" && (
                <form className="scan-bar" onSubmit={handleAddScan}>
                  <div className="dropdown-wrap">
                    <label>Scan Part Barcode or Type Part #</label>
                    <input
                      ref={partInputRef}
                      value={partQuery}
                      disabled={!isStagingEditable}
                      onChange={(e) => handlePartInputChange(e.target.value)}
                      placeholder={isStagingEditable ? "Scan part barcode or type to search..." : "Select a dock to scan"}
                    />
                    {showDropdown && (
                      <div className="dropdown-menu">
                        {partMatches.map((pm) => (
                          <div key={pm.part_number} className="dd-row" onClick={() => selectPartForQty(pm)}>
                            <div>
                              <div className="mono">{pm.part_number}</div>
                              <div style={{ fontSize: 12, color: "var(--muted)" }}>{pm.description}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div>
                    <label>Material Description (Backend Mapped)</label>
                    <input value={selectedPart?.description || ""} disabled placeholder="Auto-filled from Part Master" />
                  </div>

                  <div>
                    <label>Quantity</label>
                    <input
                      ref={qtyInputRef}
                      type="number"
                      min="1"
                      value={qtyInput}
                      disabled={!isStagingEditable}
                      onChange={(e) => setQtyInput(e.target.value)}
                      placeholder="Qty"
                    />
                  </div>

                  <button type="submit" className="btn btn-green" disabled={!isStagingEditable}>
                    + Add
                  </button>

                  <button
                    type="button"
                    className="btn btn-dark"
                    disabled={!isStagingEditable || (bundle?.rawLines.length || 0) === 0}
                    onClick={handleLockStaging}
                  >
                    Lock & Ready for Loading
                  </button>
                </form>
              )}
            </div>

            <div className="split-panes">
              <div className="card">
                <div className="pane-header">
                  <span className="pane-title">Individual Scanned Line Items ({bundle?.rawLines.length || 0})</span>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Part Number</th>
                        <th>Description</th>
                        <th>Qty</th>
                        <th>Time</th>
                        {isStagingEditable && <th>Action</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {(bundle?.rawLines || []).map((row, idx) => (
                        <tr key={row.scan_id}>
                          <td>{(bundle?.rawLines.length || 0) - idx}</td>
                          <td className="mono">{row.part_number}</td>
                          <td>{row.description}</td>
                          <td className="mono">{row.quantity}</td>
                          <td style={{ color: "var(--muted)" }}>{new Date(row.scanned_at).toLocaleTimeString()}</td>
                          {isStagingEditable && (
                            <td>
                              <button className="btn btn-danger" style={{ height: 28, padding: "0 8px" }} onClick={() => handleDeleteScan(row.scan_id)}>
                                ✕
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                      {(!bundle?.rawLines || bundle.rawLines.length === 0) && (
                        <tr><td colSpan={6} style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>No line items on this dock.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card">
                <div className="pane-header">
                  <div>
                    <span className="pane-title">Consolidated Dock Manifest ({consolidatedList.length} SKUs)</span>
                    <div className="mono" style={{ fontSize: 12, color: "var(--green-dark)", marginTop: 2 }}>
                      Total Units: {consolidatedList.reduce((sum, r) => sum + r.total_quantity, 0)}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ height: 34, padding: "0 12px", fontSize: 12 }}
                      disabled={consolidatedList.length === 0}
                      onClick={() => copyAlignedColumn(consolidatedList.map((c) => c.part_number), "PARTS")}
                    >
                      {copiedField === "PARTS" ? `✓ Copied ${consolidatedList.length} Parts` : "Copy Parts"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ height: 34, padding: "0 12px", fontSize: 12 }}
                      disabled={consolidatedList.length === 0}
                      onClick={() => copyAlignedColumn(consolidatedList.map((c) => c.total_quantity), "QTYS")}
                    >
                      {copiedField === "QTYS" ? `✓ Copied ${consolidatedList.length} Qtys` : "Copy Qtys"}
                    </button>
                  </div>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Part Number</th>
                        <th>Material Description</th>
                        <th>Scans</th>
                        <th>Consolidated Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consolidatedList.map((c) => (
                        <tr key={c.part_number}>
                          <td className="mono">{c.part_number}</td>
                          <td>{c.description}</td>
                          <td>{c.scan_count}</td>
                          <td className="mono" style={{ fontSize: 15, color: "#065f46" }}>{c.total_quantity}</td>
                        </tr>
                      ))}
                      {consolidatedList.length === 0 && (
                        <tr><td colSpan={4} style={{ textAlign: "center", padding: 28, color: "var(--muted)" }}>Consolidated totals appear here.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {tab === "LOADING" && session && (
                  <div className="loading-footer">
                    <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 700 }}>
                      Post-Loading Actions for {session.dock_number}:
                    </span>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="btn btn-green" onClick={() => handleFinalizeLoading("COMPLETE")}>
                        Complete Loading (Clear Screen)
                      </button>
                      <button className="btn btn-outline" onClick={() => handleFinalizeLoading("KEEP")}>
                        Keep Data (Until Next Batch)
                      </button>
                      <button className="btn btn-danger" onClick={() => handleFinalizeLoading("VOID")}>
                        Delete Data
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {tab === "PARTS" && (
          <div className="split-panes">
            <div className="card">
              <h3 style={{ marginTop: 0 }}>SAP Material Master Import</h3>
              <p style={{ fontSize: 13, color: "var(--muted)", marginBottom: 12 }}>
                Upload your SAP Excel/CSV sheet (<code>.xlsx</code>, <code>.xls</code>, <code>.csv</code>) or paste rows directly from Excel. Only <b>Material</b> and <b>Material Description</b> are extracted.
              </p>

              <div style={{ marginBottom: 12, padding: 12, background: "#f8fafc", border: "1.5px dashed var(--border)", borderRadius: 8 }}>
                <label>Option A: Upload SAP Sheet (.xlsx / .xls / .csv)</label>
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv,.tsv,.txt"
                  onChange={handleExcelFileUpload}
                  style={{ padding: "8px 10px", height: "auto" }}
                />
                {importFileName && (
                  <div style={{ fontSize: 12, color: "var(--green-dark)", fontWeight: 700, marginTop: 6 }}>
                    Loaded file: {importFileName}
                  </div>
                )}
              </div>

              <label>Option B: Paste Directly from Excel / SAP Export</label>
              <textarea
                rows={5}
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "1.5px solid var(--border)", fontFamily: "monospace", fontSize: 12 }}
                placeholder={"Material\tPlant\tValuation Type\tMaterial Description\n340A0000505D\tW004\t\tSHLDR BOLT HEX SKT HD M8X1.25X32-10.9 PT"}
                value={pasteText}
                onChange={(e) => handlePasteChange(e.target.value)}
              />

              {parsedPreview.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#065f46", marginBottom: 6 }}>
                    Extracted {parsedPreview.length} unique parts (showing first 5):
                  </div>
                  <table>
                    <thead>
                      <tr><th>Material (Extracted)</th><th>Material Description (Extracted)</th></tr>
                    </thead>
                    <tbody>
                      {parsedPreview.slice(0, 5).map((item) => (
                        <tr key={item.part_number}>
                          <td className="mono">{item.part_number}</td>
                          <td>{item.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                <select value={importMode} onChange={(e) => setImportMode(e.target.value as "MERGE" | "REPLACE")} style={{ width: 220 }}>
                  <option value="MERGE">Merge / Update Existing</option>
                  <option value="REPLACE">Replace Entire Catalog</option>
                </select>
                <button
                  className="btn btn-green"
                  disabled={parsedPreview.length === 0 || isImporting}
                  onClick={handleConfirmImport}
                >
                  {isImporting ? "Importing..." : `Import ${parsedPreview.length} Parts to DB`}
                </button>
              </div>
            </div>

            <div className="card">
              <h3 style={{ marginTop: 0 }}>Active Part Master ({allParts.length} latest shown)</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Material</th><th>Material Description</th></tr>
                  </thead>
                  <tbody>
                    {allParts.map((p) => (
                      <tr key={p.part_number}>
                        <td className="mono">{p.part_number}</td>
                        <td>{p.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {tab === "HISTORY" && (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Completed & Voided Dock Shipments</h3>
            <table>
              <thead>
                <tr>
                  <th>Dock</th>
                  <th>Status</th>
                  <th>OBD Number</th>
                  <th>Truck Number</th>
                  <th>Total Units</th>
                  <th>Completed At</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.map((h) => (
                  <tr key={h.session_id}>
                    <td className="mono">{h.dock_number}</td>
                    <td>{h.status}</td>
                    <td className="mono">{h.obd_number || "-"}</td>
                    <td className="mono">{h.truck_number || "-"}</td>
                    <td className="mono">{h.total_qty}</td>
                    <td>{h.completed_at ? new Date(h.completed_at).toLocaleString() : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
