import type { GraphBaseModel } from '@ts-graphviz/common';
import type {
  AttributeASTNode,
  ClusterStatementASTNode,
  CommentASTNode,
} from '../../types.js';
import { createElementFactory } from '../../builder/create-element.js';
import { defaultPlugins as fromModelPlugins } from '../../model-shim/from-model/plugins/index.js';
import type { ConvertFromModelContext } from '../../model-shim/from-model/types.js';
import type { DotObjectModel } from '@ts-graphviz/common';

/**
 * Serialize the statements of a graph/subgraph model in the canonical order
 * used by fromModel, mirroring `convertClusterChildren` so rewritten bodies
 * round-trip exactly through {@link stringify} semantics.
 *
 * @internal
 */
export function serializeClusterStatements(
  model: GraphBaseModel,
  options: { commentKind?: 'Block' | 'Slash' | 'Macro' } = {},
): ClusterStatementASTNode[] {
  const createElement = createElementFactory();
  const commentKind = options.commentKind ?? 'Slash';
  const plugins = [...fromModelPlugins];
  const context: ConvertFromModelContext = {
    commentKind,
    createElement,
    convert<U extends DotObjectModel>(m: U) {
      for (const plugin of plugins) {
        if (plugin.match(m)) {
          return plugin.convert(context, m) as never;
        }
      }
      throw new Error('No from-model plugin');
    },
  };

  const out: ClusterStatementASTNode[] = [];
  for (const [key, value] of model.values) {
    out.push(attribute(createElement, key, value));
  }
  for (const attrs of Object.values(model.attributes)) {
    if (attrs.size > 0) {
      if (attrs.comment) {
        out.push(comment(createElement, attrs.comment, commentKind));
      }
      out.push(context.convert(attrs) as ClusterStatementASTNode);
    }
  }
  for (const node of model.nodes) {
    if (node.comment) {
      out.push(comment(createElement, node.comment, commentKind));
    }
    out.push(context.convert(node) as ClusterStatementASTNode);
  }
  for (const subgraph of model.subgraphs) {
    if (subgraph.comment) {
      out.push(comment(createElement, subgraph.comment, commentKind));
    }
    out.push(context.convert(subgraph) as ClusterStatementASTNode);
  }
  for (const edge of model.edges) {
    if (edge.comment) {
      out.push(comment(createElement, edge.comment, commentKind));
    }
    out.push(context.convert(edge) as ClusterStatementASTNode);
  }
  return out;
}

function attribute(
  createElement: ConvertFromModelContext['createElement'],
  key: string,
  value: unknown,
): AttributeASTNode {
  const stringValue = String(value);
  const html = /^<.+>$/ms.test(stringValue.trim());
  return createElement(
    'Attribute',
    {
      key: createElement('Literal', { value: key, quoted: false }, []),
      value: createElement(
        'Literal',
        html
          ? {
              value: stringValue.trim().slice(1, -1),
              quoted: 'html' as const,
            }
          : { value: stringValue, quoted: true },
        [],
      ),
    },
    [],
  );
}

function comment(
  createElement: ConvertFromModelContext['createElement'],
  value: string,
  kind: 'Block' | 'Slash' | 'Macro',
): CommentASTNode {
  return createElement('Comment', { kind, value }, []);
}
