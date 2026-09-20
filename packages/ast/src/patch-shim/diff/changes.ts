import type {
  ClusterStatementASTNode,
} from '../../types.js';
import type {
  ModelPathSegment,
  PatchReason,
} from '../types.js';
import type { ClusterInfo } from '../track/tracker.js';

interface EditBase {
  cluster: ClusterInfo;
  targetPath: string;
  segments: ModelPathSegment[];
  reason: PatchReason;
}

/** A fine-grained textual edit within one source statement. */
export interface FineEdit extends EditBase {
  kind: 'fine';
  start: number;
  end: number;
  replacement: string;
  /** Owning serializable statement used for overlap escalation. */
  statement: ClusterStatementASTNode | null;
}

export type InsertZone =
  | { mode: 'before'; anchor: number }
  | { mode: 'append'; braceClose: number };

/** Insertion of a brand-new statement into a cluster body. */
export interface InsertEdit extends EditBase {
  kind: 'insert';
  zone: InsertZone;
  text: string;
  /** Model-child ordering key (nodes/subgraphs/edges rank). */
  order: number;
}

/** Removal of a complete cluster statement (node/edge/subgraph). */
export interface RemoveEdit extends EditBase {
  kind: 'remove';
  stmt: ClusterStatementASTNode;
}

/** Regenerate one whole statement (fallback for a single declaration). */
export interface RewriteStatementEdit extends EditBase {
  kind: 'rewrite-statement';
  stmt: ClusterStatementASTNode;
  replacement: string;
}

/** Regenerate an entire cluster body (merge / un-localizable target). */
export interface RewriteClusterEdit extends EditBase {
  kind: 'rewrite-cluster';
}

export type Edit =
  | FineEdit
  | InsertEdit
  | RemoveEdit
  | RewriteStatementEdit
  | RewriteClusterEdit;
