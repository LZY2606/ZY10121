import { registerDefault } from '@ts-graphviz/core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  openPatchSession,
  type PatchPlan,
  PatchPreconditionError,
} from '../ast.js';

beforeAll(() => registerDefault());

describe('public exports', () => {
  it('exposes the patch API from the ast entrypoint', () => {
    const session = openPatchSession('digraph G { a [color=red]; }');
    expect(typeof session.plan).toBe('function');
    expect(typeof session.apply).toBe('function');
    const node = session.model.getNode('a');
    expect(node).toBeDefined();
    node?.attributes.set('color' as never, 'blue' as never);
    const plan: PatchPlan = session.plan();
    expect(plan.status).toBe('ok');
    expect(plan.operations[0]?.replacement).toBe('blue');
    expect(PatchPreconditionError.name).toBe('PatchPreconditionError');
  });

  it('is also reachable via the ts-graphviz/ast entrypoint', async () => {
    const mod = await import('ts-graphviz/ast');
    expect(typeof mod.openPatchSession).toBe('function');
  });
});
