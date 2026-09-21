import type { EdgeModel, NodeModel, SubgraphModel } from '@ts-graphviz/common';
import { createElement } from '../builder/index.js';
import { stringify } from '../dot-shim/printer/stringify.js';
import { fromModel } from '../model-shim/index.js';
import type { LiteralASTNode } from '../types.js';
import { printValueLiteral } from './literal.js';
import { detectEol } from './scan.js';

export interface SerializeOptions {
  /**
   * Prepend this indentation to every emitted line.
   */
  indent?: string;
  /**
   * End-of-line sequence to emit. Detected from the source by default.
   */
  eol?: '\r\n' | '\n';
}

function printerOptions(source: string, eol?: '\r\n' | '\n') {
  return {
    endOfLine: (eol ?? detectEol(source)) === '\r\n' ? 'crlf' : 'lf',
  } as const;
}

/**
 * Indent every non-empty line of `text` by `indent`.
 */
function reindent(text: string, indent: string): string {
  if (indent === '') {
    return text;
  }
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? indent + line : line))
    .join('\n');
}

/**
 * Serialize a brand-new node statement for insertion into a container body.
 *
 * @group Patch
 */
export function serializeNodeStatement(
  node: NodeModel,
  source: string,
  options: SerializeOptions = {},
): string {
  const ast = fromModel(node);
  const printed = stringify(ast, printerOptions(source, options.eol));
  return reindent(printed, options.indent ?? '');
}

/**
 * Serialize a brand-new edge statement.
 *
 * @group Patch
 */
export function serializeEdgeStatement(
  edge: EdgeModel,
  source: string,
  options: SerializeOptions = {},
): string {
  const ast = fromModel(edge);
  const printed = stringify(ast, printerOptions(source, options.eol));
  return reindent(printed, options.indent ?? '');
}

/**
 * Serialize a brand-new subgraph statement (including all of its content).
 *
 * @group Patch
 */
export function serializeSubgraphStatement(
  subgraph: SubgraphModel,
  source: string,
  options: SerializeOptions = {},
): string {
  const ast = fromModel(subgraph);
  const printed = stringify(ast, printerOptions(source, options.eol));
  return reindent(printed, options.indent ?? '');
}

/**
 * Serialize a single attribute for insertion inside an attribute list.
 *
 * The printer emits `key = "value";`, which is valid inside `[ ... ]` per the
 * DOT grammar. `style` mirrors the quote style of a nearby original attribute
 * when possible.
 *
 * @group Patch
 */
export function serializeListAttribute(
  key: string,
  value: unknown,
  style: LiteralASTNode['quoted'] = true,
): string {
  const valueText = printValueLiteral(String(value), style).text;
  return `${key} = ${valueText};`;
}

/**
 * Serialize a complete node/edge declaration (statement with a fresh
 * `[ ... ]` list) from a head text and attribute tuples. Used when a new
 * attribute list has to be synthesized onto a declaration that had none.
 *
 * @group Patch
 */
export function serializeBracketedList(
  attributes: ReadonlyArray<[string, unknown]>,
  style: LiteralASTNode['quoted'] = true,
): string {
  const parts = attributes
    .filter(([key]) => key !== 'comment')
    .map(
      ([key, value]) =>
        `${key} = ${printValueLiteral(String(value), style).text}`,
    );
  return `[${parts.join(', ')}]`;
}

/**
 * Serialize a default attribute list statement, e.g. `node [color=red;];`.
 *
 * @group Patch
 */
export function serializeDefaultListStatement(
  kind: 'graph' | 'node' | 'edge',
  attributes: ReadonlyArray<[string, unknown]>,
  source: string,
  options: SerializeOptions = {},
): string {
  const factory = createElement as unknown as (
    type: string,
    props: Record<string, unknown>,
    children?: unknown[],
  ) => never;
  const list = factory(
    'AttributeList',
    { kind: ({ graph: 'Graph', node: 'Node', edge: 'Edge' } as const)[kind] },
    attributes
      .filter(([key]) => key !== 'comment')
      .map(([key, value]) =>
        factory(
          'Attribute',
          {
            key: factory('Literal', { value: key, quoted: false }, []),
            value: factory(
              'Literal',
              {
                value: String(value),
                quoted: /^<.+>$/ms.test(String(value).trim()) ? 'html' : true,
              },
              [],
            ),
          },
          [],
        ),
      ),
  ) as unknown as import('../types.js').AttributeListASTNode;
  const printed = stringify(list, printerOptions(source, options.eol));
  return reindent(printed, options.indent ?? '');
}
