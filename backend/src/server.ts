import express from "express";
import http from "http";
import path from "path";
import fs from "fs";
import cors from "cors";
import { Server } from "socket.io";
import dotenv from "dotenv";
import { pool } from "./db";
import { DockSessionService } from "./DockSessionService";

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, methods: ["GET", "POST", "PATCH", "DELETE"] },
});

app.use(cors({ origin: true }));
app.use(express.json({ limit: "25mb" }));

const dockService = new DockSessionService();

io.on("connection", (socket) => {
  socket.on("dock:join", (dockNumber: string) => {
    socket.join(`dock:${dockNumber}`);
  });
  socket.on("dock:leave", (dockNumber: string) => {
    socket.leave(`dock:${dockNumber}`);
  });
});

function broadcastDockUpdate(bundle: any) {
  if (bundle?.dockNumber) {
    io.to(`dock:${bundle.dockNumber}`).emit("dock:state_changed", bundle);
    io.emit("docks:overview_changed");
  }
}

app.get("/api/v1/docks/overview", async (_req, res) => {
  try {
    res.json(await dockService.getDocksOverview());
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/v1/docks/:dockNumber/active", async (req, res) => {
  try {
    res.json(await dockService.getActiveBundle(req.params.dockNumber));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/v1/docks/:dockNumber/session", async (req, res) => {
  try {
    const bundle = await dockService.startSession(req.params.dockNumber);
    broadcastDockUpdate(bundle);
    res.status(201).json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/v1/sessions/:sessionId/scans", async (req, res) => {
  try {
    const bundle = await dockService.addScan(req.params.sessionId, req.body.partNumber, req.body.quantity);
    broadcastDockUpdate(bundle);
    res.status(201).json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/v1/sessions/:sessionId/scans/:scanId", async (req, res) => {
  try {
    const bundle = await dockService.updateScanQty(req.params.sessionId, req.params.scanId, req.body.quantity);
    broadcastDockUpdate(bundle);
    res.json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/v1/sessions/:sessionId/scans/:scanId", async (req, res) => {
  try {
    const bundle = await dockService.deleteScan(req.params.sessionId, req.params.scanId);
    broadcastDockUpdate(bundle);
    res.json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/v1/sessions/:sessionId/lock", async (req, res) => {
  try {
    const bundle = await dockService.lockForLoading(req.params.sessionId);
    broadcastDockUpdate(bundle);
    res.json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.patch("/api/v1/sessions/:sessionId/metadata", async (req, res) => {
  try {
    const bundle = await dockService.updateMetadata(req.params.sessionId, req.body.obdNumber, req.body.truckNumber);
    broadcastDockUpdate(bundle);
    res.json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/v1/sessions/:sessionId/finalize", async (req, res) => {
  try {
    const bundle = await dockService.finalizeSession(req.params.sessionId, req.body.action, req.body.truckNumber);
    broadcastDockUpdate(bundle);
    res.json(bundle);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/v1/parts/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    if (!q) {
      const all = await pool.query(
        `SELECT part_number, description, default_pack_qty
         FROM part_master WHERE is_active = TRUE
         ORDER BY updated_at DESC, part_number ASC LIMIT 100`
      );
      return res.json(all.rows);
    }
    const result = await pool.query(
      `SELECT part_number, description, default_pack_qty
       FROM part_master
       WHERE is_active = TRUE AND (part_number ILIKE $1 OR description ILIKE $1)
       ORDER BY part_number ASC LIMIT 15`,
      [`%${q}%`]
    );
    res.json(result.rows);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/v1/parts/import", async (req, res) => {
  const { parts, mode } = req.body as {
    parts: Array<{ part_number: string; description: string }>;
    mode: "MERGE" | "REPLACE";
  };

  if (!Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: "No valid Material and Material Description rows found." });
  }

  const uniqueMap = new Map<string, string>();
  for (const p of parts) {
    const mat = String(p.part_number || "").trim().toUpperCase();
    const desc = String(p.description || "").trim();
    if (mat && desc) {
      uniqueMap.set(mat, desc);
    }
  }

  const matArray = Array.from(uniqueMap.keys());
  const descArray = Array.from(uniqueMap.values());

  if (matArray.length === 0) {
    return res.status(400).json({ error: "No valid Material and Material Description pairs to import." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (mode === "REPLACE") {
      await client.query(`UPDATE part_master SET is_active = FALSE`);
    }

    await client.query(
      `INSERT INTO part_master (part_number, description, default_pack_qty, is_active, updated_at)
       SELECT m, d, 1, TRUE, NOW()
       FROM UNNEST($1::text[], $2::text[]) AS t(m, d)
       ON CONFLICT (part_number) DO UPDATE
       SET description = EXCLUDED.description,
           is_active = TRUE,
           updated_at = NOW()`,
      [matArray, descArray]
    );

    await client.query("COMMIT");
    res.json({ success: true, importedCount: matArray.length });
  } catch (e: any) {
    await client.query("ROLLBACK");
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.get("/api/v1/history", async (_req, res) => {
  try {
    const rows = await pool.query(
      `SELECT ds.*, COALESCE((SELECT SUM(quantity) FROM scan_lines WHERE session_id = ds.session_id), 0)::INT AS total_qty
       FROM dock_sessions ds
       WHERE status IN ('COMPLETED', 'VOIDED')
       ORDER BY completed_at DESC LIMIT 100`
    );
    res.json(rows.rows);
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

const frontendDist = path.resolve(__dirname, "../../frontend/dist");
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/socket.io")) {
      return next();
    }
    res.sendFile(path.join(frontendDist, "index.html"));
  });
}

const PORT = process.env.PORT || 4000;
server.listen(Number(PORT), "0.0.0.0", () => console.log(`Ather Dock Server running on http://0.0.0.0:${PORT}`));
