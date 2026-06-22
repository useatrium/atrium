const { execFileSync } = require('node:child_process');

// electron-builder signs + notarizes the .app but leaves the .dmg wrapper bare
// (unsigned, unstapled) — so a downloaded dmg warns on first open. This
// afterAllArtifactBuild hook seals each .dmg: codesign → notarytool → staple.
// Notarization runs only when APPLE_API_* are present; otherwise the dmg is
// just signed (and a no-creds/unsigned build is left untouched).
function detectIdentity() {
  const out = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  });
  const match = out.match(/"(Developer ID Application:[^"]+)"/);
  return match ? match[1] : null;
}

exports.default = async function notarizeDmg(context) {
  const dmgs = (context.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  if (dmgs.length === 0) return [];

  const identity = process.env.CSC_NAME || detectIdentity();
  if (!identity) {
    console.log('[notarize-dmg] no Developer ID identity in keychain — skipping');
    return [];
  }
  const key = process.env.APPLE_API_KEY;
  const keyId = process.env.APPLE_API_KEY_ID;
  const issuer = process.env.APPLE_API_ISSUER;

  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] signing ${dmg}`);
    execFileSync('codesign', ['--force', '--sign', identity, '--timestamp', dmg], {
      stdio: 'inherit',
    });
    if (key && keyId && issuer) {
      console.log('[notarize-dmg] notarizing dmg (waiting on Apple)…');
      execFileSync(
        'xcrun',
        ['notarytool', 'submit', dmg, '--key', key, '--key-id', keyId, '--issuer', issuer, '--wait'],
        { stdio: 'inherit' },
      );
      execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
      console.log('[notarize-dmg] stapled');
    } else {
      console.log('[notarize-dmg] APPLE_API_* not set — dmg signed but not notarized');
    }
  }
  return [];
};
