import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import stripJsonComments from "strip-json-comments";
import { getAgentDir, getConfigDirName } from "./agent-dir.ts";
import type { McpConfig, ServerEntry } from "./types.ts";

interface PackageSetting {
  source: string;
}

interface PackageManifest {
  name?: unknown;
  pi?: { mcp?: unknown };
}

export function loadPackageMcpConfigs(cwd = process.cwd()): McpConfig {
  const mcpServers: Record<string, ServerEntry> = {};
  const seen = new Set<string>();

  for (const packageRoot of getConfiguredPackageRoots(cwd)) {
    const manifest = readPackageManifest(packageRoot);
    if (!manifest || typeof manifest.name !== "string" || !manifest.name) continue;
    const paths = getManifestMcpPaths(manifest.pi?.mcp, manifest.name);
    if (!paths) continue;

    const packagePrefix = formatPackageName(manifest.name);
    const packageServers = new Set<string>();
    for (const path of paths) {
      const configPath = resolvePackageConfigPath(packageRoot, path);
      if (!configPath) {
        console.warn(`Pi package ${manifest.name} skips MCP config ${path}: file must stay inside the package`);
        continue;
      }

      const config = readMcpConfig(configPath, manifest.name);
      if (!config) continue;
      for (const [serverName, server] of Object.entries(config.mcpServers)) {
        const normalizedName = `${packagePrefix}__${formatServerName(serverName)}`;
        if (packageServers.has(normalizedName) || seen.has(normalizedName)) {
          console.warn(`Pi package ${manifest.name} skips duplicate normalized MCP server ${normalizedName}`);
          continue;
        }
        packageServers.add(normalizedName);
        seen.add(normalizedName);
        mcpServers[normalizedName] = server;
      }
    }
  }

  return { mcpServers };
}

function getConfiguredPackageRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (const [settingsPath, scope] of [
    [join(cwd, getConfigDirName(), "settings.json"), "project"],
    [join(getAgentDir(), "settings.json"), "user"],
  ] as const) {
    const settings = readJson(settingsPath) as { packages?: unknown } | null;
    if (!Array.isArray(settings?.packages)) continue;
    for (const entry of settings.packages) {
      const source = typeof entry === "string"
        ? entry
        : entry && typeof entry === "object" && !Array.isArray(entry) && typeof (entry as PackageSetting).source === "string"
          ? (entry as PackageSetting).source
          : undefined;
      if (!source) continue;
      const root = resolvePackageRoot(source, scope, cwd);
      if (root && !roots.includes(root)) roots.push(root);
    }
  }
  return roots;
}

function resolvePackageRoot(source: string, scope: "user" | "project", cwd: string): string | null {
  const baseDir = scope === "user" ? getAgentDir() : join(cwd, getConfigDirName());
  if (source.startsWith("npm:")) {
    const name = source.slice(4).trim().match(/^(@?[^@]+(?:\/[^@]+)?)/)?.[1];
    return name ? resolveContainedPath(join(baseDir, "npm", "node_modules"), name) : null;
  }
  const gitSource = source.startsWith("git:")
    ? source.slice(4).trim()
    : /^(?:(?:https?|ssh):\/\/|git@[^:]+:)/.test(source) ? source : null;
  if (gitSource) {
    const value = gitSource
      .replace(/^ssh:\/\/git@/, "")
      .replace(/^git@([^:]+):/, "$1/")
      .replace(/^[a-z]+:\/\//i, "");
    const path = value.replace(/@[^/]+$/, "").replace(/\.git$/, "");
    return path && !path.startsWith("/") ? resolveContainedPath(join(baseDir, "git"), path) : null;
  }
  return isAbsolute(source) ? resolve(source) : resolve(baseDir, source);
}

function readPackageManifest(packageRoot: string): PackageManifest | null {
  const manifest = readJson(join(packageRoot, "package.json"));
  return manifest && typeof manifest === "object" && !Array.isArray(manifest) ? manifest as PackageManifest : null;
}

function getManifestMcpPaths(value: unknown, packageName: string): string[] | null {
  const paths = typeof value === "string" ? [value] : Array.isArray(value) && value.every((path): path is string => typeof path === "string") ? value : null;
  if (value !== undefined && !paths) console.warn(`Pi package ${packageName} ignores invalid pi.mcp manifest entry`);
  return paths;
}

function readMcpConfig(path: string, packageName: string): McpConfig | null {
  const config = readJson(path);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    console.warn(`Pi package ${packageName} skips invalid MCP config ${path}`);
    return null;
  }
  const servers = (config as { mcpServers?: unknown }).mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return { mcpServers: {} };
  const mcpServers: Record<string, ServerEntry> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server && typeof server === "object" && !Array.isArray(server)) {
      mcpServers[name] = server as ServerEntry;
    }
  }
  return { mcpServers };
}

function readJson(path: string): unknown | null {
  try {
    return JSON.parse(stripJsonComments(readFileSync(path, "utf8"), { trailingCommas: true }));
  } catch {
    return null;
  }
}

function resolveContainedPath(root: string, path: string): string | null {
  const resolved = resolve(root, path);
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel)) ? resolved : null;
}

function resolvePackageConfigPath(packageRoot: string, path: string): string | null {
  const lexicalPath = resolveContainedPath(packageRoot, path);
  if (!lexicalPath || !existsSync(lexicalPath) || !statSync(lexicalPath).isFile()) return null;
  try {
    const realPackageRoot = realpathSync(packageRoot);
    const realConfigPath = realpathSync(lexicalPath);
    return resolveContainedPath(realPackageRoot, realConfigPath);
  } catch {
    return null;
  }
}

function formatPackageName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "package";
}

function formatServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^[_-]+|[_-]+$/g, "") || "server";
}
