import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export const VALID_DOCKS = [
  "DOCK-30", "DOCK-31", "DOCK-32",
  "DOCK-41", "DOCK-42", "DOCK-44",
  "DOCK-45", "DOCK-46", "DOCK-47", "DOCK-48"
];
