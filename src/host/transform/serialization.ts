import { OP_LABEL, newOp, type TransformOp, type TransformOpKind } from './types.ts';

/** A deliberately small, portable JSON envelope for saved transformation definitions. */
export const TRANSFORM_OPERATIONS_FORMAT = 'promenade.transform-operations/v1';

type OperationExport = {
  format: typeof TRANSFORM_OPERATIONS_FORMAT;
  scope: 'operation';
  op: TransformOp;
};

type PlanExport = {
  format: typeof TRANSFORM_OPERATIONS_FORMAT;
  scope: 'plan';
  ops: TransformOp[];
};

export function exportOperation(op: TransformOp): OperationExport {
  return { format: TRANSFORM_OPERATIONS_FORMAT, scope: 'operation', op };
}

export function exportPlan(ops: TransformOp[]): PlanExport {
  return { format: TRANSFORM_OPERATIONS_FORMAT, scope: 'plan', ops };
}

/** Reads either Promenade's envelope or the convenient raw object/array forms. */
export function importOperations(text: string): TransformOp[] {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('The selected file is not valid JSON.'); }

  const candidate = Array.isArray(value)
    ? value
    : isRecord(value) && value.format === TRANSFORM_OPERATIONS_FORMAT && value.scope === 'plan'
      ? value.ops
      : isRecord(value) && value.format === TRANSFORM_OPERATIONS_FORMAT && value.scope === 'operation'
        ? [value.op]
        : isRecord(value) && 'kind' in value ? [value] : null;

  if (!Array.isArray(candidate)) {
    throw new Error('Expected one operation or a plan exported by Promenade.');
  }
  const ops = candidate.map(parseOperation);
  const flattenAt = ops.findIndex((op) => op.kind === 'flattenByObjectType');
  if (flattenAt > 0 || ops.filter((op) => op.kind === 'flattenByObjectType').length > 1) {
    throw new Error('Flatten by object type must be the first and only flatten operation.');
  }
  return ops;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function optionalNumber(value: unknown): boolean {
  return value == null || typeof value === 'number';
}

function isValueScope(value: unknown): boolean {
  return ['eventAttribute', 'objectAttribute', 'caseAttribute', 'qualifier'].includes(String(value));
}

function optionalString(value: unknown): boolean {
  return value == null || typeof value === 'string';
}

function hasStrings(value: Record<string, unknown>, ...keys: string[]) {
  return keys.every((key) => typeof value[key] === 'string');
}

function parseOperation(value: unknown): TransformOp {
  if (!isRecord(value) || typeof value.kind !== 'string' || !(value.kind in OP_LABEL)) {
    throw new Error('An operation has an unknown kind.');
  }
  if (value.disabled != null && typeof value.disabled !== 'boolean') {
    throw new Error(`“${value.kind}” has an invalid disabled flag.`);
  }
  const kind = value.kind as TransformOpKind;
  let valid = false;
  switch (kind) {
    case 'renameActivity':
    case 'renameObjectType':
      valid = hasStrings(value, 'from', 'to') && (value.allowMerge == null || typeof value.allowMerge === 'boolean'); break;
    case 'mergeActivities':
    case 'mergeObjectTypes':
      valid = stringArray(value.sources) && typeof value.target === 'string'; break;
    case 'splitObjectType':
      valid = hasStrings(value, 'source', 'field') && Array.isArray(value.rules)
        && value.rules.every((rule) => isRecord(rule) && hasStrings(rule, 'value', 'target')
          && ['contains', 'equals', 'regex'].includes(String(rule.mode))); break;
    case 'filterEvents':
      valid = typeof value.value === 'string' && ['activity', 'lifecycle', 'resource'].includes(String(value.column))
        && ['is', 'isNot', 'contains'].includes(String(value.op)); break;
    case 'filterActivities':
    case 'filterObjectTypes':
      valid = stringArray(value.values) && ['include', 'exclude'].includes(String(value.mode))
        && typeof value.minFrequency === 'number' && typeof value.maxFrequency === 'number'; break;
    case 'filterEventAttribute':
    case 'filterObjectAttribute':
      valid = hasStrings(value, 'key', 'value') && ['has', 'equals', 'contains', 'numberRange'].includes(String(value.mode))
        && optionalNumber(value.min) && optionalNumber(value.max); break;
    case 'filterE2oCount':
    case 'filterO2oCount':
      valid = optionalNumber(value.min) && optionalNumber(value.max) && (value.conditions == null
        || Array.isArray(value.conditions) && value.conditions.every((condition) => isRecord(condition)
          && hasStrings(condition, 'sourceType', 'targetType', 'qualifier')
          && optionalNumber(condition.min) && optionalNumber(condition.max))); break;
    case 'timeRange': valid = optionalString(value.from) && optionalString(value.to); break;
    case 'filterCases': valid = typeof value.activity === 'string' && ['contains', 'notContains'].includes(String(value.mode)); break;
    case 'variantMinCases': valid = typeof value.minCases === 'number'; break;
    case 'removeAttribute': valid = typeof value.key === 'string' && ['event', 'trace'].includes(String(value.scope)); break;
    case 'removeEventAttributes': valid = typeof value.activity === 'string' && stringArray(value.keys); break;
    case 'removeObjectAttributes': valid = typeof value.objectType === 'string' && stringArray(value.keys); break;
    case 'removeCaseAttributes': valid = stringArray(value.keys); break;
    case 'flattenByObjectType': valid = typeof value.objectType === 'string'; break;
    case 'disambiguateEventOrder':
      valid = ['identifier', 'lifecycle', 'attribute'].includes(String(value.tieBreak))
        && typeof value.stepMicroseconds === 'number' && value.stepMicroseconds > 0
        && optionalString(value.attribute); break;
    case 'dropImplausibleTimestamps':
      valid = ['drop', 'clear'].includes(String(value.mode))
        && typeof value.minYear === 'number' && typeof value.maxYear === 'number'; break;
    case 'deduplicateRelations':
      valid = ['e2o', 'o2o', 'both'].includes(String(value.scope)); break;
    // Parameterless repairs: the kind is the whole definition.
    case 'dropSelfRelations':
    case 'dropDanglingRelations':
    case 'dropOrphanObjects':
    case 'dropEventsWithoutObjects':
    case 'dropEmptyCases':
      valid = true; break;
    case 'canonicaliseValues':
      valid = isValueScope(value.scope) && stringArray(value.names); break;
    case 'mapSentinelValues':
      valid = isValueScope(value.scope) && value.scope !== 'qualifier'
        && stringArray(value.names) && stringArray(value.values); break;
    case 'removeAttributes':
      valid = isValueScope(value.scope) && value.scope !== 'qualifier' && stringArray(value.names); break;
    case 'pseudonymiseAttributes':
      valid = isValueScope(value.scope) && value.scope !== 'qualifier'
        && stringArray(value.names) && ['hash', 'remove'].includes(String(value.mode))
        && typeof value.salt === 'string'; break;
  }
  if (!valid) throw new Error(`“${OP_LABEL[kind]}” has invalid fields.`);
  // Start with the current default so older exports remain forward-compatible
  // when a new optional property is added, then retain the valid definition.
  return { ...newOp(kind), ...value } as TransformOp;
}
