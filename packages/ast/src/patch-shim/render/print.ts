import type { ClusterStatementASTNode } from '../../types.js';
import { defaultPlugins } from '../../dot-shim/printer/plugins/index.js';
import type { PrintContext } from '../../dot-shim/printer/types.js';

/**
 * Print a sequence of cluster statements (as produced by fromModel) as a
 * multiline body fragment, using the supplied EOL and child indentation.
 *
 * @internal
 */
export function printClusterStatements(
  statements: ClusterStatementASTNode[],
  options: { directed: boolean; eol: string; indent: string },
): string {
  const plugins = [...defaultPlugins];
  const { eol, indent } = options;
  const context: PrintContext = {
    directed: options.directed,
    EOL: eol,
    *printChildren(children) {
      yield eol;
      for (const child of children) {
        yield indent;
        yield* indentNested(context.print(child), indent);
        yield eol;
      }
    },
    *print(a) {
      for (const plugin of plugins) {
        if (plugin.match(a)) {
          yield* plugin.print(this, a);
          return;
        }
      }
      throw new Error(`No print plugin for ${a.type}`);
    },
    *join(array, separator) {
      for (let i = 0; i < array.length; i++) {
        yield* context.print(array[i]);
        if (i < array.length - 1) {
          yield separator;
        }
      }
    },
  };

  let out = '';
  for (const stmt of statements) {
    out += indent;
    out += Array.from(indentNested(context.print(stmt), indent)).join('');
    out += eol;
  }
  return out;
}

function* indentNested(
  chunks: Iterable<string>,
  indent: string,
): Generator<string> {
  let atLineStart = false;
  for (const chunk of chunks) {
    let rest = chunk;
    while (rest.length > 0) {
      if (atLineStart) {
        yield indent;
        atLineStart = false;
      }
      const nl = rest.indexOf('\n');
      if (nl === -1) {
        yield rest;
        rest = '';
      } else {
        yield rest.slice(0, nl + 1);
        rest = rest.slice(nl + 1);
        atLineStart = rest.length > 0;
      }
    }
  }
}
