CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

DO $$ BEGIN CREATE TYPE dock_session_status AS ENUM ( 'STAGING', 'READY_FOR_LOADING', 'KEPT', 'COMPLETED', 'VOIDED' ); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS part_master (
  part_number       VARCHAR(50) PRIMARY KEY,
  description       TEXT NOT NULL,
  default_pack_qty  INTEGER NOT NULL DEFAULT 1 CHECK (default_pack_qty > 0),
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_part_master_part_trgm ON part_master USING GIN (part_number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_part_master_desc_trgm ON part_master USING GIN (description gin_trgm_ops);

CREATE TABLE IF NOT EXISTS dock_sessions (
  session_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dock_number       VARCHAR(20) NOT NULL,
  status            dock_session_status NOT NULL DEFAULT 'STAGING',
  obd_number        VARCHAR(40),
  truck_number      VARCHAR(30),
  staging_operator  VARCHAR(100) DEFAULT 'OPERATOR',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at         TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  CONSTRAINT chk_valid_dock CHECK (
    dock_number IN (
      'DOCK-30', 'DOCK-31', 'DOCK-32',
      'DOCK-41', 'DOCK-42', 'DOCK-44',
      'DOCK-45', 'DOCK-46', 'DOCK-47', 'DOCK-48'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_session_per_dock
  ON dock_sessions (dock_number)
  WHERE status IN ('STAGING', 'READY_FOR_LOADING', 'KEPT');

CREATE TABLE IF NOT EXISTS scan_lines (
  scan_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id        UUID NOT NULL REFERENCES dock_sessions(session_id) ON DELETE CASCADE,
  part_number       VARCHAR(50) NOT NULL REFERENCES part_master(part_number),
  quantity          INTEGER NOT NULL CHECK (quantity > 0),
  scanned_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_lines_session ON scan_lines (session_id, scanned_at DESC);

CREATE OR REPLACE VIEW v_consolidated_manifest AS
SELECT
  sl.session_id,
  sl.part_number,
  pm.description,
  SUM(sl.quantity)::INTEGER AS total_quantity,
  COUNT(sl.scan_id)::INTEGER AS scan_count
FROM scan_lines sl
JOIN part_master pm ON pm.part_number = sl.part_number
GROUP BY sl.session_id, sl.part_number, pm.description
ORDER BY sl.part_number ASC;

INSERT INTO part_master (part_number, description, default_pack_qty) VALUES
  ('ATH-450X-MTR01', 'PMSM Drive Motor 6.4kW - Gen4', 1),
  ('ATH-BAT-37KWH', 'Lithium-Ion Battery Pack 3.7 kWh', 1),
  ('ATH-DASH-7TFT', '7-Inch DeepView Touchscreen Dashboard', 4),
  ('ATH-CHAS-MAIN02', 'Cast Aluminum Main Frame Chassis', 1),
  ('ATH-BELT-GATES', 'Gates Carbon Drive Belt 142T', 10),
  ('ATH-CHGR-750W', 'Ather Duo Portable Charger 750W', 2),
  ('ATH-BRK-DISC200', 'Front Hydraulic Brake Disc 200mm', 5),
  ('ATH-HARN-HV04', 'High-Voltage Main Wiring Harness', 4),
  ('ATH-CTRL-MCU09', 'Motor Controller Unit (MCU) Gen4', 2),
  ('ATH-LED-HEAD01', 'Ather 450X LED Headlamp Assembly', 4)
ON CONFLICT (part_number) DO NOTHING;
