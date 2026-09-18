import test from 'node:test';
import assert from 'node:assert/strict';
import { hasPersistableViewState, isViewEnabled, viewRegistry } from '../../src/host/views/registry.ts';

test('a parameterless native utility view does not create a tree row', () => {
  assert.equal(hasPersistableViewState({
    id: 'core.overview', label: 'Overview', provider: 'core', trusted: true,
  }), false);
});

test('a parameterless sandboxed plugin renderer creates a tree row', () => {
  assert.equal(hasPersistableViewState({
    id: 'org.example.renderer', label: 'Renderer', provider: 'org.example', trusted: false,
    entry: 'plugin.js',
  }), true);
});

test('a parameterised native view continues to create a tree row', () => {
  assert.equal(hasPersistableViewState({
    id: 'core.dfg', label: 'DFG', provider: 'core', trusted: true,
    params: { type: 'object', properties: { threshold: { type: 'integer' } } },
  }), true);
});

test('a temporarily disabled view is neither enabled nor persisted', () => {
  const view = {
    id: 'core.ocdfg', label: 'Object-centric DFG', provider: 'core', trusted: true,
    disabled: true,
    params: { type: 'object' as const, properties: { threshold: { type: 'integer' as const } } },
  };
  assert.equal(isViewEnabled(view), false);
  assert.equal(hasPersistableViewState(view), false);
});

test('a native-view alias inherits a disabled target', () => {
  const target = 'test.disabled-native-target';
  const alias = 'test.disabled-native-alias';
  viewRegistry.register({ id: target, label: 'Disabled target', provider: 'test', trusted: true, disabled: true, appliesTo: ['TestArtifact'] });
  viewRegistry.register({ id: alias, label: 'Alias', provider: 'test-plugin', trusted: false, nativeView: target, appliesTo: ['TestArtifact'] });
  try {
    assert.equal(viewRegistry.forType('TestArtifact').some((view) => view.id === alias), false);
  } finally {
    viewRegistry.unregister(alias);
    viewRegistry.unregister(target);
  }
});
