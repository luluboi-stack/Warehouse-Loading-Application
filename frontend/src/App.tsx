import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const API = `http://${window.location.hostname}:4000/api/v1`;
const socket = io(`http://${window.location.hostname}:4000`);

interface PartItem {
  part_number: string;
  description: string;
  default_pack_qty: number;
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
  const [csvText, setCsvText] = useState<string>("");
  const [importMode, setImportMode] = useState<"MERGE" | "REPLACE">("MERGE");
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

  const handleCsvImport = async () => {
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    const parsed = lines.map((line) => {
      const [part_number, description, default_pack_qty] = line.split(",").map((s) => s.trim());
      return { part_number, description, default_pack_qty: Number(default_pack_qty) || 1 };
    });
    const res = await fetch(`${API}/parts/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: parsed, mode: importMode }),
    });
    if (res.ok) {
      alert("Part Master updated successfully!");
      setCsvText("");
      loadPartsList();
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
                            <span style={{ fontSize: 11, fontWeight: 700 }}>Pack: {pm.default_pack_qty}</span>
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
                      title="Copy cumulative unique Part Numbers (one per line) for SAP Multiple Selection"
                    >
                      {copiedField === "PARTS" ? `✓ Copied ${consolidatedList.length} Parts` : "Copy Parts"}
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      style={{ height: 34, padding: "0 12px", fontSize: 12 }}
                      disabled={consolidatedList.length === 0}
                      onClick={() => copyAlignedColumn(consolidatedList.map((c) => c.total_quantity), "QTYS")}
                      title="Copy cumulative Consolidated Quantities (one per line, aligned with Parts)"
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
              <h3>Bulk Import Part Master (CSV Format)</h3>
              <p style={{ fontSize: 13, color: "var(--muted)" }}>
                Paste rows formatted as: <code>PART_NUMBER, DESCRIPTION, PACK_QTY</code>
              </p>
              <textarea
                rows={10}
                style={{ width: "100%", padding: 10, borderRadius: 8, border: "1.5px solid var(--border)", fontFamily: "monospace" }}
                placeholder={"ATH-NEW-001, Front Mudguard Assembly, 4\nATH-NEW-002, Rear Shock Absorber, 2"}
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
                <select value={importMode} onChange={(e) => setImportMode(e.target.value as "MERGE" | "REPLACE")} style={{ width: 220 }}>
                  <option value="MERGE">Merge / Update Existing</option>
                  <option value="REPLACE">Replace Entire Catalog</option>
                </select>
                <button className="btn btn-green" onClick={handleCsvImport}>Import to Database</button>
              </div>
            </div>

            <div className="card">
              <h3>Active Part Master ({allParts.length} shown)</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Part Number</th><th>Description</th><th>Default Pack</th></tr>
                  </thead>
                  <tbody>
                    {allParts.map((p) => (
                      <tr key={p.part_number}>
                        <td className="mono">{p.part_number}</td>
                        <td>{p.description}</td>
                        <td>{p.default_pack_qty}</td>
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
            <h3>Completed & Voided Dock Shipments</h3>
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
