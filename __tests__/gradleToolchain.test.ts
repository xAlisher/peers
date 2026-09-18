// PR #464 review (Senti, P1): Dependabot's grouped Android bump raised the Gradle wrapper
// 9.3.1 -> 9.6.1 and the required `kotlin-unit` job died before a single test ran.
//
// THE REGRESSION THIS PINS. React Native ships its Gradle plugin as an *included build*
// (`node_modules/@react-native/gradle-plugin`), so `./gradlew` compiles RN's own Kotlin
// sources with the Kotlin version RN pins — 2.1.20 for RN 0.86 — against the Kotlin stdlib
// that the Gradle distribution embeds. Those two are independent, and a wrapper bump moves
// only the second one:
//
//     Gradle 9.3.1  ->  kotlin-stdlib 2.2.21  (metadata 2.2.0)  OK
//     Gradle 9.6.1  ->  kotlin-stdlib 2.3.21  (metadata 2.3.0)  breaks
//
// A Kotlin compiler reads metadata one minor ahead of itself and no further, so 2.1.20 tops
// out at 2.2.0. Under 9.6.1 `:gradle-plugin:settings-plugin:compileKotlin` fails with
// "Internal compiler error" and a wall of "compiled with an incompatible version of Kotlin",
// which names neither the wrapper nor Dependabot. Nothing in the repo connected the two, so
// the only signal was a red CI job with an opaque cause.
//
// The check is deliberately a *data* check, not a version-string check: bumping the wrapper is
// fine, and should stay fine — what is not fine is adopting a Gradle whose embedded Kotlin
// nobody measured. A new wrapper version therefore fails here with instructions rather than
// failing later inside the Kotlin compiler.
import * as fs from 'fs';
import * as path from 'path';

// Both hoisted transitives, present because the toolchains this file pins pull them in. Typed
// inline rather than adding @types packages for two call sites (same shape as babelToolchain).
const yaml = require('js-yaml') as {load(src: string): unknown};
const semver = require('semver') as {
  coerce(v: string): {version: string} | null;
  compare(a: string, b: string): number;
};

// Dependabot's Maven/Gradle `ignore.versions` uses MAVEN range syntax ([1.4,), (3.6.0,)), NOT npm
// comparators — https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference
// (Maven: use `[1.4,)`). npm `semver` cannot parse those, so validating the holds with
// `semver.validRange`/`satisfies` (PR #513's first cut) gave FALSE confidence: `>= 9.4` is valid
// npm-semver and passed, while Dependabot's Maven parser would never honour it. Senti P1 on #513.
// This evaluates the ranges the way Dependabot actually will — Maven bracket semantics.
const MAVEN_RANGE = /^([[(])\s*([^,)\]]*)\s*,\s*([^,)\]]*)\s*([)\]])$/;
function coerceVer(v: string): string {
  const c = semver.coerce(v);
  if (!c) throw new Error(`uncoercible version: ${v}`);
  return c.version;
}
/** A parseable Maven range (`[lo,hi]` with either bound optional) or a bare exact version. */
function validMavenVersionSpec(spec: string): boolean {
  if (MAVEN_RANGE.test(spec)) return true;
  // A bare exact-version pin: digits and dots only. Deliberately rejects npm comparators
  // (`>= 9.4`, `> 3.6.0`) — the whole point of Senti's #513 P1 — so a regression to npm syntax
  // fails HERE, not just in the behavioural assertions below.
  return /^\d+(\.\d+)*$/.test(spec) && semver.coerce(spec) != null;
}
/** Does `version` fall in Maven spec `spec` (`[9.4,)`, `(3.6.0,)`, or an exact version)? */
function mavenSatisfies(version: string, spec: string): boolean {
  const m = MAVEN_RANGE.exec(spec);
  if (!m) return coerceVer(version) === coerceVer(spec); // bare exact-version pin
  const [, lb, lo, hi, ub] = m;
  const v = coerceVer(version);
  if (lo !== '') {
    const c = semver.compare(v, coerceVer(lo)); // [ → v>=lo ; ( → v>lo
    if (lb === '[' ? c < 0 : c <= 0) return false;
  }
  if (hi !== '') {
    const c = semver.compare(v, coerceVer(hi)); // ] → v<=hi ; ) → v<hi
    if (ub === ']' ? c > 0 : c >= 0) return false;
  }
  return true;
}

const ROOT = path.join(__dirname, '..');
const WRAPPER_PROPS = path.join(
  ROOT,
  'android/gradle/wrapper/gradle-wrapper.properties',
);
const RN_PLUGIN_VERSIONS = path.join(
  ROOT,
  'node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml',
);
const RN_VERSIONS = path.join(
  ROOT,
  'node_modules/react-native/gradle/libs.versions.toml',
);
const APP_BUILD_GRADLE = path.join(ROOT, 'android/app/build.gradle');

/**
 * Kotlin stdlib embedded in each Gradle distribution we have actually looked inside.
 *
 * Measured, not inferred — Gradle publishes no machine-readable mapping, so each entry is a
 * `lib/kotlin-stdlib-*.jar` observed in the real distribution. Extend it the same way:
 *
 *   curl -sO https://services.gradle.org/distributions/gradle-<v>-bin.zip
 *   unzip -l gradle-<v>-bin.zip | grep kotlin-stdlib
 *
 * Versions absent from this map are treated as unverified and rejected below. That is the
 * intended behaviour: an unmeasured wrapper bump is exactly what broke #464.
 */
const GRADLE_EMBEDDED_KOTLIN: Record<string, string> = {
  // lib/kotlin-stdlib-2.2.21.jar
  '9.3.1': '2.2.21',
  // lib/kotlin-stdlib-2.3.21.jar — the #464 bump; kept so the rejection is proven, not assumed.
  '9.6.1': '2.3.21',
};

type Version = {major: number; minor: number};

function parseVersion(raw: string): Version {
  const m = /^(\d+)\.(\d+)/.exec(raw);
  if (!m) {
    throw new Error(`unparseable version: ${raw}`);
  }
  return {major: Number(m[1]), minor: Number(m[2])};
}

/** `2.3.21` -> `2.3.0`: the metadata stamp is the compiler's major.minor. */
function metadataVersion(kotlin: string): Version {
  return parseVersion(kotlin);
}

/**
 * Highest metadata a Kotlin compiler will load: its own minor, plus one.
 *
 * This is the rule the compiler states in the #464 error itself — "the compiler version 2.1.0
 * can read versions up to 2.2.0".
 */
function maxReadableMetadata(kotlin: string): Version {
  const v = parseVersion(kotlin);
  return {major: v.major, minor: v.minor + 1};
}

function lte(a: Version, b: Version): boolean {
  return a.major !== b.major ? a.major < b.major : a.minor <= b.minor;
}

function show(v: Version): string {
  return `${v.major}.${v.minor}.0`;
}

function gradleWrapperVersion(): string {
  const text = fs.readFileSync(WRAPPER_PROPS, 'utf8');
  const m = /distributionUrl=.*?gradle-([\d.]+)-(?:bin|all)\.zip/.exec(text);
  if (!m) {
    throw new Error(`no gradle version in distributionUrl of ${WRAPPER_PROPS}`);
  }
  return m[1];
}

/** The Fresco version React Native itself builds against (`[versions] fresco`). */
function reactNativeFresco(): string {
  const text = fs.readFileSync(RN_VERSIONS, 'utf8');
  const m = /^fresco\s*=\s*"([^"]+)"/m.exec(text);
  if (!m) {
    throw new Error(`no [versions] fresco entry in ${RN_VERSIONS}`);
  }
  return m[1];
}

/** The `com.facebook.fresco:animated-gif` version the app declares. */
function appAnimatedGif(): string {
  const text = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  const m = /com\.facebook\.fresco:animated-gif:([\d.]+)/.exec(text);
  if (!m) {
    throw new Error(`no animated-gif dependency in ${APP_BUILD_GRADLE}`);
  }
  return m[1];
}

function reactNativePluginKotlin(): string {
  const text = fs.readFileSync(RN_PLUGIN_VERSIONS, 'utf8');
  const m = /^kotlin\s*=\s*"([^"]+)"/m.exec(text);
  if (!m) {
    throw new Error(`no [versions] kotlin entry in ${RN_PLUGIN_VERSIONS}`);
  }
  return m[1];
}

describe('Android Gradle wrapper vs the React Native Kotlin toolchain (#464)', () => {
  it('reads the pinned wrapper version and RN plugin Kotlin version', () => {
    expect(fs.existsSync(WRAPPER_PROPS)).toBe(true);
    // Requires `npm ci`, which the js-logic job runs before the logic suite. Asserted rather
    // than skipped: silently passing on a missing input would defeat the whole check.
    expect(fs.existsSync(RN_PLUGIN_VERSIONS)).toBe(true);

    expect(gradleWrapperVersion()).toMatch(/^\d+\.\d+/);
    expect(reactNativePluginKotlin()).toMatch(/^\d+\.\d+/);
  });

  it('pins a Gradle whose embedded Kotlin has been measured', () => {
    const gradle = gradleWrapperVersion();
    const known = Object.keys(GRADLE_EMBEDDED_KOTLIN).sort().join(', ');
    expect(
      GRADLE_EMBEDDED_KOTLIN[gradle]
        ? `${gradle}: measured`
        : `Gradle ${gradle} has no measured embedded Kotlin version. Unzip the distribution, ` +
          `read lib/kotlin-stdlib-*.jar, and add it to GRADLE_EMBEDDED_KOTLIN before adopting ` +
          `the bump (measured so far: ${known}).`,
    ).toBe(`${gradle}: measured`);
  });

  it("embeds a Kotlin the RN gradle-plugin's compiler can actually read", () => {
    const gradle = gradleWrapperVersion();
    const embedded = GRADLE_EMBEDDED_KOTLIN[gradle];
    const compiler = reactNativePluginKotlin();

    const produced = metadataVersion(embedded);
    const ceiling = maxReadableMetadata(compiler);

    expect(
      lte(produced, ceiling)
        ? 'readable'
        : `Gradle ${gradle} embeds Kotlin ${embedded} (metadata ${show(produced)}), but React ` +
          `Native's gradle-plugin compiles with Kotlin ${compiler}, which reads metadata only ` +
          `up to ${show(ceiling)}. :gradle-plugin:settings-plugin:compileKotlin will fail. ` +
          `Keep the wrapper on a Gradle embedding Kotlin <= ${show(ceiling)} until RN raises its ` +
          `pinned Kotlin.`,
    ).toBe('readable');
  });

  it('rejects the exact Gradle 9.6.1 pairing that broke #464', () => {
    // Guards the guard: if the arithmetic above ever loosens, this fails.
    const produced = metadataVersion(GRADLE_EMBEDDED_KOTLIN['9.6.1']);
    const ceiling = maxReadableMetadata('2.1.20');
    expect(lte(produced, ceiling)).toBe(false);
  });

  it('accepts the Gradle 9.3.1 pairing that CI is green on', () => {
    const produced = metadataVersion(GRADLE_EMBEDDED_KOTLIN['9.3.1']);
    const ceiling = maxReadableMetadata('2.1.20');
    expect(lte(produced, ceiling)).toBe(true);
  });
});

// Second defect from the same PR #464 bump, and NOT caught by the review — found only by
// running the app. Dependabot raised `animated-gif` 3.6.0 -> 3.7.0 on its own.
//
// `animated-gif` is not a standalone library: it is one artifact of the Fresco set, and RN
// ships the rest (fresco, imagepipeline, imagepipeline-native, fbcore) transitively at the
// version RN builds against. Gradle resolves a conflicting graph to the HIGHEST version, so
// bumping this one artifact silently drags every Fresco module to 3.7.0 — RN's own image
// pipeline included, past what react-android was compiled against.
//
// The failure mode is why this needs a test: nothing errors. It compiles, links, installs,
// and renders the GIF's first frame. It just never animates again. Measured on a Redmi
// 2201117SY with a 16-frame looping GIF, 56 screen samples over 30s from a cold start:
//
//     animated-gif 3.6.0 -> 13 distinct frames (cycling)
//     animated-gif 3.7.0 ->  1 distinct frame  (frozen)
//
// That silently guts #300, the entire reason the artifact is declared. The comment above the
// dependency already stated the rule ("must match RN's pinned Fresco"); a comment cannot fail
// CI, so a Dependabot bump walked straight past it.
describe('Fresco animated-gif vs the version React Native pins (#464, #300)', () => {
  it('reads both versions', () => {
    expect(fs.existsSync(RN_VERSIONS)).toBe(true);
    expect(appAnimatedGif()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(reactNativeFresco()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('declares animated-gif at exactly RN\'s Fresco version', () => {
    const app = appAnimatedGif();
    const rn = reactNativeFresco();
    expect(
      app === rn
        ? 'matched'
        : `android/app/build.gradle declares com.facebook.fresco:animated-gif:${app}, but React ` +
          `Native pins Fresco ${rn}. Gradle resolves the Fresco graph to the highest version, so ` +
          `this drags RN's whole image pipeline to ${app}. Nothing fails to build — GIFs just ` +
          `stop animating (#300). Bump animated-gif only when RN bumps Fresco.`,
    ).toBe('matched');
  });
});

// PR #513 review (Senti, P1 x2): Dependabot proposed *the exact same two bumps again* — wrapper
// 9.3.1 -> 9.6.1 and animated-gif 3.6.0 -> 3.7.0, byte-for-byte the #464 change that had already
// been rejected once.
//
// THE GAP THIS PINS. The two `describe` blocks above did their job both times: they went red on
// #464 and red again on #513. But a guard that only fails downstream cannot stop the proposal —
// it just re-litigates it. Every week the cooldown elapses, Dependabot re-opens the same PR, and
// a human burns the same review deciding the same thing. #470 (Babel) and #507 (VisionCamera)
// both ended by writing the refusal into `.github/dependabot.yml`; the gradle ecosystem block had
// no `ignore:` list at all, which is why this one came back and Babel's did not.
//
// So this asserts the *upstream* half of that pair, and asserts it behaviourally: the ignore
// ranges are evaluated against the versions #464/#513 actually proposed, rather than matched as
// strings. A hold that is present but scoped wrong reads identical to a correct one under a regex.
describe('Dependabot refuses the bumps the guards above reject (#513)', () => {
  type Ignore = {'dependency-name'?: string; versions?: string[]};
  type Ecosystem = {
    'package-ecosystem'?: string;
    directory?: string;
    ignore?: Ignore[];
  };

  const config = yaml.load(
    fs.readFileSync(path.join(ROOT, '.github/dependabot.yml'), 'utf8'),
  ) as {updates?: Ecosystem[]};

  const gradle = (config.updates ?? []).find(
    u => u['package-ecosystem'] === 'gradle' && u.directory === '/android',
  );

  /** Would Dependabot suppress an update to `version` of `name`? */
  function ignored(name: string, version: string): boolean {
    return (gradle?.ignore ?? [])
      .filter(entry => entry['dependency-name'] === name)
      .some(entry =>
        (entry.versions ?? []).some(range => mavenSatisfies(version, range)),
      );
  }

  it('has an ignore list on the /android gradle ecosystem', () => {
    expect(gradle).toBeDefined();
    expect(Array.isArray(gradle?.ignore)).toBe(true);
    // Every range must parse, or `ignored()` below would throw rather than report.
    for (const entry of gradle?.ignore ?? []) {
      for (const range of entry.versions ?? []) {
        expect(`${range}: ${validMavenVersionSpec(range) ? 'valid' : 'unparseable'}`).toBe(
          `${range}: valid`,
        );
      }
    }
  });

  it('suppresses the Gradle wrapper bump that broke #464 and returned as #513', () => {
    expect(
      ignored('gradle-wrapper', '9.6.1')
        ? 'held'
        : 'Nothing in .github/dependabot.yml stops Dependabot re-proposing Gradle 9.6.1. It has ' +
          'already been opened twice (#464, #513) and rejected twice by the guards above. Add an ' +
          'ignore entry for gradle-wrapper covering >= 9.4.',
    ).toBe('held');
  });

  it('still lets a 9.3.x wrapper patch through', () => {
    // The hold is a compatibility ceiling, not a freeze: the axis that broke is the embedded
    // Kotlin *minor*, so a patch inside the line CI is green on must still reach us. (It will
    // still have to be measured into GRADLE_EMBEDDED_KOTLIN before it can be adopted.)
    expect(ignored('gradle-wrapper', '9.3.2')).toBe(false);
  });

  it("suppresses any animated-gif above React Native's pinned Fresco", () => {
    expect(
      ignored('com.facebook.fresco:animated-gif', '3.7.0')
        ? 'held'
        : 'Nothing in .github/dependabot.yml stops Dependabot re-proposing animated-gif 3.7.0, ' +
          'which drags RN\'s whole Fresco graph past what react-android was built against and ' +
          'silently stops GIFs animating (#300). Add an ignore entry for ' +
          'com.facebook.fresco:animated-gif covering > 3.6.0.',
    ).toBe('held');
  });

  it('suppresses even a single patch above the pin, which the guard above would also reject', () => {
    // 3.6.1 is the case a `>= 3.7.0` range would wave through while the "exactly RN's Fresco"
    // assertion above still failed it — upstream and downstream have to agree on the rule.
    expect(ignored('com.facebook.fresco:animated-gif', '3.6.1')).toBe(true);
  });

  it("does not hold animated-gif at or below RN's pin", () => {
    expect(ignored('com.facebook.fresco:animated-gif', reactNativeFresco())).toBe(
      false,
    );
  });
});

// PR #549 review (Senti, P1): Dependabot's grouped Android bump raised SQLCipher 4.17.0 -> 4.19.0
// and the required `kotlin-unit` job died in `:app:checkDebugAarMetadata`:
//
//     Dependency 'net.zetetic:sqlcipher-android:4.19.0' requires libraries and applications that
//     depend on it to compile against version 37 or later of the Android APIs.
//
// THE REGRESSION THIS PINS. An AAR can declare `minCompileSdk` in its
// META-INF/com/android/build/gradle/aar-metadata.properties, and AGP refuses to build an app
// whose compileSdk is below it. That constraint lives inside the downloaded artifact, so nothing
// in this repo connected the SQLCipher version to `compileSdkVersion` in android/build.gradle —
// and moving compileSdk to 37 is not a drive-by either, because AGP 8.12 tops out at 36.
//
// Same shape as GRADLE_EMBEDDED_KOTLIN: a measured map, with unmeasured versions rejected.
// Extend it by reading the AAR itself:
//
//   curl -sLO https://repo1.maven.org/maven2/net/zetetic/sqlcipher-android/<v>/sqlcipher-android-<v>.aar
//   unzip -p sqlcipher-android-<v>.aar META-INF/com/android/build/gradle/aar-metadata.properties
const ROOT_BUILD_GRADLE = path.join(ROOT, 'android/build.gradle');
const SQLCIPHER_MIN_COMPILE_SDK: Record<string, number> = {
  '4.17.0': 1, // minCompileSdk=1 — what CI is green on
  '4.18.0': 37, // minCompileSdk=37 — the first release that needs it
  '4.19.0': 37, // minCompileSdk=37 — the #549 bump; kept so the rejection is proven, not assumed
};

function appSqlcipher(): string {
  const text = fs.readFileSync(APP_BUILD_GRADLE, 'utf8');
  const m = /net\.zetetic:sqlcipher-android:([\d.]+)/.exec(text);
  if (!m) {
    throw new Error(`no sqlcipher-android dependency in ${APP_BUILD_GRADLE}`);
  }
  return m[1];
}

function compileSdk(): number {
  const text = fs.readFileSync(ROOT_BUILD_GRADLE, 'utf8');
  const m = /compileSdkVersion\s*=\s*(\d+)/.exec(text);
  if (!m) {
    throw new Error(`no compileSdkVersion in ${ROOT_BUILD_GRADLE}`);
  }
  return Number(m[1]);
}

describe('SQLCipher vs the app compileSdk (#549)', () => {
  it('pins a SQLCipher whose minCompileSdk has been measured', () => {
    const v = appSqlcipher();
    const known = Object.keys(SQLCIPHER_MIN_COMPILE_SDK).sort().join(', ');
    expect(
      SQLCIPHER_MIN_COMPILE_SDK[v] !== undefined
        ? `${v}: measured`
        : `SQLCipher ${v} has no measured minCompileSdk. Read aar-metadata.properties from its ` +
          `AAR and add it to SQLCIPHER_MIN_COMPILE_SDK before adopting the bump (measured so ` +
          `far: ${known}).`,
    ).toBe(`${v}: measured`);
  });

  it('pins a SQLCipher the app compileSdk can build against', () => {
    const v = appSqlcipher();
    const need = SQLCIPHER_MIN_COMPILE_SDK[v];
    const have = compileSdk();
    expect(
      need <= have
        ? 'buildable'
        : `net.zetetic:sqlcipher-android:${v} requires compileSdk >= ${need}, but ` +
          `android/build.gradle compiles against ${have}. :app:checkDebugAarMetadata will fail. ` +
          `Keep SQLCipher on a release with minCompileSdk <= ${have}, or raise compileSdk (and ` +
          `AGP, which caps it) first.`,
    ).toBe('buildable');
  });

  it('rejects the exact 4.19.0-on-compileSdk-36 pairing that broke #549', () => {
    expect(SQLCIPHER_MIN_COMPILE_SDK['4.19.0'] <= 36).toBe(false);
  });
});

describe('Dependabot refuses the SQLCipher bumps the guard above rejects (#549)', () => {
  type Ignore = {'dependency-name'?: string; versions?: string[]};
  type Ecosystem = {
    'package-ecosystem'?: string;
    directory?: string;
    ignore?: Ignore[];
  };
  const config = yaml.load(
    fs.readFileSync(path.join(ROOT, '.github/dependabot.yml'), 'utf8'),
  ) as {updates?: Ecosystem[]};
  const gradle = (config.updates ?? []).find(
    u => u['package-ecosystem'] === 'gradle' && u.directory === '/android',
  );
  function ignored(name: string, version: string): boolean {
    return (gradle?.ignore ?? [])
      .filter(entry => entry['dependency-name'] === name)
      .some(entry =>
        (entry.versions ?? []).some(range => mavenSatisfies(version, range)),
      );
  }

  it('holds every measured SQLCipher release that needs a newer compileSdk', () => {
    const have = compileSdk();
    for (const [v, need] of Object.entries(SQLCIPHER_MIN_COMPILE_SDK)) {
      if (need > have) {
        expect(`${v}: ${ignored('net.zetetic:sqlcipher-android', v) ? 'held' : 'NOT held'}`).toBe(
          `${v}: held`,
        );
      }
    }
  });

  it('still lets a 4.17.x patch through', () => {
    expect(ignored('net.zetetic:sqlcipher-android', '4.17.1')).toBe(false);
  });
});
