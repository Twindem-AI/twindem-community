import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export function tandemUserDataDir(): string {
  const dir = join(app.getPath("userData"), "data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function tandemDatabasePath(): string {
  return join(tandemUserDataDir(), "twindem.sqlite");
}
