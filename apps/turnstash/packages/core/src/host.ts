import { Match, Schema } from "effect";

export const HostOs = Schema.Literals(["darwin", "linux", "win32"]);
export type HostOs = typeof HostOs.Type;

export interface HostEnv {
  readonly os: HostOs;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export const hostEnvFromProcess = (): HostEnv => {
  const platform = process.platform;
  const os: HostOs = platform === "darwin" || platform === "win32" ? platform : "linux";
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return { os, home, env: process.env };
};

export const appDataDir = (host: HostEnv): string =>
  Match.value(host.os).pipe(
    Match.when("win32", () => host.env["APPDATA"] ?? `${host.home}\\AppData\\Roaming`),
    Match.when("darwin", () => `${host.home}/Library/Application Support`),
    Match.when("linux", () => host.env["XDG_CONFIG_HOME"] ?? `${host.home}/.config`),
    Match.exhaustive,
  );

export const localAppDataDir = (host: HostEnv): string =>
  Match.value(host.os).pipe(
    Match.when("win32", () => host.env["LOCALAPPDATA"] ?? `${host.home}\\AppData\\Local`),
    Match.when("darwin", () => `${host.home}/Library/Application Support`),
    Match.when("linux", () => host.env["XDG_DATA_HOME"] ?? `${host.home}/.local/share`),
    Match.exhaustive,
  );

export const configHome = (host: HostEnv): string =>
  host.os === "win32"
    ? (host.env["APPDATA"] ?? `${host.home}\\AppData\\Roaming`)
    : (host.env["XDG_CONFIG_HOME"] ?? `${host.home}/.config`);

export const stateHome = (host: HostEnv): string =>
  host.os === "win32"
    ? (host.env["LOCALAPPDATA"] ?? `${host.home}\\AppData\\Local`)
    : (host.env["XDG_STATE_HOME"] ?? `${host.home}/.local/state`);
