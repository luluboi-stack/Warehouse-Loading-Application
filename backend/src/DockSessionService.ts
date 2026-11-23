import { pool, VALID_DOCKS } from "./db";

export class DockSessionService {
  normalizeDock(raw: string): string {
    const clean = String(raw || "").trim().toUpperCase().replace(/\s+/g, "-");
    const dock = /^\d+$/.test(clean) ? `DOCK-${clean}` : clean;
    if (!VALID_DOCKS.includes(dock)) {
      throw new Error(`Invalid dock '${raw}'. Allowed: ${VALID_DOCKS.join(", ")}`);
    }
    return dock;
  }

  async getDocksOverview() {
    const res = await pool.query(`
      SELECT dock_number, session_id, status, obd_number, truck_number
      FROM dock_sessions
      WHERE status IN ('STAGING', 'READY_FOR_LOADING', 'KEPT')
    `);
    const map = new Map(res.rows.map((r) => [r.dock_number, r]));
    return VALID_DOCKS.map((dock) => ({
      dock_number: dock,
      ...(map.get(dock) || { session_id: null, status: "IDLE", obd_number: null, truck_number: null }),
    }));
  }

  async getActiveBundle(rawDock: string) {
    const dockNumber = this.normalizeDock(rawDock);
    const sessionRes = await pool.query(
      `SELECT * FROM dock_sessions
       WHERE dock_number = $1 AND status IN ('STAGING', 'READY_FOR_LOADING', 'KEPT')
       LIMIT 1`,
      [dockNumber]
    );

    if (sessionRes.rows.length === 0) {
      return { dockNumber, session: null, rawLines: [], consolidated: [] };
    }

    const session = sessionRes.rows[0];
    const [rawRes, consRes] = await Promise.all([
      pool.query(
        `SELECT sl.scan_id, sl.part_number, pm.description, sl.quantity, sl.scanned_at
         FROM scan_lines sl
         JOIN part_master pm ON pm.part_number = sl.part_number
         WHERE sl.session_id = $1
         ORDER BY sl.scanned_at DESC`,
        [session.session_id]
      ),
      pool.query(
        `SELECT part_number, description, total_quantity, scan_count
         FROM v_consolidated_manifest
         WHERE session_id = $1`,
        [session.session_id]
      ),
    ]);

    return {
      dockNumber,
      session,
      rawLines: rawRes.rows,
      consolidated: consRes.rows,
    };
  }

  async startSession(rawDock: string) {
    const dockNumber = this.normalizeDock(rawDock);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE dock_sessions
         SET status = 'COMPLETED', completed_at = NOW()
         WHERE dock_number = $1 AND status = 'KEPT'`,
        [dockNumber]
      );

      const existing = await client.query(
        `SELECT * FROM dock_sessions
         WHERE dock_number = $1 AND status IN ('STAGING', 'READY_FOR_LOADING')
         LIMIT 1`,
        [dockNumber]
      );

      if (existing.rows.length === 0) {
        await client.query(
          `INSERT INTO dock_sessions (dock_number, status) VALUES ($1, 'STAGING')`,
          [dockNumber]
        );
      }

      await client.query("COMMIT");
      return this.getActiveBundle(dockNumber);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async addScan(sessionId: string, rawPart: string, quantity: number) {
    const partNumber = String(rawPart || "").trim().toUpperCase();
    const qty = Number(quantity);

    if (/^\d{8,14}$/.test(partNumber)) {
      throw new Error("SU barcode detected. Only Part Numbers are allowed—please type or select a Part Number.");
    }
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new Error("Quantity must be a positive whole number.");
    }

    const sessionRes = await pool.query(`SELECT * FROM dock_sessions WHERE session_id = $1`, [sessionId]);
    const session = sessionRes.rows[0];
    if (!session) throw new Error("Dock session not found.");
    if (session.status !== "STAGING") throw new Error("Dock is locked. Scanning is disabled.");

    const partRes = await pool.query(
      `SELECT part_number FROM part_master WHERE part_number = $1 AND is_active = TRUE`,
      [partNumber]
    );
    if (partRes.rows.length === 0) {
      throw new Error(`Part '${partNumber}' not found in Part Master.`);
    }

    await pool.query(
      `INSERT INTO scan_lines (session_id, part_number, quantity) VALUES ($1, $2, $3)`,
      [sessionId, partNumber, qty]
    );

    return this.getActiveBundle(session.dock_number);
  }

  async updateScanQty(sessionId: string, scanId: string, quantity: number) {
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error("Quantity must be greater than 0.");

    const sessionRes = await pool.query(`SELECT * FROM dock_sessions WHERE session_id = $1`, [sessionId]);
    const session = sessionRes.rows[0];
    if (!session || session.status !== "STAGING") throw new Error("Cannot edit locked session.");

    await pool.query(`UPDATE scan_lines SET quantity = $1 WHERE scan_id = $2 AND session_id = $3`, [
      qty,
      scanId,
      sessionId,
    ]);
    return this.getActiveBundle(session.dock_number);
  }

  async deleteScan(sessionId: string, scanId: string) {
    const sessionRes = await pool.query(`SELECT * FROM dock_sessions WHERE session_id = $1`, [sessionId]);
    const session = sessionRes.rows[0];
    if (!session || session.status !== "STAGING") throw new Error("Cannot delete from locked session.");

    await pool.query(`DELETE FROM scan_lines WHERE scan_id = $1 AND session_id = $2`, [scanId, sessionId]);
    return this.getActiveBundle(session.dock_number);
  }

  async lockForLoading(sessionId: string) {
    const countRes = await pool.query(`SELECT COUNT(*)::INT AS cnt FROM scan_lines WHERE session_id = $1`, [sessionId]);
    if (countRes.rows[0].cnt === 0) {
      throw new Error("Scan at least one part before locking the dock.");
    }

    const res = await pool.query(
      `UPDATE dock_sessions
       SET status = 'READY_FOR_LOADING', locked_at = NOW()
       WHERE session_id = $1 AND status = 'STAGING'
       RETURNING dock_number`,
      [sessionId]
    );
    if (res.rows.length === 0) throw new Error("Session is not in STAGING state.");
    return this.getActiveBundle(res.rows[0].dock_number);
  }

  async updateMetadata(sessionId: string, obdNumber?: string, truckNumber?: string) {
    const res = await pool.query(
      `UPDATE dock_sessions
       SET obd_number = COALESCE($2, obd_number),
           truck_number = COALESCE($3, truck_number)
       WHERE session_id = $1
       RETURNING dock_number`,
      [
        sessionId,
        obdNumber !== undefined ? obdNumber.trim().toUpperCase() : null,
        truckNumber !== undefined ? truckNumber.trim().toUpperCase() : null,
      ]
    );
    if (res.rows.length === 0) throw new Error("Session not found.");
    return this.getActiveBundle(res.rows[0].dock_number);
  }

  async finalizeSession(sessionId: string, action: "COMPLETE" | "VOID" | "KEEP", truckNumber?: string) {
    const nextStatus = action === "COMPLETE" ? "COMPLETED" : action === "VOID" ? "VOIDED" : "KEPT";
    const completedAtClause = action === "KEEP" ? "completed_at" : "NOW()";

    const res = await pool.query(
      `UPDATE dock_sessions
       SET status = $2,
           truck_number = COALESCE($3, truck_number),
           completed_at = ${completedAtClause}
       WHERE session_id = $1
       RETURNING dock_number`,
      [sessionId, nextStatus, truckNumber ? truckNumber.trim().toUpperCase() : null]
    );
    if (res.rows.length === 0) throw new Error("Session not found.");
    return this.getActiveBundle(res.rows[0].dock_number);
  }
}
