import type { DotObjectModel } from '@ts-graphviz/common';
import { fromModel } from '../../model-shim/from-model/from-model.js';
import type {
  ASTNode,
  ClusterStatementASTNode,
  EdgeASTNode,
  GraphASTNode,
  NodeASTNode,
  SubgraphASTNode,
} from '../../types.js';
import { defaultPlugins } from '../../dot-shim/printer/plugins/index.js';
import type { PrintContext } from '../../dot-shim/printer/types.js';

/**
 * Canonical single-line rendering of a newly inserted or rewritten node / edge
 * statement. Attributes are rendered with the standard `key="value"` form,
 * which only appears inside the regenerated statement and never touches
 * unrelated source bytes.
 *
 * @internal
 */
export function serializeStatement(model: DotObjectModel): string {
  const ast = fromModel(model) as NodeASTNode | EdgeASTNode;
  return printNodeLike(ast, {
    directed: true,
    EOL: '\n',
  }).replace(/\n\s*/g, '');
}

/**
 * Fully serialize a subgraph model to canonical DOT text (multi-line body).
 *
 * @internal
 */
export function serializeSubgraph(
  model: DotObjectModel,
  options: { directed: boolean; eol: string; indent: string },
): string {
  const dot = fromModel(model) as unknown as {
    type: 'Dot';
    children: ClusterStatementASTNode[];
  };
  const graph = dot.children.find(
    (v): v is GraphASTNode => v.type === 'Graph',
  );
  const ast: SubgraphASTNode = {
    type: 'Subgraph',
    children: graph ? graph.children : [],
    id:
      model.id !== undefined
        ? {
            type: 'Literal',
            value: model.id,
            quoted: true,
            children: [],
          }
        : undefined,
  };
  return printSubgraph(ast, options);
}

function makeContext(opts: {
  directed: boolean;
  eol: string;
  indent: string;
}): PrintContext {
  const plugins = [...defaultPlugins];
  const context: PrintContext = {
    directed: opts.directed,
    EOL: opts.eol,
    *printChildren(children: ASTNode[]) {
      yield opts.eol;
      for (const child of children) {
        yield* indentEach(context.print(child), opts.indent);
        yield opts.eol;
      }
    },
    *print(a: ASTNode) {
      for (const plugin of plugins) {
        if (plugin.match(a)) {
          yield* plugin.print(this, a);
          return;
        }
      }
      throw new Error(`No print plugin for ${a.type}`);
    },
    *join(array: ASTNode[], separator: string) {
      for (let i = 0; i < array.length; i++) {
        yield* context.print(array[i]);
        if (i < array.length - 1) {
          yield separator;
        }
      }
    },
  };
  return context;
}

function* indentEach(
  chunks: Iterable<string>,
  indent: string,
): Generator<string> {
  let atLineStart = true;
  for (const chunk of chunks) {
    if (atLineStart && chunk.length > 0) {
      yield indent;
      atLineStart = false;
    }
    let emitted = chunk;
    while (emitted.length > 0) {
      const nl = emitted.indexOf('\n');
      if (nl === -1) {
        yield emitted;
        emitted = '';
        break;
      }
      yield emitted.slice(0, nl + 1);
      emitted = emitted.slice(nl + 1);
      if (emitted.length > 0) {
        yield indent;
      } else {
        atLineStart = true;
      }
    }
  }
}

function printNodeLike(
  ast: NodeASTNode | EdgeASTNode,
  opts: { directed: boolean; EOL: string },
): string {
  const plugins = [...defaultPlugins];
  const collected: string[] = [];
  const context: PrintContext = {
    directed: opts.directed,
    EOL: opts.EOL,
    *printChildren(children: ASTNode[]) {
      for (const child of children) {
        yield ' ';
        yield* context.print(child);
      }
      yield ' ';
    },
    *print(a: ASTNode) {
      for (const plugin of plugins) {
        if (plugin.match(a)) {
          yield* plugin.print(this, a);
          return;
        }
      }
      throw new Error(`No print plugin for ${a.type}`);
    },
    *join(array: ASTNode[], separator: string) {
      for (let i = 0; i < array.length; i++) {
        yield* context.print(array[i]);
        if (i < array.length - 1) {
          yield separator;
        }
      }
    },
  };
  for (const chunk of context.print(ast)) {
    collected.push(chunk);
  }
  return collected.join('');
}

function printSubgraph(
  ast: SubgraphASTNode,
  options: { directed: boolean; eol: string; indent: string },
): string {
  const context = makeContext(options);
  return Array.from(context.print(ast)).join('');
}

/**
 * Serialize the full body (statements between braces) of a cluster model,
 * using the given indentation for child statements.
 *
 * @internal
 */
export function serializeClusterBody(
  model: DotObjectModel,
  options: { directed: boolean; eol: string; indent: string },
): ClusterStatementASTNode[] {
  const dot = fromModel(model) as unknown as {
    type: 'Dot';
    children: ClusterStatementASTNode[];
  };
  const graph = dot.children.find(
    (v): v is GraphASTNode => v.type === 'Graph',
  );
  return graph ? graph.children : [];
}

/**
 * Print a list of cluster statements as a multiline block body (without the
 * enclosing braces), indented relative to the cluster header line.
 *
 * @internal
 */
export function printStatements(
  statements: ClusterStatementASTNode[],
  options: { directed: boolean; eol: string; indent: string },
): string {
  const context = makeContext(options);
  let out = '';
  for (const stmt of statements) {
    out += Array.from(context.print(stmt)).join('');
    out += options.eol;
  }
  return out;
}
