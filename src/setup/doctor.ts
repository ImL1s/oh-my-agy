import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveStateRoot } from '../runtime/state-root';
import { RuntimeError } from '../runtime/errors';
import { Result, ok } from '../runtime/types';
import {
  PluginCommandAdapter,
  readPackagePluginName,
  resolveHookEntrypoints,
  verifyPluginActive,
} from './plugin';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheckV1 {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  detail?: unknown;
}

export interface DoctorReportV1 {
  schemaVersion: 1;
  ok: boolean;
  exitCode: 0 | 1 | 2;
  packageRoot: string;
  packageVersion: string;
  checks: DoctorCheckV1[];
}

export interface RunDoctorInput {
  packageRoot: string;
  packageVersion?: string;
  agyCommand?: string;
  adapter?: PluginCommandAdapter;
  /** true：plugin 未 active 視為 fail（預設）；false：warn */
  strictPlugin?: boolean;
}

/**
 * 設計概念映射：對齊 OMX/OMG doctor — 形狀檢查，不打真 model。
 * exit 0=全 pass；1=有 fail；2=僅 warn（strict 下不會用）。
 */
export async function runDoctor(
  input: Readonly<RunDoctorInput>,
): Promise<Result<DoctorReportV1, RuntimeError>> {
  const packageRoot = path.resolve(input.packageRoot);
  const packageVersion = input.packageVersion ?? readPackageJsonVersion(packageRoot);
  const agyCommand = input.agyCommand ?? 'agy';
  const checks: DoctorCheckV1[] = [];

  checks.push(checkNodeVersion());
  checks.push(checkPackageRoot(packageRoot, packageVersion));
  checks.push(checkPluginManifestVersion(packageRoot, packageVersion));
  checks.push(checkHooks(packageRoot));
  checks.push(checkAgyOnPath(agyCommand));
  checks.push(checkStateRoot());

  const adapter = input.adapter ?? defaultAgyListAdapter(agyCommand);
  const pluginCheck = await checkPluginRegistry(packageRoot, adapter, input.strictPlugin !== false);
  checks.push(pluginCheck);

  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');
  const exitCode: 0 | 1 | 2 = hasFail ? 1 : hasWarn ? 2 : 0;

  return ok({
    schemaVersion: 1,
    ok: !hasFail,
    exitCode,
    packageRoot,
    packageVersion,
    checks,
  });
}

function checkNodeVersion(): DoctorCheckV1 {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major >= 20) {
    return { id: 'node', status: 'pass', message: `Node ${process.versions.node} (>=20)` };
  }
  return {
    id: 'node',
    status: 'fail',
    message: `Node ${process.versions.node} is below required >=20`,
  };
}

function checkPackageRoot(packageRoot: string, version: string): DoctorCheckV1 {
  const pkg = path.join(packageRoot, 'package.json');
  const bin = path.join(packageRoot, 'dist', 'bin', 'oma.js');
  if (!fs.existsSync(pkg)) {
    return { id: 'package_root', status: 'fail', message: 'package.json missing', detail: { packageRoot } };
  }
  if (!fs.existsSync(bin)) {
    return {
      id: 'package_root',
      status: 'fail',
      message: 'dist/bin/oma.js missing — run npm run build',
      detail: { bin },
    };
  }
  return {
    id: 'package_root',
    status: 'pass',
    message: `package root ready (v${version})`,
    detail: { packageRoot },
  };
}

function checkPluginManifestVersion(packageRoot: string, packageVersion: string): DoctorCheckV1 {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, 'plugin.json'), 'utf8')) as {
      version?: string;
      name?: string;
    };
    if (raw.version !== packageVersion) {
      return {
        id: 'version_sync',
        status: 'fail',
        message: `plugin.json version ${raw.version ?? 'missing'} != package.json ${packageVersion}`,
      };
    }
    return {
      id: 'version_sync',
      status: 'pass',
      message: `package.json and plugin.json both ${packageVersion}`,
      detail: { name: raw.name },
    };
  } catch (error) {
    return {
      id: 'version_sync',
      status: 'fail',
      message: 'plugin.json unreadable',
      detail: { cause: error instanceof Error ? error.message : String(error) },
    };
  }
}

function checkHooks(packageRoot: string): DoctorCheckV1 {
  const hooks = resolveHookEntrypoints(packageRoot);
  if (!hooks.ok) {
    return {
      id: 'hooks',
      status: 'fail',
      message: hooks.error.message,
      detail: hooks.error,
    };
  }
  return {
    id: 'hooks',
    status: 'pass',
    message: 'PreInvocation + Stop compiled entrypoints present',
    detail: hooks.value,
  };
}

function checkAgyOnPath(agyCommand: string): DoctorCheckV1 {
  const probe = spawnSync(agyCommand, ['plugin', 'help'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  if (probe.error) {
    return {
      id: 'agy_path',
      status: 'fail',
      message: `agy not runnable (${agyCommand}): ${probe.error.message}`,
    };
  }
  // help 可能 exit 0 或 1，重點是能 spawn
  return {
    id: 'agy_path',
    status: 'pass',
    message: `agy command reachable (${agyCommand})`,
    detail: { code: probe.status },
  };
}

function checkStateRoot(): DoctorCheckV1 {
  const state = resolveStateRoot({ create: true });
  if (!state.ok) {
    return {
      id: 'state_root',
      status: 'fail',
      message: state.error.message,
      detail: state.error,
    };
  }
  return {
    id: 'state_root',
    status: 'pass',
    message: `state root ok (${state.value.source})`,
    detail: { path: state.value.path },
  };
}

async function checkPluginRegistry(
  packageRoot: string,
  adapter: PluginCommandAdapter,
  strict: boolean,
): Promise<DoctorCheckV1> {
  const name = readPackagePluginName(packageRoot);
  if (!name.ok) {
    return { id: 'plugin_registry', status: 'fail', message: name.error.message };
  }
  const active = await verifyPluginActive({ packageRoot, adapter, pluginName: name.value });
  if (active.ok) {
    return {
      id: 'plugin_registry',
      status: 'pass',
      message: `plugin ${name.value} installed+enabled`,
      detail: {
        version: active.value.version,
        installPath: active.value.installPath,
      },
    };
  }
  return {
    id: 'plugin_registry',
    status: strict ? 'fail' : 'warn',
    message: active.error.message,
    detail: active.error,
  };
}

function readPackageJsonVersion(packageRoot: string): string {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof raw.version === 'string' ? raw.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function defaultAgyListAdapter(agyCommand: string): PluginCommandAdapter {
  return {
    async run(argv) {
      const result = spawnSync(agyCommand, [...argv], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      return {
        argv: [...argv],
        code: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? (result.error?.message ?? ''),
      };
    },
  };
}

export function doctorReportToLines(report: DoctorReportV1): string[] {
  const lines = [
    `oma doctor v${report.packageVersion}`,
    `packageRoot: ${report.packageRoot}`,
    `result: ${report.ok ? 'OK' : 'ISSUES'} (exit ${report.exitCode})`,
    '',
  ];
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗';
    lines.push(`${mark} [${check.id}] ${check.message}`);
  }
  lines.push('');
  if (!report.ok) {
    lines.push('Fix: npm run build && oma setup && re-run oma doctor');
  }
  return lines;
}
