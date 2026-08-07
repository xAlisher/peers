// PR #467 review (Senti, P2): a dependency bump silently disarmed `npm run lint`.
//
// Bumping the root `typescript` devDependency to 7.0.2 put it outside the peer range of the
// `@typescript-eslint` packages that `@react-native/eslint-config` depends on (they still cap
// at `<6.1.0`). npm resolved that conflict the only way it can — by de-hoisting the whole
// eslint-config subtree into `node_modules/@react-native/eslint-config/node_modules/`. Nothing
// errored at install time; `npm ci` reported success. But `eslint .` then aborted before
// linting a single file with `Environment key "jest/globals" is unknown`, because ESLint's
// eslintrc loader resolves plugins relative to the PROJECT ROOT, not relative to the shared
// config that declares them. A plugin that is only reachable from inside the shared config's
// own node_modules does not exist as far as ESLint is concerned.
//
// Two things made this invisible:
//   1. `lint` is not a CI job — js-logic and kotlin-unit both stayed green on the PR.
//   2. The failure is a config-load abort, not a lint error, so it produces no findings to
//      notice the absence of. The command just stops.
//
// So this test pins the lint toolchain itself rather than any lint result:
//   - every plugin/parser package the shared config names must resolve from the project root;
//   - ESLint must actually be able to build a config for a source file and for a test file.
//
// The second check is the one that matters most, and is deliberately end-to-end. On the #467
// tree, adding a top-level `eslint-plugin-jest` cleared the resolution error and the build
// STILL failed one layer down: hoisted `ts-api-utils` bound to the root typescript@7 and threw
// `Cannot read properties of undefined (reading 'Intrinsic')` while loading the TS parser. Only
// loading the config for real catches that class.
import * as path from 'path';

const ROOT = path.join(__dirname, '..');
const SHARED_CONFIG = '@react-native/eslint-config';

type EslintrcConfig = {
  plugins?: string[];
  parser?: string;
  overrides?: EslintrcConfig[];
};

/**
 * ESLint plugin shorthand -> npm package name, per the eslintrc naming rules:
 * `jest` -> `eslint-plugin-jest`, `@react-native` -> `@react-native/eslint-plugin`,
 * `@typescript-eslint/eslint-plugin` -> itself (already a full package name).
 */
function pluginPackage(name: string): string {
  if (!name.startsWith('@')) {
    return `eslint-plugin-${name}`;
  }
  return name.includes('/') ? name : `${name}/eslint-plugin`;
}

/** Every plugin/parser package `@react-native/eslint-config` names, at any override depth. */
function declaredPackages(config: EslintrcConfig): string[] {
  const found = new Set<string>();
  const walk = (node: EslintrcConfig) => {
    for (const plugin of node.plugins ?? []) {
      found.add(pluginPackage(plugin));
    }
    if (node.parser) {
      found.add(node.parser);
    }
    for (const override of node.overrides ?? []) {
      walk(override);
    }
  };
  walk(config);
  return [...found].sort();
}

describe('lint toolchain (#467)', () => {
  const sharedConfig: EslintrcConfig = require(require.resolve(SHARED_CONFIG, {
    paths: [ROOT],
  }));

  it('names at least the plugins the failure was about', () => {
    // Guards the guard: if an RN upgrade renames or drops these, the resolution test below
    // would quietly start asserting nothing.
    const packages = declaredPackages(sharedConfig);
    expect(packages).toEqual(
      expect.arrayContaining([
        'eslint-plugin-jest',
        '@typescript-eslint/eslint-plugin',
        '@typescript-eslint/parser',
      ]),
    );
  });

  it.each(declaredPackages(sharedConfig))(
    'resolves %s from the project root, not only from inside the shared config',
    pkg => {
      // `paths: [ROOT]` is the point of the test — it reproduces how ESLint looks plugins up.
      expect(() => require.resolve(pkg, {paths: [ROOT]})).not.toThrow();
    },
  );

  // The de-hoist above is downstream of one thing: the root `typescript` drifting outside the
  // peer range `@typescript-eslint` declares (`>=4.8.4 <6.1.0` as of 8.66.0). When that happens
  // npm installs a SECOND typescript inside the shared config's own node_modules, and the
  // toolchain silently splits in two — `tsc` on one copy, the ESLint parser on another. That
  // split is the actual defect, so assert it directly rather than only its symptoms: there must
  // be exactly one typescript, shared by the project root and by the TS parser.
  //
  // Comparing resolved paths (not versions) keeps this free of a semver dependency and states
  // the invariant that matters. On the #467 tree these differ:
  //   root   -> node_modules/typescript                                        (7.0.2)
  //   parser -> node_modules/@react-native/eslint-config/node_modules/typescript (6.0.3)
  it('resolves a single typescript, shared by the project root and the TS parser', () => {
    const fromRoot = require.resolve('typescript', {paths: [ROOT]});
    const parserDir = path.dirname(
      require.resolve('@typescript-eslint/parser/package.json', {paths: [ROOT]}),
    );
    const fromParser = require.resolve('typescript', {paths: [parserDir]});
    expect(fromParser).toBe(fromRoot);
  });

  // A source file exercises the `*.ts`/`*.tsx` override (TS parser + plugin); a test file
  // additionally exercises the jest override whose `jest/globals` env is what broke.
  it.each(['src/App.tsx', '__tests__/address.test.ts'])(
    'builds an ESLint config for %s without aborting',
    async file => {
      const {ESLint} = require(require.resolve('eslint', {paths: [ROOT]}));
      const config = await new ESLint({cwd: ROOT}).calculateConfigForFile(file);
      expect(config.parser).toBeTruthy();
    },
    30_000,
  );
});
