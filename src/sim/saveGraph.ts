// A web of live objects written out as plain JSON, and built again from it.
//
// The simulation's state is objects pointing at one another: vehicles, the autopilots flying
// them (each holding the simulation, its vehicle, a tower's arms), sets of things already done,
// maps by vehicle id. JSON alone loses most of that: a Map or a Set comes back as {}, a class
// instance as a bare object without its methods, Infinity and NaN as null, and two fields that
// pointed at one object come back as two copies. So every value JSON can't carry is written as a
// small tagged object ({ $: 'map', ... }) and read back as what it was:
//
//   numbers JSON can't write   NaN, Infinity, -Infinity, -0
//   undefined                  (kept: a field that was there and undefined is again)
//   Map, Set, typed arrays     entries in their order
//   class instances            by a name from the kit's list; built again on the class's prototype
//                              WITHOUT running its constructor (constructors plan burns, write to
//                              the log...), then given their fields back
//   shared objects             anything reached more than once is written once, with a number, and
//                              pointed at from everywhere else: it is one object again afterwards
//                              (loops included: an autopilot holds the simulation that holds it)
//   the root                   the object being saved itself (the simulation), wherever it's held
//   constants                  fixed objects that belong to the program, not the flight (the
//                              vehicle definitions): written as a name, read back as this
//                              program's own object, never copied
//   functions                  can't be written: only the few the kit names (the flight log),
//                              read back as the new owner's own
//
// Anything else (a class not on the list, a function nobody named) stops the save with an error
// saying where it is, rather than being quietly left out of a flight that then goes wrong hours
// after it's loaded.

/** What JSON carries as it is. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** What the reader and writer need to know about the program's own things. */
export interface GraphKit {
  /** The classes whose instances may be in the web, by the name they're written under. */
  classes: Record<string, { prototype: object }>;
  /** Fixed objects never written out, by name (see constantParts). */
  constants: Map<object, string>;
  /** The functions that may be held in a field, by name. */
  functions: Record<string, unknown>;
}

const TYPED = { Float64Array, Float32Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray };
type TypedArray = InstanceType<(typeof TYPED)[keyof typeof TYPED]>;

/** The key that marks a tagged object (no field of the state may be called this). */
const TAG = '$';

const isPlain = (x: object): boolean => {
  const p = Object.getPrototypeOf(x);
  return p === Object.prototype || p === null;
};

const typedKind = (x: object): keyof typeof TYPED | null => {
  for (const kind of Object.keys(TYPED) as (keyof typeof TYPED)[]) if (Object.getPrototypeOf(x) === TYPED[kind].prototype) return kind;
  return null;
};

/**
 * Every object and array inside these fixed objects, each under a name: its path from the one it
 * is part of ('ship', 'ship.engines.3', 'ship.engines.3.type'). The names are worked out the same
 * way when saving and when loading, so a name written by one finds the same part in the other.
 */
export function constantParts(roots: Record<string, object>): Map<object, string> {
  const out = new Map<object, string>();
  const walk = (x: unknown, name: string): void => {
    if (x === null || typeof x !== 'object' || out.has(x)) return;
    out.set(x, name);
    for (const key of Object.keys(x)) walk((x as Record<string, unknown>)[key], `${name}.${key}`);
  };
  for (const name of Object.keys(roots)) walk(roots[name], name);
  return out;
}

/**
 * Write the root's own fields (all but those in leaveOut) and everything they lead to. Returns a
 * plain object, safe through JSON.stringify and back.
 */
export function writeGraph(root: object, kit: GraphKit, leaveOut: readonly string[] = []): { [key: string]: Json } {
  const className = new Map<object, string>();
  for (const name of Object.keys(kit.classes)) className.set(kit.classes[name].prototype, name);
  const functionName = new Map<unknown, string>();
  for (const name of Object.keys(kit.functions)) functionName.set(kit.functions[name], name);
  const rootKeys = Object.keys(root).filter((k) => !leaveOut.includes(k));
  const field = (x: object, key: string): unknown => (x as Record<string, unknown>)[key];
  /** Where the writer is, for error messages. */
  const path: string[] = [];
  const fail = (why: string): never => {
    throw new Error(`Can't save the flight: ${why} at ${path.join('.') || 'the root'}`);
  };

  // First pass: how many times each object is reached (more than once: it's shared).
  const reached = new Map<object, number>();
  const count = (x: unknown): void => {
    if (x === null || typeof x !== 'object' || x === root || kit.constants.has(x)) return;
    const n = reached.get(x) ?? 0;
    reached.set(x, n + 1);
    if (n > 0) return;
    if (Array.isArray(x)) x.forEach(count);
    else if (x instanceof Map) {
      for (const [k, v] of x) {
        count(k);
        count(v);
      }
    } else if (x instanceof Set) x.forEach(count);
    else if (!ArrayBuffer.isView(x)) for (const key of Object.keys(x)) count(field(x, key));
  };
  for (const key of rootKeys) count(field(root, key));

  // Second pass: write.
  const ids = new Map<object, number>();
  const write = (x: unknown): Json => {
    switch (typeof x) {
      case 'number':
        return Number.isFinite(x) && !Object.is(x, -0) ? x : { [TAG]: 'number', value: Object.is(x, -0) ? '-0' : String(x) };
      case 'string':
      case 'boolean':
        return x;
      case 'undefined':
        return { [TAG]: 'undefined' };
      case 'function': {
        const name = functionName.get(x);
        return name !== undefined ? { [TAG]: 'function', name } : fail('a function this save has no name for');
      }
      case 'object':
        break;
      default:
        return fail(`a ${typeof x}`);
    }
    if (x === null) return null;
    if (x === root) return { [TAG]: 'root' };
    const constant = kit.constants.get(x);
    if (constant !== undefined) return { [TAG]: 'constant', name: constant };
    const known = ids.get(x);
    if (known !== undefined) return { [TAG]: 'ref', id: known };
    // (Numbered before its contents are written: something inside may point back at it.)
    const id = (reached.get(x) ?? 0) > 1 ? ids.size : null;
    if (id !== null) ids.set(x, id);
    const body = contents(x);
    return id === null ? body : { [TAG]: 'shared', id, value: body };
  };
  const each = (items: Iterable<unknown>): Json[] => {
    const out: Json[] = [];
    for (const item of items) {
      path.push(String(out.length));
      out.push(write(item));
      path.pop();
    }
    return out;
  };
  const fields = (x: object, keys = Object.keys(x)): { [key: string]: Json } => {
    const out: { [key: string]: Json } = {};
    for (const key of keys) {
      if (key === TAG || key === '__proto__') fail(`a field called ${key}`);
      path.push(key);
      out[key] = write(field(x, key));
      path.pop();
    }
    return out;
  };
  const contents = (x: object): Json => {
    if (Array.isArray(x)) return each(x);
    if (x instanceof Map) return { [TAG]: 'map', entries: each([...x].flat()) };
    if (x instanceof Set) return { [TAG]: 'set', items: each(x) };
    if (ArrayBuffer.isView(x)) {
      const kind = typedKind(x);
      return kind ? { [TAG]: 'typed', kind, items: each(x as TypedArray) } : fail('a binary view this save can\'t write');
    }
    if (isPlain(x)) return fields(x);
    const name = className.get(Object.getPrototypeOf(x));
    return name !== undefined ? { [TAG]: 'class', name, fields: fields(x) } : fail(`a ${x.constructor?.name ?? 'class'} (a class this save has no name for)`);
  };
  return fields(root, rootKeys);
}

/**
 * Build again what writeGraph wrote. Returns the root's fields (not yet put on the root: the
 * caller does that once everything has read without an error); wherever the saved web pointed at
 * its root, the new one points at `root`.
 */
export function readGraph(data: Json, root: object, kit: GraphKit): Record<string, unknown> {
  const constants = new Map<string, object>();
  for (const [part, name] of kit.constants) constants.set(name, part);
  const shared = new Map<number, object>();
  const fail = (why: string): never => {
    throw new Error(`Can't load the flight: ${why}`);
  };
  const own = (table: object, name: string): boolean => Object.prototype.hasOwnProperty.call(table, name);
  const list = (x: Json | undefined): Json[] => (Array.isArray(x) ? x : fail('the save is damaged (a list is missing)'));
  const record = (x: Json | undefined): { [key: string]: Json } =>
    x !== null && typeof x === 'object' && !Array.isArray(x) ? x : fail('the save is damaged (an object is missing)');

  /** id: the number it was shared under, if it was (it's noted before its contents are read). */
  const read = (x: Json, id?: number): unknown => {
    if (x === null || typeof x !== 'object') return x;
    const made = <T extends object>(out: T): T => {
      if (id !== undefined) shared.set(id, out);
      return out;
    };
    const fill = (out: object, from: { [key: string]: Json }): object => {
      for (const key of Object.keys(from)) {
        if (key === '__proto__') fail('the save is damaged (a field called __proto__)');
        (out as Record<string, unknown>)[key] = read(from[key]);
      }
      return out;
    };
    if (Array.isArray(x)) {
      const out = made<unknown[]>([]);
      for (const item of x) out.push(read(item));
      return out;
    }
    if (!own(x, TAG)) return fill(made({}), x);
    switch (x[TAG]) {
      case 'number':
        return Number(x.value);
      case 'undefined':
        return undefined;
      case 'function': {
        const name = String(x.name);
        return own(kit.functions, name) ? kit.functions[name] : fail(`it holds a function (${name}) this version doesn't have`);
      }
      case 'root':
        return root;
      case 'constant':
        return constants.get(String(x.name)) ?? fail(`it points at a part of the vehicles (${String(x.name)}) this version doesn't have`);
      case 'ref':
        return shared.get(Number(x.id)) ?? fail('the save is damaged (it points at something it never wrote)');
      case 'shared':
        return read(x.value ?? null, Number(x.id));
      case 'class': {
        const name = String(x.name);
        if (!own(kit.classes, name)) fail(`it holds a ${name}, which this version doesn't have`);
        return fill(made(Object.create(kit.classes[name].prototype) as object), record(x.fields));
      }
      case 'map': {
        const out = made(new Map<unknown, unknown>());
        const entries = list(x.entries);
        for (let i = 0; i + 1 < entries.length; i += 2) out.set(read(entries[i]), read(entries[i + 1]));
        return out;
      }
      case 'set': {
        const out = made(new Set<unknown>());
        for (const item of list(x.items)) out.add(read(item));
        return out;
      }
      case 'typed': {
        const kind = String(x.kind);
        if (!own(TYPED, kind)) fail(`the save is damaged (a ${kind})`);
        return made(TYPED[kind as keyof typeof TYPED].from(list(x.items).map((item) => read(item) as number)));
      }
      default:
        return fail(`the save is damaged (an unknown tag, ${String(x[TAG])})`);
    }
  };
  const out: Record<string, unknown> = {};
  const from = record(data);
  for (const key of Object.keys(from)) {
    if (key === '__proto__') fail('the save is damaged (a field called __proto__)');
    out[key] = read(from[key]);
  }
  return out;
}
