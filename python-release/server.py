import json
import mimetypes
import os
import re
import sqlite3
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "ather_dock.db")
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DESIGNATED_DOCKS = [f"DOCK-{i}" for i in range(41, 51)]

MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


def get_db():
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def init_db():
    with get_db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS part_master (
              part_number TEXT PRIMARY KEY,
              description TEXT NOT NULL,
              default_pack_qty INTEGER NOT NULL DEFAULT 1,
              is_active INTEGER NOT NULL DEFAULT 1,
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS dock_sessions (
              session_id TEXT PRIMARY KEY,
              dock_number TEXT NOT NULL,
              status TEXT NOT NULL,
              obd_number TEXT,
              truck_number TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              locked_at TEXT,
              completed_at TEXT
            );

            CREATE TABLE IF NOT EXISTS scan_lines (
              scan_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              part_number TEXT NOT NULL,
              quantity INTEGER NOT NULL,
              scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (session_id) REFERENCES dock_sessions(session_id)
            );
            """
        )
        cnt = conn.execute("SELECT COUNT(*) AS cnt FROM part_master").fetchone()["cnt"]
        if cnt == 0:
            samples = [
                ("ATH-450X-MTR01", "PMSM Traction Motor Assembly 6.4kW", 1),
                ("ATH-BAT-37KWH", "3.7 kWh Li-Ion Battery Pack Gen 4", 1),
                ("ATH-CHAS-MAIN", "Hybrid Aluminum Main Frame Chassis", 1),
                ("ATH-DASH-7IN", "7-Inch TFT Touchscreen Dashboard Cluster", 4),
                ("ATH-CHGR-700W", "Ather Duo Portable Charger 700W", 5),
                ("ATH-BRK-DISC200", "200mm Hydraulic Front Brake Disc", 10),
                ("ATH-SUSP-MONO", "Rear Monoshock Suspension Unit", 4),
                ("ATH-HARN-HV01", "High Voltage Main Wiring Harness", 6),
                ("ATH-TYRE-9090", "90/90-12 Tubeless Front Tyre MRF", 5),
                ("ATH-MIR-SET02", "Rear View Mirror Assembly LH/RH Pair", 10),
            ]
            conn.executemany(
                "INSERT OR IGNORE INTO part_master (part_number, description, default_pack_qty) VALUES (?, ?, ?)",
                samples,
            )


def normalize_dock(raw: str) -> str:
    clean = str(raw or "").strip().upper()
    if not clean:
        raise ValueError("Dock number is required.")
    dock = f"DOCK-{clean}" if re.fullmatch(r"\d+", clean) else clean
    if dock not in DESIGNATED_DOCKS:
        raise ValueError(f"Invalid dock {dock}. Allowed docks: {', '.join(DESIGNATED_DOCKS)}")
    return dock


def get_docks_overview():
    with get_db() as conn:
        rows = conn.execute(
            """SELECT dock_number, status, session_id, obd_number, truck_number
               FROM dock_sessions
               WHERE status IN ('STAGING', 'READY_FOR_LOADING', 'KEPT')"""
        ).fetchall()
    active_map = {r["dock_number"]: dict(r) for r in rows}
    result = []
    for dock in DESIGNATED_DOCKS:
        a = active_map.get(dock)
        result.append(
            {
                "dock_number": dock,
                "status": a["status"] if a else "IDLE",
                "session_id": a["session_id"] if a else None,
                "obd_number": a["obd_number"] if a else None,
                "truck_number": a["truck_number"] if a else None,
            }
        )
    return result


def get_active_bundle(dock_raw: str):
    dock_number = normalize_dock(dock_raw)
    with get_db() as conn:
        session_row = conn.execute(
            """SELECT * FROM dock_sessions
               WHERE dock_number = ? AND status IN ('STAGING', 'READY_FOR_LOADING', 'KEPT')
               ORDER BY created_at DESC LIMIT 1""",
            (dock_number,),
        ).fetchone()

        if not session_row:
            return {"dockNumber": dock_number, "session": None, "rawLines": [], "consolidated": []}

        session = dict(session_row)
        raw_rows = conn.execute(
            """SELECT sl.scan_id, sl.part_number, pm.description, sl.quantity, sl.scanned_at
               FROM scan_lines sl
               JOIN part_master pm ON pm.part_number = sl.part_number
               WHERE sl.session_id = ?
               ORDER BY sl.rowid DESC""",
            (session["session_id"],),
        ).fetchall()

        cons_rows = conn.execute(
            """SELECT sl.part_number,
                      pm.description,
                      CAST(SUM(sl.quantity) AS INTEGER) AS total_quantity,
                      COUNT(sl.scan_id) AS scan_count
               FROM scan_lines sl
               JOIN part_master pm ON pm.part_number = sl.part_number
               WHERE sl.session_id = ?
               GROUP BY sl.part_number, pm.description
               ORDER BY MIN(sl.rowid) ASC""",
            (session["session_id"],),
        ).fetchall()

    return {
        "dockNumber": dock_number,
        "session": session,
        "rawLines": [dict(r) for r in raw_rows],
        "consolidated": [dict(r) for r in cons_rows],
    }


class AtherHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def send_json(self, status_code: int, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw)

    def serve_static(self, req_path: str):
        clean_path = req_path.lstrip("/") or "index.html"
        target = os.path.normpath(os.path.join(PUBLIC_DIR, clean_path))
        if not target.startswith(PUBLIC_DIR) or not os.path.isfile(target):
            target = os.path.join(PUBLIC_DIR, "index.html")
        if not os.path.isfile(target):
            self.send_json(404, {"error": "Frontend build not found in public/ folder."})
            return

        ext = os.path.splitext(target)[1].lower()
        ctype = MIME_OVERRIDES.get(ext) or mimetypes.guess_type(target)[0] or "application/octet-stream"
        with open(target, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        try:
            if path == "/api/v1/docks/overview":
                return self.send_json(200, get_docks_overview())

            m = re.fullmatch(r"/api/v1/docks/([^/]+)/active", path)
            if m:
                return self.send_json(200, get_active_bundle(m.group(1)))

            if path == "/api/v1/parts/search":
                q = (qs.get("q", [""])[0]).strip()
                with get_db() as conn:
                    if not q:
                        rows = conn.execute(
                            """SELECT part_number, description, default_pack_qty
                               FROM part_master WHERE is_active = 1
                               ORDER BY updated_at DESC, part_number ASC LIMIT 100"""
                        ).fetchall()
                    else:
                        like = f"%{q}%"
                        rows = conn.execute(
                            """SELECT part_number, description, default_pack_qty
                               FROM part_master
                               WHERE is_active = 1 AND (part_number LIKE ? OR description LIKE ?)
                               ORDER BY part_number ASC LIMIT 15""",
                            (like, like),
                        ).fetchall()
                return self.send_json(200, [dict(r) for r in rows])

            if path == "/api/v1/history":
                with get_db() as conn:
                    rows = conn.execute(
                        """SELECT ds.*,
                                  COALESCE((SELECT SUM(quantity) FROM scan_lines WHERE session_id = ds.session_id), 0) AS total_qty
                           FROM dock_sessions ds
                           WHERE status IN ('COMPLETED', 'VOIDED')
                           ORDER BY completed_at DESC LIMIT 100"""
                    ).fetchall()
                return self.send_json(200, [dict(r) for r in rows])

            return self.serve_static(path)
        except Exception as e:
            return self.send_json(400, {"error": str(e)})

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        try:
            body = self.read_json()

            m = re.fullmatch(r"/api/v1/docks/([^/]+)/session", path)
            if m:
                dock_number = normalize_dock(m.group(1))
                existing = get_active_bundle(dock_number)
                if existing["session"]:
                    return self.send_json(200, existing)
                with get_db() as conn:
                    conn.execute(
                        """INSERT INTO dock_sessions (session_id, dock_number, status, created_at)
                           VALUES (?, ?, 'STAGING', datetime('now'))""",
                        (str(uuid.uuid4()), dock_number),
                    )
                return self.send_json(201, get_active_bundle(dock_number))

            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/scans", path)
            if m:
                session_id = m.group(1)
                with get_db() as conn:
                    sess = conn.execute("SELECT * FROM dock_sessions WHERE session_id = ?", (session_id,)).fetchone()
                    if not sess:
                        raise ValueError("Session not found.")
                    if sess["status"] != "STAGING":
                        raise ValueError("Dock is locked. Cannot add scans.")

                    code = str(body.get("partNumber", "")).strip().upper()
                    if not code or re.fullmatch(r"\d{8,14}", code):
                        raise ValueError("SU barcode rejected. Scan or select a valid Part Number.")

                    qty = int(body.get("quantity", 0))
                    if qty <= 0:
                        raise ValueError("Quantity must be a positive whole number.")

                    part = conn.execute(
                        "SELECT 1 FROM part_master WHERE part_number = ? AND is_active = 1", (code,)
                    ).fetchone()
                    if not part:
                        raise ValueError(f"Part {code} not found in Part Master.")

                    conn.execute(
                        """INSERT INTO scan_lines (scan_id, session_id, part_number, quantity, scanned_at)
                           VALUES (?, ?, ?, ?, datetime('now'))""",
                        (str(uuid.uuid4()), session_id, code, qty),
                    )
                    dock_num = sess["dock_number"]
                return self.send_json(201, get_active_bundle(dock_num))

            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/finalize", path)
            if m:
                session_id = m.group(1)
                action = body.get("action")
                with get_db() as conn:
                    sess = conn.execute("SELECT * FROM dock_sessions WHERE session_id = ?", (session_id,)).fetchone()
                    if not sess:
                        raise ValueError("Session not found.")
                    if "truckNumber" in body:
                        truck = str(body.get("truckNumber") or "").strip().upper() or None
                        conn.execute("UPDATE dock_sessions SET truck_number = ? WHERE session_id = ?", (truck, session_id))

                    if action == "COMPLETE":
                        conn.execute(
                            "UPDATE dock_sessions SET status = 'COMPLETED', completed_at = datetime('now') WHERE session_id = ?",
                            (session_id,),
                        )
                    elif action == "KEEP":
                        conn.execute("UPDATE dock_sessions SET status = 'KEPT' WHERE session_id = ?", (session_id,))
                    elif action == "VOID":
                        conn.execute(
                            "UPDATE dock_sessions SET status = 'VOIDED', completed_at = datetime('now') WHERE session_id = ?",
                            (session_id,),
                        )
                    else:
                        raise ValueError("Invalid finalize action.")
                    dock_num = sess["dock_number"]
                return self.send_json(200, get_active_bundle(dock_num))

            if path == "/api/v1/parts/import":
                parts = body.get("parts") or []
                mode = body.get("mode", "MERGE")
                unique_map = {}
                for p in parts:
                    mat = str(p.get("part_number") or "").strip().upper()
                    desc = str(p.get("description") or "").strip()
                    if mat and desc:
                        unique_map[mat] = desc
                if not unique_map:
                    raise ValueError("No valid Material and Material Description pairs to import.")

                with get_db() as conn:
                    if mode == "REPLACE":
                        conn.execute("UPDATE part_master SET is_active = 0")
                    conn.executemany(
                        """INSERT INTO part_master (part_number, description, default_pack_qty, is_active, updated_at)
                           VALUES (?, ?, 1, 1, datetime('now'))
                           ON CONFLICT(part_number) DO UPDATE SET
                             description = excluded.description,
                             is_active = 1,
                             updated_at = datetime('now')""",
                        list(unique_map.items()),
                    )
                return self.send_json(200, {"success": True, "importedCount": len(unique_map)})

            return self.send_json(404, {"error": "Endpoint not found"})
        except Exception as e:
            return self.send_json(400, {"error": str(e)})

    def do_PATCH(self):
        path = unquote(urlparse(self.path).path)
        try:
            body = self.read_json()

            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/lock", path)
            if m:
                session_id = m.group(1)
                with get_db() as conn:
                    sess = conn.execute("SELECT * FROM dock_sessions WHERE session_id = ?", (session_id,)).fetchone()
                    if not sess:
                        raise ValueError("Session not found.")
                    cnt = conn.execute("SELECT COUNT(*) AS cnt FROM scan_lines WHERE session_id = ?", (session_id,)).fetchone()["cnt"]
                    if cnt == 0:
                        raise ValueError("Scan at least one part before locking the dock.")
                    conn.execute(
                        "UPDATE dock_sessions SET status = 'READY_FOR_LOADING', locked_at = datetime('now') WHERE session_id = ?",
                        (session_id,),
                    )
                    dock_num = sess["dock_number"]
                return self.send_json(200, get_active_bundle(dock_num))

            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/metadata", path)
            if m:
                session_id = m.group(1)
                with get_db() as conn:
                    sess = conn.execute("SELECT * FROM dock_sessions WHERE session_id = ?", (session_id,)).fetchone()
                    if not sess:
                        raise ValueError("Session not found.")
                    if "obdNumber" in body:
                        obd = str(body.get("obdNumber") or "").strip() or None
                        conn.execute("UPDATE dock_sessions SET obd_number = ? WHERE session_id = ?", (obd, session_id))
                    if "truckNumber" in body:
                        truck = str(body.get("truckNumber") or "").strip().upper() or None
                        conn.execute("UPDATE dock_sessions SET truck_number = ? WHERE session_id = ?", (truck, session_id))
                    dock_num = sess["dock_number"]
                return self.send_json(200, get_active_bundle(dock_num))

            return self.send_json(404, {"error": "Endpoint not found"})
        except Exception as e:
            return self.send_json(400, {"error": str(e)})

    def do_DELETE(self):
        path = unquote(urlparse(self.path).path)
        try:
            m = re.fullmatch(r"/api/v1/sessions/([^/]+)/scans/([^/]+)", path)
            if m:
                session_id, scan_id = m.group(1), m.group(2)
                with get_db() as conn:
                    sess = conn.execute("SELECT * FROM dock_sessions WHERE session_id = ?", (session_id,)).fetchone()
                    if not sess or sess["status"] != "STAGING":
                        raise ValueError("Cannot delete scan from locked session.")
                    conn.execute("DELETE FROM scan_lines WHERE scan_id = ? AND session_id = ?", (scan_id, session_id))
                    dock_num = sess["dock_number"]
                return self.send_json(200, get_active_bundle(dock_num))

            return self.send_json(404, {"error": "Endpoint not found"})
        except Exception as e:
            return self.send_json(400, {"error": str(e)})


if __name__ == "__main__":
    init_db()
    port = int(os.environ.get("PORT", "80"))
    httpd = ThreadingHTTPServer(("0.0.0.0", port), AtherHandler)
    print(f"Ather Dock Python Server running on http://0.0.0.0:{port}")
    httpd.serve_forever()
