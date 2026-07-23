import { RuntimeError } from './errors';

export type {
  CanonicalPrimitive,
  CanonicalValue,
  VersionedStore,
} from '../contracts/state-schemas';
export type {
  CapabilityRecordV1,
  CapabilityTier,
} from '../contracts/capability';
export type {
  AntigravityNativeReceiptV1,
  ImportedCarrierV1,
  ImportedProvenanceReceiptV1,
  ParsedImportedCarrierV1,
} from '../contracts/carrier';
export type {
  LifecycleEventV1,
  TrackerProjectorLeaseV1,
  PrimaryPollerLeaseV1,
} from '../contracts/lifecycle';
export type {
  RecoveryManifestV1,
  ResumeCandidateV1,
} from '../contracts/resume';

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };
export type Result<T, E = RuntimeError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface Snapshot<T> {
  schemaVersion: number;
  revision: number;
  value: T;
}

export interface ProcessIdentity {
  pid: number;
  startMarker: string;
  parentPid?: number;
  paneId?: string;
  ownerNonce?: string;
}

export interface OperationIdentity {
  operationId: string;
  ownerNonce: string;
}

export interface Clock {
  now(): number;
}

export const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
};
