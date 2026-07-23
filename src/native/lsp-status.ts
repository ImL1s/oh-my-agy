import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { redactDiagnostic } from '../runtime/redaction';
import { ensureContainedPath } from '../runtime/state-root';

export interface HostLspServerStatusV1 {
  server_id: string;
  command: string;
  command_available: boolean;
  registration_valid: boolean;
  transport: 'stdio' | 'socket';
  extensions: string[];
  status: 'configured_unobserved' | 'command_unavailable' | 'invalid_registration';
  evidence_tier: 'T0';
}

export interface HostLspStatusV1 {
  store_kind: 'oma_host_lsp_status';
  schema_version: 1;
  repository_id: 'OMA';
  status: 'unavailable' | 'configured_unobserved' | 'invalid';
  registration_sha256: string | null;
  registration_path_sha256: string;
  semantic_proxy_operations: 0;
  host_observation: 'unobserved';
  evidence_tier: 'T0';
  servers: HostLspServerStatusV1[];
  detail_code: string;
}

export interface HostLspStatusOptionsV1 {
  plugin_root: string;
  registration_relative_path?: string;
  command_available?: (command: string) => boolean;
}

interface ParsedLspServer {
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
  transport: 'stdio' | 'socket';
}

const MAX_REGISTRATION_BYTES = 256 * 1024;

/** Read and validate host-owned registration only; no LSP process is started. */
export function inspectHostLspStatus(
  options: Readonly<HostLspStatusOptionsV1>,
): HostLspStatusV1 {
  const root = realDirectory(options.plugin_root);
  const relative = options.registration_relative_path ?? '.lsp.json';
  const pathHash = sha256(path.resolve(options.plugin_root, relative));
  if (root === null || !safeRelative(relative)) return invalid(pathHash, 'LSP_REGISTRATION_PATH_INVALID');
  const target = ensureContainedPath(root, relative);
  if (!target.ok) return invalid(pathHash, 'LSP_REGISTRATION_OUTSIDE_ROOT');
  if (!fs.existsSync(target.value)) return unavailable(pathHash, 'LSP_REGISTRATION_MISSING');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target.value);
  } catch (_) {
    return invalid(pathHash, 'LSP_REGISTRATION_UNREADABLE');
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_REGISTRATION_BYTES) {
    return invalid(pathHash, 'LSP_REGISTRATION_NOT_BOUNDED_FILE');
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(target.value);
  } catch (_) {
    return invalid(pathHash, 'LSP_REGISTRATION_UNREADABLE');
  }
  const parsed = parseRegistration(bytes);
  if (parsed === null) return invalid(pathHash, 'LSP_REGISTRATION_SCHEMA_INVALID', sha256(bytes));
  const available = options.command_available ?? defaultCommandAvailable;
  const servers = Object.keys(parsed).sort(compareUtf8).map((serverId): HostLspServerStatusV1 => {
    const server = parsed[serverId];
    const commandAvailable = available(server.command);
    return {
      server_id: serverId,
      command: redactDiagnostic(server.command, 512),
      command_available: commandAvailable,
      registration_valid: true,
      transport: server.transport,
      extensions: Object.keys(server.extensionToLanguage).sort(compareUtf8),
      status: commandAvailable ? 'configured_unobserved' : 'command_unavailable',
      evidence_tier: 'T0',
    };
  });
  return {
    store_kind: 'oma_host_lsp_status',
    schema_version: 1,
    repository_id: 'OMA',
    status: 'configured_unobserved',
    registration_sha256: sha256(bytes),
    registration_path_sha256: pathHash,
    semantic_proxy_operations: 0,
    host_observation: 'unobserved',
    evidence_tier: 'T0',
    servers,
    detail_code: servers.some((server) => !server.command_available)
      ? 'LSP_CONFIGURED_COMMAND_UNAVAILABLE'
      : 'LSP_CONFIGURED_HOST_UNOBSERVED',
  };
}

function parseRegistration(bytes: Buffer): Record<string, ParsedLspServer> | null {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (_) { return null; }
  if (!plainObject(value)) return null;
  const container = plainObject(value.servers) ? value.servers : value;
  const output: Record<string, ParsedLspServer> = {};
  for (const [serverId, raw] of Object.entries(container)) {
    if (!safeServerId(serverId) || !plainObject(raw)) return null;
    if (!safeCommand(raw.command) || !stringArray(raw.args, 256, 4096)) return null;
    if (!plainObject(raw.extensionToLanguage) || !validExtensionMap(raw.extensionToLanguage)) return null;
    const transport = raw.transport === undefined ? 'stdio' : raw.transport;
    if (transport !== 'stdio' && transport !== 'socket') return null;
    output[serverId] = {
      command: raw.command,
      args: raw.args === undefined ? [] : [...raw.args],
      extensionToLanguage: { ...raw.extensionToLanguage } as Record<string, string>,
      transport,
    };
  }
  return output;
}

function invalid(
  pathHash: string,
  detailCode: string,
  registrationHash: string | null = null,
): HostLspStatusV1 {
  return base('invalid', pathHash, detailCode, registrationHash);
}

function unavailable(pathHash: string, detailCode: string): HostLspStatusV1 {
  return base('unavailable', pathHash, detailCode, null);
}

function base(
  status: HostLspStatusV1['status'],
  pathHash: string,
  detailCode: string,
  registrationHash: string | null,
): HostLspStatusV1 {
  return {
    store_kind: 'oma_host_lsp_status',
    schema_version: 1,
    repository_id: 'OMA',
    status,
    registration_sha256: registrationHash,
    registration_path_sha256: pathHash,
    semantic_proxy_operations: 0,
    host_observation: 'unobserved',
    evidence_tier: 'T0',
    servers: [],
    detail_code: detailCode,
  };
}

function defaultCommandAvailable(command: string): boolean {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
    encoding: 'utf8',
    timeout: 1_000,
    maxBuffer: 8 * 1024,
    shell: false,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function realDirectory(value: string): string | null {
  try {
    const target = fs.realpathSync(path.resolve(value));
    return fs.statSync(target).isDirectory() ? target : null;
  } catch (_) { return null; }
}

function safeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !path.isAbsolute(value)
    && !value.includes('\0') && !value.split(/[\\/]/u).includes('..');
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function safeServerId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}

function safeCommand(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[\0\r\n]/u.test(value);
}

function stringArray(value: unknown, maximumEntries: number, maximumBytes: number): value is string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.length <= maximumEntries
    && value.every((entry) => typeof entry === 'string'
      && Buffer.byteLength(entry, 'utf8') <= maximumBytes && !/[\0\r\n]/u.test(entry)));
}

function validExtensionMap(value: Record<string, unknown>): boolean {
  const entries = Object.entries(value);
  return entries.length <= 512 && entries.every(([extension, language]) =>
    /^\.[A-Za-z0-9._+-]{1,64}$/u.test(extension)
      && typeof language === 'string' && /^[A-Za-z0-9._+-]{1,128}$/u.test(language));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
