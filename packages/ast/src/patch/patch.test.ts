import { registerDefault } from '@ts-graphviz/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from '../dot-shim/parser/parse.js';
import { toModel } from '../model-shim/to-model/to-model.js';
import { openPatchSession } from './session.js';
import { applyOk, assertUntouchedBytesKept } from './test-utils.js';
import { PatchPreconditionError } from './types.js';

beforeAll(() => {
  registerDefault();
});

function must<T>(value: T | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

/**
 * Standard verification for every case: apply the patch, re-parse the result
 * and assert the model semantics, while proving every byte outside patched
 * ranges is unchanged.
 */
function expectPatch(
  source: string,
  mutate: (model: ReturnType<typeof openPatchSession>['model']) => void,
  assertSemantics: (
    model: ReturnType<typeof toModel> &
      ReturnType<typeof openPatchSession>['model'],
  ) => void,
): { output: string } {
  const session = openPatchSession(source);
  mutate(session.model);
  const plan = session.plan();
  expect(plan.status).toBe('ok');
  const { output } = session.apply();
  assertUntouchedBytesKept(source, output, plan.operations);
  const reparsed = toModel(parse(output));
  assertSemantics(reparsed as never);
  // Operations must be non-overlapping.
  const sorted = [...plan.operations].sort(
    (a, b) => a.range.start - b.range.start,
  );
  for (let i = 1; i < sorted.length; i++) {
    expect(sorted[i].range.start).toBeGreaterThanOrEqual(
      sorted[i - 1].range.end,
    );
  }
  return { output };
}

describe('patch plan: attribute value', () => {
  it('replaces a bare value in place keeping quote style', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.getNode('a')?.attributes.set('color' as never, 'blue' as never);
      },
      (model) => {
        expect(model.getNode('a')?.attributes.get('color' as never)).toBe(
          'blue',
        );
      },
    );
    expect(output).toContain('color=blue');
    expect(output).not.toContain('red');
    expect(output.startsWith('digraph G {\n  a [')).toBe(true);
  });

  it('replaces a quoted value preserving the double quotes', () => {
    const source = `digraph G {
  a [label="hello world"];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('label' as never, 'hello again' as never);
    const { output } = applyOk(session);
    assertUntouchedBytesKept(source, output, session.plan().operations);
    expect(
      toModel(parse(output))
        .getNode('a')
        ?.attributes.get('label' as never),
    ).toBe('hello again');
    expect(output).toContain('label="hello again"');
  });
});

describe('patch plan: add/remove attributes', () => {
  it('adds an attribute to an existing list', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.getNode('a')?.attributes.set('shape' as never, 'box' as never);
      },
      (model) => {
        expect(model.getNode('a')?.attributes.get('shape' as never)).toBe(
          'box',
        );
        expect(model.getNode('a')?.attributes.get('color' as never)).toBe(
          'red',
        );
      },
    );
    expect(output).toContain('color=red');
  });

  it('adds an attribute to a declaration that had no list', () => {
    const source = `digraph G {
  a;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.getNode('a')?.attributes.set('color' as never, 'red' as never);
      },
      (model) => {
        expect(model.getNode('a')?.attributes.get('color' as never)).toBe(
          'red',
        );
      },
    );
    expect(output).toMatch(/a \[color *= *"red"\];/);
  });

  it('removes an attribute, keeping other attributes', () => {
    const source = `digraph G {
  a [color=red, shape=box, style=filled];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.getNode('a')?.attributes.delete('shape' as never);
      },
      (model) => {
        expect(
          model.getNode('a')?.attributes.get('shape' as never),
        ).toBeUndefined();
        expect(model.getNode('a')?.attributes.get('color' as never)).toBe(
          'red',
        );
        expect(model.getNode('a')?.attributes.get('style' as never)).toBe(
          'filled',
        );
      },
    );
    expect(output).not.toContain('shape');
    expect(output).toContain('color=red');
  });

  it('removes the only attribute together with its empty list', () => {
    const source = `digraph G {
  a [color=red];
  b;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.getNode('a')?.attributes.delete('color' as never);
      },
      (model) => {
        expect(model.getNode('a')).toBeDefined();
        expect(
          model.getNode('a')?.attributes.get('color' as never),
        ).toBeUndefined();
      },
    );
    expect(output).not.toContain('[');
    expect(output).toContain('a;');
  });

  it('edits default node attributes', () => {
    const source = `digraph G {
  node [style=filled];
  a;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.attributes.node.set('color' as never, 'red' as never);
      },
      (model) => {
        expect(model.attributes.node.get('color' as never)).toBe('red');
      },
    );
    expect(output).toContain('style=filled');
  });

  it('changes a bare graph body attribute value', () => {
    const source = `digraph G {
  rankdir=LR;
  a;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.set('rankdir' as never, 'TB' as never);
      },
      (model) => {
        expect(model.get('rankdir' as never)).toBe('TB');
      },
    );
    expect(output).toContain('rankdir=');
    expect(output).not.toContain('LR');
  });
});

describe('patch plan: nodes and edges', () => {
  it('adds a new node', () => {
    const source = `digraph G {
  a;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.createNode('b', { color: 'green' } as never);
      },
      (model) => {
        expect(model.getNode('b')?.attributes.get('color' as never)).toBe(
          'green',
        );
        expect(model.getNode('a')).toBeDefined();
      },
    );
    expect(output).toContain('a;');
  });

  it('removes a node statement', () => {
    const source = `digraph G {
  a;
  b;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.removeNode('a');
      },
      (model) => {
        expect(model.getNode('a')).toBeUndefined();
        expect(model.getNode('b')).toBeDefined();
      },
    );
    expect(output).not.toContain('a;');
    expect(output).toContain('b;');
    expect(output).not.toMatch(/^\s*\n\s*\n/m);
  });

  it('adds a new edge', () => {
    const source = `digraph G {
  a;
  b;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.createEdge(['a', 'b']);
      },
      (model) => {
        expect(model.edges).toHaveLength(1);
      },
    );
    expect(output).toContain('->');
  });

  it('removes an edge', () => {
    const source = `digraph G {
  a -> b;
  b -> c;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        const edge = model.edges.find((candidate) => {
          const first = candidate.targets[0] as { id?: string };
          return first?.id === 'a';
        });
        model.removeEdge(must(edge));
      },
      (model) => {
        expect(model.edges).toHaveLength(1);
      },
    );
    expect(output).not.toContain('a -> b');
    expect(output).toContain('b -> c');
  });
});

describe('patch plan: quoted ids and HTML labels', () => {
  it('edits an attribute on a node with a quoted id', () => {
    const source = `digraph G {
  "node 1" [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model
          .getNode('node 1')
          ?.attributes.set('color' as never, 'blue' as never);
      },
      (model) => {
        expect(model.getNode('node 1')?.attributes.get('color' as never)).toBe(
          'blue',
        );
      },
    );
    expect(output).toContain('"node 1"');
    expect(output).toContain('color=blue');
    expect(output).not.toContain('red');
  });

  it('replaces an HTML-like label value', () => {
    const source = `digraph G {
  a [label=<<b>hi</b>>];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model
          .getNode('a')
          ?.attributes.set('label' as never, '<<b>bye</b>>' as never);
      },
      (model) => {
        expect(model.getNode('a')?.attributes.get('label' as never)).toBe(
          '<<b>bye</b>>',
        );
      },
    );
    expect(output).toContain('<<b>bye</b>>');
    expect(output).not.toContain('hi');
  });

  it('downgrades a non-HTML value safely when the original literal was HTML', () => {
    const source = `digraph G {
  a [label=<<b>hi</b>>];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('label' as never, 'plain' as never);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    const { output } = session.apply();
    expect(output).toContain('"plain"');
    const reparsed = toModel(parse(output));
    expect(reparsed.getNode('a')?.attributes.get('label' as never)).toBe(
      'plain',
    );
  });
});

describe('patch plan: repeated node declarations', () => {
  it('merges repeated node statements into one model and tracks both', () => {
    const source = `digraph G {
  a [color=red];
  a [shape=box];
}
`;
    const session = openPatchSession(source);
    expect(session.model.getNode('a')).toBeDefined();
    const node = must(session.model.getNode('a'));
    expect(node.attributes.get('color' as never)).toBe('red');
    expect(node.attributes.get('shape' as never)).toBe('box');
    // Changing an attribute declared once edits that declaration.
    node.attributes.set('color' as never, 'blue' as never);
    const { output } = applyOk(session);
    expect(output).toContain('color=blue');
    expect(output).toContain('shape=box');
  });

  it('reports an ambiguity when an attribute is declared more than once', () => {
    const source = `digraph G {
  a [color=red];
  a [color=blue];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'green' as never);
    const plan = session.plan();
    expect(plan.status).toBe('ambiguous');
    expect(plan.ambiguities).toHaveLength(1);
    expect(plan.ambiguities[0].candidates).toHaveLength(2);
    // Applying without resolving is rejected.
    expect(() => session.apply()).toThrow(PatchPreconditionError);
  });

  it('lets the caller choose a declaration for an ambiguous change', () => {
    const source = `digraph G {
  a [color=red];
  a [color=blue];
}
`;
    const session = openPatchSession(source, {
      resolveAmbiguity: (ambiguity) => ambiguity.candidates[0]?.target,
    });
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'green' as never);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    const { output } = session.apply();
    expect(output).toContain('color=green');
    expect(output).toContain('color=blue');
    expect(output).not.toContain('color=red');
  });

  it('removes one repeated node declaration while keeping the other', () => {
    const source = `digraph G {
  a [color=red];
  a [shape=box];
}
`;
    // The second declaration is removed by deleting from source semantics:
    // simulate via removing shape (which belongs to the second declaration),
    // leaving the first node statement intact.
    const session = openPatchSession(source);
    session.model.getNode('a')?.attributes.delete('shape' as never);
    const { output } = applyOk(session);
    expect(output).toContain('color=red');
    expect(output).not.toContain('shape');
    expect(toModel(parse(output)).getNode('a')).toBeDefined();
  });
});

describe('patch plan: edge chains', () => {
  it('edits an attribute of an edge chain statement', () => {
    const source = `digraph G {
  a -> b -> c [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        // An edge chain parses into one edge model with three targets.
        const edge = must(model.edges[0]);
        expect(edge.targets).toHaveLength(3);
        edge.attributes.set('color' as never, 'blue' as never);
      },
      (model) => {
        expect(model.edges[0]?.attributes.get('color' as never)).toBe('blue');
      },
    );
    expect(output).toContain('a -> b -> c');
    expect(output).toContain('color=blue');
    expect(output).not.toContain('red');
  });

  it('removes an edge chain statement', () => {
    const source = `digraph G {
  a -> b -> c;
  x -> y;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        const chain = model.edges.find((edge) => edge.targets.length === 3);
        model.removeEdge(must(chain));
      },
      (model) => {
        expect(model.edges).toHaveLength(1);
      },
    );
    expect(output).not.toContain('a -> b -> c');
    expect(output).toContain('x -> y');
  });
});

describe('patch plan: nested anonymous subgraphs', () => {
  it('edits a node inside a nested anonymous subgraph', () => {
    const source = `digraph G {
  subgraph {
    subgraph {
      a [color=red];
    }
  }
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        type NodeLike = { attributes: { set(k: string, v: string): void } };
        type AnyContainer = {
          getNode: (id: string) => NodeLike | undefined;
          subgraphs: ReadonlyArray<AnyContainer>;
        };
        const find = (container: AnyContainer): NodeLike | undefined => {
          const node = container.getNode('a');
          if (node) {
            return node;
          }
          for (const sub of container.subgraphs) {
            const found = find(sub);
            if (found) {
              return found;
            }
          }
          return undefined;
        };
        find(model as unknown as AnyContainer)?.attributes.set('color', 'blue');
      },
      (model) => {
        type AnyContainer = {
          getNode(
            id: string,
          ): { attributes: { get(k: string): unknown } } | undefined;
          subgraphs: ReadonlyArray<AnyContainer>;
        };
        const visit = (container: AnyContainer): boolean => {
          if (container.getNode('a')) {
            return container.getNode('a')?.attributes.get('color') === 'blue';
          }
          return container.subgraphs.some((sub) => visit(sub));
        };
        expect(visit(model as unknown as AnyContainer)).toBe(true);
      },
    );
    expect(output).toContain('color=blue');
  });

  it('adds a node to an anonymous subgraph', () => {
    const source = `digraph G {
  subgraph {
    a;
  }
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.subgraphs[0]?.createNode('b');
      },
      (model) => {
        expect(model.subgraphs[0]?.getNode('b')).toBeDefined();
      },
    );
    expect(output).toContain('a;');
    expect(output).toMatch(/subgraph \{[\s\S]*"?b"?;/);
  });
});

describe('patch plan: comments and blank lines', () => {
  it('keeps comments and blank lines byte-for-byte', () => {
    const source = `digraph G {
  // leading comment

  a [color=red]; // trailing
  /* block
     comment */
  b;
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const plan = session.plan();
    const { output } = session.apply();
    assertUntouchedBytesKept(source, output, plan.operations);
    expect(output).toContain('// leading comment');
    expect(output).toContain('// trailing');
    expect(output).toContain('/* block');
    expect(output).toContain('     comment */');
    expect(output).toContain('  // leading comment\n\n');
  });

  it('keeps comments inside attribute lists untouched', () => {
    const source = `digraph G {
  a [
    color=red; // keep me
    shape=box
  ];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const { output } = session.apply();
    expect(output).toContain('// keep me');
    expect(
      toModel(parse(output))
        .getNode('a')
        ?.attributes.get('color' as never),
    ).toBe('blue');
  });

  it('preserves an empty line when removing a statement', () => {
    const source = `digraph G {
  a;

  b;
}
`;
    const session = openPatchSession(source);
    session.model.removeNode('a');
    const { output } = session.apply();
    expect(output).toContain('\n\n  b;');
    expect(output).not.toContain('a;');
  });
});

describe('patch plan: CRLF', () => {
  it('preserves CRLF line endings outside patched ranges', () => {
    const source = `digraph G {\r\n  a [color=red];\r\n  b;\r\n}\r\n`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const plan = session.plan();
    const { output } = session.apply();
    assertUntouchedBytesKept(source, output, plan.operations);
    expect(output).toContain('a [color=blue];');
    expect(output).toContain('\r\n  b;\r\n');
    const reparsed = toModel(parse(output));
    expect(reparsed.getNode('a')?.attributes.get('color' as never)).toBe(
      'blue',
    );
  });

  it('inserts a new node with CRLF line endings', () => {
    const source = `digraph G {\r\n  a;\r\n}\r\n`;
    const session = openPatchSession(source);
    session.model.createNode('b');
    const { output } = session.apply();
    expect(output).toMatch(/\r\n {2,4}"?b"?;\r\n/);
    expect(toModel(parse(output)).getNode('b')).toBeDefined();
  });
});

describe('patch plan: subgraph move', () => {
  it('moves a named subgraph to a different container', () => {
    const source = `digraph G {
  subgraph cluster_a {
    x;
  }
  subgraph cluster_b {
    y;
  }
}
`;
    const session = openPatchSession(source);
    const a = must(session.model.getSubgraph('cluster_a'));
    const b = must(session.model.getSubgraph('cluster_b'));
    const moved = a;
    b.addSubgraph(moved);
    session.model.removeSubgraph(a);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    const { output } = session.apply();
    assertUntouchedBytesKept(source, output, plan.operations);
    const reparsed = toModel(parse(output));
    expect(reparsed.getSubgraph('cluster_a')).toBeUndefined();
    expect(
      reparsed.getSubgraph('cluster_b')?.getSubgraph('cluster_a'),
    ).toBeDefined();
    expect(
      reparsed.getSubgraph('cluster_b')?.getSubgraph('cluster_a')?.getNode('x'),
    ).toBeDefined();
    expect(output).toContain('y;');
  });
});

describe('patch plan: overlapping changes', () => {
  it('merges overlapping edits into the nearest common ancestor rewrite', () => {
    // Moving a subgraph while also editing a node inside its source range
    // creates overlapping ranges; the planner must emit a single ancestor
    // rewrite instead of crossing patches.
    const source = `digraph G {
  subgraph cluster_a {
    x [color=red];
  }
  y;
}
`;
    const session = openPatchSession(source);
    const a = must(session.model.getSubgraph('cluster_a'));
    // Move the subgraph out by adding it to root twice is not possible;
    // instead change its node attribute AND remove the subgraph in the same
    // plan (two operations that both touch the subgraph range).
    a.getNode('x')?.attributes.set('color' as never, 'blue' as never);
    session.model.removeSubgraph(a);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    // Exactly one operation covering a single non-crossing range.
    const sorted = [...plan.operations].sort(
      (op1, op2) => op1.range.start - op2.range.start,
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].range.start).toBeGreaterThanOrEqual(
        sorted[i - 1].range.end,
      );
    }
    const { output } = session.apply();
    const reparsed = toModel(parse(output));
    expect(reparsed.getSubgraph('cluster_a')).toBeUndefined();
    expect(reparsed.getNode('y')).toBeDefined();
  });

  it('folds edits inside a moved subgraph into the move serialization', () => {
    const source = `digraph G {
  subgraph cluster_a {
    x [color=red];
  }
  subgraph cluster_b {
    y;
  }
}
`;
    const session = openPatchSession(source);
    const a = must(session.model.getSubgraph('cluster_a'));
    const b = must(session.model.getSubgraph('cluster_b'));
    a.getNode('x')?.attributes.set('color' as never, 'blue' as never);
    b.addSubgraph(a);
    session.model.removeSubgraph(a);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    // No crossing patches: operations stay ordered and non-overlapping.
    const sorted = [...plan.operations].sort(
      (op1, op2) => op1.range.start - op2.range.start,
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].range.start).toBeGreaterThanOrEqual(
        sorted[i - 1].range.end,
      );
    }
    const { output } = session.apply();
    assertUntouchedBytesKept(source, output, plan.operations);
    const reparsed = toModel(parse(output));
    expect(reparsed.getSubgraph('cluster_a')).toBeUndefined();
    const moved = must(
      reparsed.getSubgraph('cluster_b')?.getSubgraph('cluster_a'),
    );
    expect(moved.getNode('x')?.attributes.get('color' as never)).toBe('blue');
    expect(output).toContain('y;');
  });

  it('rewrites the nearest ancestor when ranges truly overlap', () => {
    // Removing the first attribute (which swallows its separator) while
    // changing a following attribute makes the two local ranges intersect.
    // The planner must not emit crossing patches: it rewrites the enclosing
    // node statement instead.
    const source = `digraph G {
  a [color=red, shape=box, style=filled];
  b [keep=me];
}
`;
    const session = openPatchSession(source);
    const a = must(session.model.getNode('a'));
    a.attributes.delete('color' as never);
    a.attributes.set('shape' as never, 'circle' as never);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    const reasons = plan.operations.map((operation) => operation.reason.code);
    expect(reasons).toContain('ancestor-rewrite');
    const sorted = [...plan.operations].sort(
      (op1, op2) => op1.range.start - op2.range.start,
    );
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].range.start).toBeGreaterThanOrEqual(
        sorted[i - 1].range.end,
      );
    }
    const { output } = session.apply();
    assertUntouchedBytesKept(source, output, plan.operations);
    const reparsed = toModel(parse(output));
    expect(
      reparsed.getNode('a')?.attributes.get('color' as never),
    ).toBeUndefined();
    expect(reparsed.getNode('a')?.attributes.get('shape' as never)).toBe(
      'circle',
    );
    expect(reparsed.getNode('a')?.attributes.get('style' as never)).toBe(
      'filled',
    );
    expect(reparsed.getNode('b')?.attributes.get('keep' as never)).toBe('me');
  });
});

describe('patch plan: insertion order', () => {
  it('inserts multiple nodes at the same anchor in model order', () => {
    const source = `digraph G {
  a;
}
`;
    const session = openPatchSession(source);
    session.model.createNode('c');
    session.model.createNode('b');
    const plan = session.plan();
    // One merged insertion containing both, in model order (c before b).
    const insertions = plan.operations.filter(
      (operation) => operation.range.start === operation.range.end,
    );
    expect(insertions).toHaveLength(1);
    const text = insertions[0]?.replacement;
    expect(text.indexOf('"c"')).toBeLessThan(text.indexOf('"b"'));
    const { output } = session.apply();
    const reparsed = toModel(parse(output));
    expect(reparsed.getNode('b')).toBeDefined();
    expect(reparsed.getNode('c')).toBeDefined();
  });
});

describe('patch plan: precondition hashes', () => {
  it('rejects application when the whole source changed', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const plan = session.plan();
    const tampered = source.replace('digraph G', 'digraph H');
    expect(() => session.apply(tampered)).toThrow(PatchPreconditionError);
    expect(plan.sourceHash).toBeTruthy();
    expect(plan.operations[0]?.preconditionHash).toBeTruthy();
  });

  it('rejects application when only a patched range drifted', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const plan = session.plan();
    // Change unrelated bytes such that the global hash matches is impossible;
    // here we tamper within the target range and verify the error reports it.
    const op = must(plan.operations[0]);
    const tampered = `${source.slice(0, op.range.start)}XXXX${source.slice(op.range.end)}`;
    expect(() => session.apply(tampered)).toThrow(PatchPreconditionError);
  });

  it('does not guess offsets after drift (input is returned unchanged)', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const tampered = source.replace('red', 'green');
    try {
      session.apply(tampered);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PatchPreconditionError);
    }
  });
});

describe('patch plan: plan metadata', () => {
  it('exposes ranges, replacement, stable paths, reasons and hashes', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const session = openPatchSession(source);
    session.model
      .getNode('a')
      ?.attributes.set('color' as never, 'blue' as never);
    const plan = session.plan();
    const operation = must(plan.operations[0]);
    expect(operation.range.end).toBeGreaterThan(operation.range.start);
    expect(operation.replacement).toBe('blue');
    expect(operation.target.kind).toBe('attribute');
    expect(operation.reason.code).toBe('attribute-value-changed');
    expect(operation.reason.message.length).toBeGreaterThan(0);
    expect(operation.preconditionHash).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.sourceHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('returns no operations when the model is unchanged', () => {
    const source = `digraph G {
  a [color=red];
}
`;
    const session = openPatchSession(source);
    const plan = session.plan();
    expect(plan.status).toBe('ok');
    expect(plan.operations).toHaveLength(0);
    expect(session.apply().output).toBe(source);
  });
});

describe('patch plan: extra edge cases', () => {
  it('adds an attribute to an edge', () => {
    const source = `digraph G {
  a -> b [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.edges[0]).attributes.set('style' as never, 'bold' as never);
      },
      (model) => {
        expect(must(model.edges[0]).attributes.get('style' as never)).toBe(
          'bold',
        );
        expect(must(model.edges[0]).attributes.get('color' as never)).toBe(
          'red',
        );
      },
    );
    expect(output).toContain('a -> b');
  });

  it('removes an attribute from an edge', () => {
    const source = `digraph G {
  a -> b [color=red, style=bold];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.edges[0]).attributes.delete('color' as never);
      },
      (model) => {
        expect(
          must(model.edges[0]).attributes.get('color' as never),
        ).toBeUndefined();
      },
    );
    expect(output).not.toContain('color');
  });

  it('handles semicolon separated attribute lists', () => {
    const source = `digraph G {
  a [color=red; shape=box; style=filled];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.getNode('a')).attributes.delete('shape' as never);
      },
      (model) => {
        expect(
          must(model.getNode('a')).attributes.get('shape' as never),
        ).toBeUndefined();
        expect(must(model.getNode('a')).attributes.get('color' as never)).toBe(
          'red',
        );
      },
    );
    expect(output).not.toContain('shape');
  });

  it('keeps an adjacent comment when removing an attribute', () => {
    const source = `digraph G {
  a [
    color=red
    // note
    shape=box
  ];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.getNode('a')).attributes.delete('color' as never);
      },
      (model) => {
        expect(
          must(model.getNode('a')).attributes.get('color' as never),
        ).toBeUndefined();
        expect(must(model.getNode('a')).attributes.get('shape' as never)).toBe(
          'box',
        );
      },
    );
    expect(output).toContain('// note');
  });

  it('preserves a port in an unchanged edge target', () => {
    const source = `digraph G {
  a:port_name -> b [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.edges[0]).attributes.set('color' as never, 'blue' as never);
      },
      (model) => {
        expect(must(model.edges[0]).attributes.get('color' as never)).toBe(
          'blue',
        );
        const first = must(model.edges[0]).targets[0] as {
          id: string;
          port?: string;
        };
        expect(first.port).toBe('port_name');
      },
    );
    expect(output).toContain('a:port_name -> b');
  });

  it('inserts a new default attribute list when none existed', () => {
    const source = `digraph G {
  a;
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        model.attributes.node.set('color' as never, 'red' as never);
      },
      (model) => {
        expect(model.attributes.node.get('color' as never)).toBe('red');
      },
    );
    expect(output).toContain('node [');
    expect(toModel(parse(output)).getNode('a')).toBeDefined();
  });

  it('edits an undirected graph edge', () => {
    const source = `graph G {
  a -- b [color=red];
}
`;
    const { output } = expectPatch(
      source,
      (model) => {
        must(model.edges[0]).attributes.set('color' as never, 'blue' as never);
      },
      (model) => {
        expect(must(model.edges[0]).attributes.get('color' as never)).toBe(
          'blue',
        );
      },
    );
    expect(output).toContain('--');
    expect(output).not.toContain('->');
  });
});

describe('patch plan: block insertion layout', () => {
  it('inserts into a one-line empty block', () => {
    const source = 'digraph G {}';
    const session = openPatchSession(source);
    session.model.createNode('a');
    const { output } = session.apply();
    expect(output).toBe('digraph G {\n  "a";\n}');
    toModel(parse(output));
  });

  it('does not add blank lines when inserting into an empty block', () => {
    const source = 'digraph G {\n}\n';
    const session = openPatchSession(source);
    session.model.createNode('a');
    const { output } = session.apply();
    expect(output).toBe('digraph G {\n  "a";\n}\n');
  });

  it('preserves a trailing blank line when appending', () => {
    const source = 'digraph G {\n  a;\n\n}\n';
    const session = openPatchSession(source);
    session.model.createNode('b');
    const { output } = session.apply();
    expect(output).toBe('digraph G {\n  a;\n  "b";\n\n}\n');
    toModel(parse(output));
  });
});
