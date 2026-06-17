import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TandemConfigSchema, defaultConfig, type TandemConfig } from "../../shared/config.js";

function mergeConfig(base: TandemConfig, override: Partial<TandemConfig>): TandemConfig {
  return {
    ...base,
    ...override,
    workspaces: (override.workspaces ?? base.workspaces).map((workspace) => ({
      ...workspace,
      allowedRepoPaths: workspace.allowedRepoPaths ?? []
    })),
    providers: { ...base.providers, ...(override.providers ?? {}) },
    roles: { ...base.roles, ...(override.roles ?? {}) },
    workflows: { ...base.workflows, ...(override.workflows ?? {}) },
    ideaTypes: { ...base.ideaTypes, ...(override.ideaTypes ?? {}) },
    defaults: {
      ...base.defaults,
      ...(override.defaults ?? {}),
      leftPane: { ...base.defaults.leftPane, ...(override.defaults?.leftPane ?? {}) },
      rightPane: { ...base.defaults.rightPane, ...(override.defaults?.rightPane ?? {}) }
    }
  };
}

function readConfigFile(path: string): Partial<TandemConfig> | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as Partial<TandemConfig>;
}

export function loadTandemConfig(workspaceRoot?: string): TandemConfig {
  const userPath = join(homedir(), ".twindem", "config.json");
  const legacyUserPath = join(homedir(), ".tandem", "config.json");
  const workspacePath = workspaceRoot ? join(workspaceRoot, ".twindem", "config.json") : undefined;
  const legacyWorkspacePath = workspaceRoot ? join(workspaceRoot, ".tandem", "config.json") : undefined;

  let merged = defaultConfig;
  const userConfig = readConfigFile(userPath) ?? readConfigFile(legacyUserPath);
  if (userConfig) merged = mergeConfig(merged, userConfig);

  if (workspacePath) {
    const workspaceConfig = readConfigFile(workspacePath) ?? (legacyWorkspacePath ? readConfigFile(legacyWorkspacePath) : null);
    if (workspaceConfig) merged = mergeConfig(merged, workspaceConfig);
  }

  return TandemConfigSchema.parse(merged);
}

export function saveUserTandemConfig(config: TandemConfig): TandemConfig {
  const parsed = TandemConfigSchema.parse(config);
  const dir = join(homedir(), ".twindem");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return parsed;
}

export function readTandemConfigFile(path: string): TandemConfig {
  return TandemConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeTandemConfigFile(path: string, config: TandemConfig): void {
  const parsed = TandemConfigSchema.parse(config);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}
