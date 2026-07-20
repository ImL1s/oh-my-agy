import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { SessionAggregateV1 } from '../continuation/session-aggregate';

export type GateKind =
  | 'requirements'
  | 'planning'
  | 'executing'
  | 'review'
  | 'qa'
  | 'production';

export interface GateEvidenceV1 {
  schemaVersion: 1;
  kind: GateKind;
  actor: string;
  validator: {
    id: string;
    version: string;
  };
  command: {
    argvDigest: string;
    exitCode: number;
    startedAt: string;
    finishedAt: string;
  };
  artifact: {
    path: string;
    digest: string;
  };
  repoKey: string | null;
  workspaceKey: string;
  gitHead: string | null;
  invocationNonce: string;
}

export interface AcceptedGateEvidence {
  kind: 'Accepted';
  evidence: GateEvidenceV1;
}

export interface RejectedGateEvidence {
  kind: 'Rejected';
  error: RuntimeError;
}

export type GateValidationResult = AcceptedGateEvidence | RejectedGateEvidence;

export class GateValidator {
  validate(
    kind: GateKind,
    evidence: unknown,
    snapshot: Readonly<SessionAggregateV1>,
  ): GateValidationResult {
    const parsed = parseEvidence(evidence);
    if (!parsed.ok) return { kind: 'Rejected', error: parsed.error };
    if (parsed.value.kind !== kind) {
      return reject('Gate evidence kind does not match the requested gate');
    }
    if (
      parsed.value.workspaceKey !== snapshot.workspaceKey
      || parsed.value.repoKey !== snapshot.repoKey
    ) {
      return reject('Gate evidence workspace identity does not match the aggregate');
    }
    if (parsed.value.command.exitCode !== 0) {
      return reject('Gate evidence command did not pass');
    }
    if (Date.parse(parsed.value.command.startedAt) > Date.parse(parsed.value.command.finishedAt)) {
      return reject('Gate evidence timestamps are reversed');
    }
    if (kind === 'review' && !parsed.value.validator.id.startsWith('oma.review/')) {
      return reject('Review evidence must come from the independent review runner');
    }
    if (kind === 'qa' && !parsed.value.validator.id.startsWith('oma.qa/')) {
      return reject('QA evidence must come from the QA runner');
    }
    if (kind === 'production' && parsed.value.validator.id !== 'oma.production-causal-trace/v1') {
      return reject('Production evidence requires the causal-trace validator');
    }
    return { kind: 'Accepted', evidence: parsed.value };
  }
}

function parseEvidence(evidence: unknown): Result<GateEvidenceV1, RuntimeError> {
  if (typeof evidence !== 'object' || evidence === null || Array.isArray(evidence)) {
    return err(runtimeError('E_CORRUPT_STATE', 'Gate evidence must be an object'));
  }
  const candidate = evidence as Partial<GateEvidenceV1>;
  if (typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 1) {
    return err(runtimeError('E_FUTURE_SCHEMA', 'Gate evidence uses a future schema'));
  }
  if (
    candidate.schemaVersion !== 1
    || !['requirements', 'planning', 'executing', 'review', 'qa', 'production'].includes(candidate.kind ?? '')
    || typeof candidate.actor !== 'string'
    || candidate.actor.trim() === ''
    || typeof candidate.validator !== 'object'
    || candidate.validator === null
    || typeof candidate.validator.id !== 'string'
    || typeof candidate.validator.version !== 'string'
    || typeof candidate.command !== 'object'
    || candidate.command === null
    || !isDigest(candidate.command.argvDigest)
    || !Number.isInteger(candidate.command.exitCode)
    || !isTimestamp(candidate.command.startedAt)
    || !isTimestamp(candidate.command.finishedAt)
    || typeof candidate.artifact !== 'object'
    || candidate.artifact === null
    || typeof candidate.artifact.path !== 'string'
    || candidate.artifact.path === ''
    || !isDigest(candidate.artifact.digest)
    || typeof candidate.workspaceKey !== 'string'
    || candidate.workspaceKey === ''
    || typeof candidate.invocationNonce !== 'string'
    || candidate.invocationNonce === ''
  ) {
    return err(runtimeError('E_CORRUPT_STATE', 'Gate evidence shape is invalid'));
  }
  return ok(candidate as GateEvidenceV1);
}

function reject(message: string): RejectedGateEvidence {
  return { kind: 'Rejected', error: runtimeError('E_CORRUPT_STATE', message) };
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

