import type {
  ASTPathSegment,
  ModelPathSegment,
} from '../types.js';

/** Render structured model path segments as a stable dotted string. */
export function renderModelPath(segments: ModelPathSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.kind) {
        case 'graph':
          return 'graph';
        case 'subgraphs':
          return `subgraphs[${seg.index}]`;
        case 'nodes':
          return `nodes[${JSON.stringify(seg.key)}]`;
        case 'edges':
          return `edges[${seg.index}]`;
        case 'attribute':
          return `attributes.${seg.list}[${JSON.stringify(seg.key)}]`;
      }
    })
    .join('.');
}

/** Render AST path segments as a stable bracketed string. */
export function renderASTPath(segments: ASTPathSegment[]): string {
  return segments
    .map((seg) => {
      switch (seg.kind) {
        case 'dot':
          return 'dot';
        case 'graph':
          return 'graph';
        case 'child':
          return `children[${seg.index}]`;
        case 'edge-target':
          return `targets[${seg.index}]`;
      }
    })
    .join('.');
}
