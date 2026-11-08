/**
 * Reads the keys of a TypeScript interface and of a zod object, so a parity test can hold types
 * declared in different packages (the domain, the OpenAPI schemas, the SDKs) to the same shape.
 * A light parser, not a compiler: it reads `export interface Name { … }` members, their
 * optionality, and the keys of inline object types, and follows a member whose type is another
 * interface in the same source (`file: AssetFile`) when asked to.
 */
import type { z } from 'zod';

export interface Key {
  readonly optional: boolean;
  /** An object's own keys (inline, or a followed interface); absent for anything else. */
  readonly children?: Shape;
}
export type Shape = Record<string, Key>;

/** The body of `export interface <name> { … }` (or `… extends X {`) in a TypeScript source. */
export function interfaceBody(source: string, name: string): string {
  const start = new RegExp(`export interface ${name}\\b[^{]*\\{`).exec(source);
  if (!start) {
    throw new Error(
      `no \`export interface ${name} {\` found: if it became a type alias, update this test to read the new shape`,
    );
  }
  const open = start.index + start[0].length - 1;
  return source.slice(open, matchingBrace(source, open) + 1);
}

export function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}

/**
 * The top-level members of an object type literal, `{ … }`, comments ignored. With `source`, a
 * member typed as a bare interface name declared there is read as that interface's shape.
 */
export function parseShape(literal: string, source?: string): Shape {
  const body = literal
    .slice(1, -1)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const shape: Shape = {};
  let i = 0;
  while (i < body.length) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:\s*/.exec(body.slice(i));
    if (!m) break;
    i += m[0].length;
    const typeStart = i;
    let depth = 0;
    for (; i < body.length; i++) {
      const c = body[i];
      if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
      else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
      else if (c === ';' && depth === 0) break;
    }
    const type = body.slice(typeStart, i).trim();
    i++;
    const inline = /^(?:Readonly<\s*)?(?:readonly\s+)?\{/.exec(type);
    const open = inline ? type.indexOf('{') : -1;
    const named = /^[A-Z][\w$]*$/.exec(type);
    const children =
      open >= 0
        ? parseShape(type.slice(open, matchingBrace(type, open) + 1), source)
        : named && source && new RegExp(`export interface ${type}\\b`).test(source)
          ? parseShape(interfaceBody(source, type), source)
          : undefined;
    shape[m[1] as string] = {
      optional: m[2] === '?',
      ...(children ? { children } : {}),
    };
  }
  return shape;
}

type Schema = z.ZodType & { def: { type: string; innerType?: Schema; element?: Schema } };

/** The zod object a field holds, through `.optional()`, `.nullable()` and arrays. */
function objectOf(schema: Schema): z.ZodObject | undefined {
  const def = schema.def;
  if (def.type === 'object') return schema as unknown as z.ZodObject;
  if ((def.type === 'optional' || def.type === 'nullable') && def.innerType) {
    return objectOf(def.innerType);
  }
  if (def.type === 'array' && def.element) return objectOf(def.element);
  return undefined;
}

export function zodShape(schema: z.ZodObject): Shape {
  const shape: Shape = {};
  for (const [name, field] of Object.entries(schema.shape)) {
    const inner = objectOf(field as Schema);
    shape[name] = {
      optional: (field as Schema).safeParse(undefined).success,
      // A record has no fixed keys to compare.
      ...(inner ? { children: zodShape(inner) } : {}),
    };
  }
  return shape;
}

/** `a`'s shape with children kept only where `b` also spells the object out. */
export function comparable(a: Shape, b: Shape): Shape {
  const out: Shape = {};
  for (const [name, key] of Object.entries(a)) {
    const other = b[name];
    out[name] = {
      optional: key.optional,
      ...(key.children && other?.children
        ? { children: comparable(key.children, other.children) }
        : {}),
    };
  }
  return out;
}

/** Every key path in `shape` (`file.video.status`), for a diff a reader can follow. */
export function keyPaths(shape: Shape, prefix = ''): string[] {
  return Object.entries(shape).flatMap(([name, key]) => [
    `${prefix}${name}${key.optional ? '?' : ''}`,
    ...(key.children ? keyPaths(key.children, `${prefix}${name}.`) : []),
  ]);
}
