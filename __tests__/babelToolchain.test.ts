// PR #470 review (Senti, P1): Dependabot bumped `@babel/core` 7.29.7 -> 8.0.1 and left
// `@babel/preset-env` on 7.29.7, whose peer range is `@babel/core@^7.0.0-0`. `npm ci` then died
// with ERESOLVE — before either required suite could run, so BOTH CI jobs failed at install with
// nothing to say about the code.
//
// The failure was invisible from inside the repo. Nothing here reads `@babel/core`'s version:
// `babel.config.js` and `jest.logic.config.js` both go through `module:@react-native/babel-preset`,
// and React Native 0.86 ships that preset with its own `@babel/core@^7.25.2` dependency. The root
// devDep exists only to satisfy the preset's `peer @babel/core: *` — a range that accepts 8.0.1
// happily while every plugin under the preset peers on `^7`. So the lockfile is the only place the
// break is written down, and nothing was reading it.
//
// Two checks, in the order the bug happened:
//
//   1. A general peer-integrity walk of package-lock.json. On main this is clean (0 violations);
//      on the #470 lockfile it reports 108. This is the check that would have caught the review's
//      finding without a network install.
//
//   2. A named pin on the Babel major line, because (1) alone accepts the tempting "fix": bumping
//      preset-env to ^8 as well. That resolves, but leaves 15 peers npm silently *overrides*
//      (jest's Babel-7 syntax plugins against a Babel-8 core) and grows the install from 911 to
//      1274 packages / 1 to 16 copies of `@babel/core`. Unused devDep, tripled supply-chain
//      surface. `.github/dependabot.yml` refuses the bump upstream; this refuses it downstream.
//
// NOTE on (1): it is deliberately STRICTER than `npm ci`. npm downgrades some conflicts to
// "npm warn ERESOLVE overriding peer dependency" and installs anyway; those warnings scroll past
// and a broken resolution ships. Here they are failures. If this test fires on an otherwise
// reasonable dependency PR, that is the intended conversation, not a false alarm.
import * as fs from 'fs';
import * as path from 'path';

// Hoisted transitive of the very Babel 7 toolchain this file pins, so it is present exactly when
// the assertions below are meaningful. Typed inline rather than pulling in @types/semver.
const semver = require('semver') as {
  satisfies(version: string, range: string): boolean;
  major(version: string): number;
};

const ROOT = path.join(__dirname, '..');

type LockEntry = {
  version?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, {optional?: boolean}>;
};

function readJson<T>(rel: string): T {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as T;
}

const lock = readJson<{packages: Record<string, LockEntry>}>('package-lock.json');
const pkg = readJson<{devDependencies: Record<string, string>}>('package.json');

/**
 * npm's resolution rule: from a package's install location, look in its own `node_modules`, then
 * walk up one `node_modules/<pkg>` segment at a time to the root. Returns the entry that would
 * actually satisfy `dep` at runtime, or undefined if nothing does.
 */
function resolveFrom(
  location: string,
  dep: string,
  packages: Record<string, LockEntry>,
): LockEntry | undefined {
  let current = location;
  for (;;) {
    const candidate =
      current === ''
        ? `node_modules/${dep}`
        : `${current}/node_modules/${dep}`;
    if (packages[candidate]) {
      return packages[candidate];
    }
    if (current === '') {
      return undefined;
    }
    const cut = current.lastIndexOf('/node_modules/');
    current = cut === -1 ? '' : current.slice(0, cut);
  }
}

/** Every non-optional peer dependency the lockfile cannot honour, as readable lines. */
function peerViolations(packages: Record<string, LockEntry>): string[] {
  const violations: string[] = [];
  for (const [location, entry] of Object.entries(packages)) {
    const peers = entry.peerDependencies ?? {};
    const meta = entry.peerDependenciesMeta ?? {};
    for (const [dep, range] of Object.entries(peers)) {
      if (meta[dep]?.optional) {
        continue;
      }
      const provider = resolveFrom(location, dep, packages);
      if (!provider) {
        violations.push(`${location || '<root>'}: peer ${dep}@${range} is not installed at all`);
        continue;
      }
      // Link/workspace entries carry no version; there is nothing to compare.
      if (!provider.version) {
        continue;
      }
      if (!semver.satisfies(provider.version, range)) {
        violations.push(
          `${location || '<root>'}: peer ${dep}@${range} resolves to ${provider.version}`,
        );
      }
    }
  }
  return violations;
}

describe('npm lockfile peer integrity (#470)', () => {
  it('honours every non-optional peer dependency, so npm ci can reach the tests', () => {
    const violations = peerViolations(lock.packages);
    expect(violations.join('\n')).toBe('');
  });

  it("detects the #470 shape — a root package promoted past its dependants' peer range", () => {
    // Guards the walk itself: a check that cannot fail is not a check. This is #470 in miniature —
    // preset-env pinned to a 7 peer while the root core moved to 8.
    const broken: Record<string, LockEntry> = {
      '': {},
      'node_modules/@babel/core': {version: '8.0.1'},
      'node_modules/@babel/preset-env': {
        version: '7.29.7',
        peerDependencies: {'@babel/core': '^7.0.0-0'},
      },
    };
    expect(peerViolations(broken)).toEqual([
      'node_modules/@babel/preset-env: peer @babel/core@^7.0.0-0 resolves to 8.0.1',
    ]);
  });

  it('resolves a peer from a nested copy in preference to the root one', () => {
    // The same walk must NOT report the arrangement React Native 0.86 actually ships, where the
    // preset carries its own core. Otherwise check (1) is unusable noise.
    const nested: Record<string, LockEntry> = {
      '': {},
      'node_modules/@babel/core': {version: '8.0.1'},
      'node_modules/@react-native/babel-preset': {version: '0.86.0'},
      'node_modules/@react-native/babel-preset/node_modules/@babel/core': {version: '7.29.7'},
      'node_modules/@react-native/babel-preset/node_modules/@babel/plugin-transform-classes': {
        version: '7.29.7',
        peerDependencies: {'@babel/core': '^7.0.0-0'},
      },
    };
    expect(peerViolations(nested)).toEqual([]);
  });
});

describe('Babel major line is pinned to what React Native 0.86 ships (#470)', () => {
  const BABEL_7 = 7;

  it('keeps the root @babel/core devDep on the Babel 7 line', () => {
    const declared = pkg.devDependencies['@babel/core'];
    expect(declared).toMatch(/^\^7\./);

    const installed = lock.packages['node_modules/@babel/core']?.version;
    expect(installed).toBeDefined();
    expect(semver.major(installed as string)).toBe(BABEL_7);
  });

  it('keeps every installed copy of @babel/core on the Babel 7 line, not just the root one', () => {
    // The invariant that actually matters: a Babel 8 anywhere in the tree means some Babel 7
    // plugin is being handed a core it was not written against.
    const copies = Object.keys(lock.packages).filter(p => p.endsWith('/@babel/core'));
    expect(copies.length).toBeGreaterThan(0);
    const offLine = copies.filter(
      p => semver.major(lock.packages[p].version as string) !== BABEL_7,
    );
    expect(offLine).toEqual([]);
  });

  it('still dedupes to a single copy — a second one is supply-chain surface worth noticing', () => {
    // Deliberately a tripwire, not a law. #470 went from 1 copy to 16; the point is that the
    // number moving at all should be read, not scrolled past. If a future bump legitimately
    // needs a nested copy, update this with the reason.
    const copies = Object.keys(lock.packages).filter(p => p.endsWith('/@babel/core'));
    expect(copies).toEqual(['node_modules/@babel/core']);
  });

  it('has Dependabot refuse the major bump upstream, so this stops recurring weekly', () => {
    const config = fs.readFileSync(path.join(ROOT, '.github/dependabot.yml'), 'utf8');
    expect(config).toMatch(
      /dependency-name:\s*"@babel\/core"\s*\n\s*update-types:\s*\["version-update:semver-major"\]/,
    );
  });
});
