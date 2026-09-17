import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Catches the two import mistakes a bundler will not.
 *
 * esbuild happily builds a module that calls an undefined identifier, or that
 * imports a name its target no longer exports: both only fail when the code
 * actually runs, which for a lazily-loaded page can be a long time later.
 * Neither is hypothetical here; both have reached the repository.
 */

const SRC = path.resolve(__dirname);
const SKIP_DIRS = new Set(['node_modules']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.jsx?$/.test(entry.name) && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

/** Comments are prose: a hook named in one is not a call. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, (m) => ' '.repeat(m.length));
}

const FILES = walk(SRC).map((file) => ({
  file,
  rel: path.relative(SRC, file).split(path.sep).join('/'),
  source: stripComments(fs.readFileSync(file, 'utf8')),
}));

/** Named bindings a module brings in, plus what it declares itself. */
function bindings(source) {
  const names = new Set();
  for (const m of source.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]+['"]/g)) {
    const clause = m[1];
    for (const named of clause.matchAll(/\{([^}]*)\}/g)) {
      named[1].split(',').forEach((part) => {
        const name = part.split(/\sas\s/).pop().trim();
        if (name) names.add(name);
      });
    }
    const bare = clause.replace(/\{[^}]*\}/g, '').replace(/^\s*,|,\s*$/g, '').trim();
    if (bare && !bare.startsWith('*')) names.add(bare);
    const star = clause.match(/\*\s+as\s+(\w+)/);
    if (star) names.add(star[1]);
  }
  for (const m of source.matchAll(/\b(?:const|let|var|function|class)\s+(\w+)/g)) {
    names.add(m[1]);
  }
  return names;
}

describe('module wiring', () => {
  it('every hook a module calls is a name it can see', () => {
    const offenders = [];
    for (const { rel, source } of FILES) {
      const known = bindings(source);
      for (const m of source.matchAll(/(?<![\w.])(use[A-Z]\w*)\s*\(/g)) {
        const hook = m[1];
        if (!known.has(hook)) offenders.push(`${rel}: ${hook}`);
      }
    }
    expect(
      offenders,
      `hooks called without an import:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every named import exists in the module it comes from', () => {
    const exportsOf = new Map();
    for (const { file, source } of FILES) {
      const names = new Set();
      for (const m of source.matchAll(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+(\w+)/g)) {
        names.add(m[1]);
      }
      for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
        m[1].split(',').forEach((part) => {
          const name = part.split(/\sas\s/).pop().trim();
          if (name) names.add(name);
        });
      }
      if (/export\s+default/.test(source)) names.add('default');
      exportsOf.set(path.resolve(file), names);
    }

    const offenders = [];
    for (const { file, rel, source } of FILES) {
      for (const m of source.matchAll(/import\s+([^;]*?\{[^}]*\}[^;]*?)\s+from\s+['"](\.[^'"]+)['"]/g)) {
        const target = path.resolve(path.dirname(file), m[2]);
        const known = exportsOf.get(target);
        if (!known) continue;                  // not a module in this tree
        const named = m[1].match(/\{([^}]*)\}/);
        if (!named) continue;
        named[1].split(',').forEach((part) => {
          const name = part.split(/\sas\s/)[0].trim();
          if (name && !known.has(name)) offenders.push(`${rel}: ${name} from ${m[2]}`);
        });
      }
    }
    expect(
      offenders,
      `imported names their module does not export:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
