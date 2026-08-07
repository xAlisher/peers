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

const ROOT = path.join(__dirname, '..');
const WRAPPER_PROPS = path.join(
  ROOT,
  'android/gradle/wrapper/gradle-wrapper.properties',
);
const RN_PLUGIN_VERSIONS = path.join(
  ROOT,
  'node_modules/@react-native/gradle-plugin/gradle/libs.versions.toml',
);

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
