#!/usr/bin/env bash
# Cut a new Firefox release: bump version → sign (AMO, unlisted) → publish the signed .xpi as a
# GitHub Release asset → regenerate updates.json so installed copies auto-update.
#
# Prereqs (same as sign.sh): Node >= 20, gh logged in, and AMO creds in the env:
#   export WEB_EXT_API_KEY="user:XXXXXXX:NNN"  WEB_EXT_API_SECRET="XXXXXXXXXXXX"
# Then just: ./release.sh
#
# Auto-update model: clients poll update_url (raw updates.json) and install whatever higher version it
# lists. So an update reaches browsers when WE run this. Upstream (vivek-nexus) changes reach users only
# after `git fetch upstream && git merge upstream/main` THEN ./release.sh — deliberate, not automatic.
set -euo pipefail
cd "$(dirname "$0")"

REPO="qutwo-internal/faqutwo-transcript-browser-extension"
MANIFEST="extension/manifest.json"

# bump the 4th version segment (our fork's release counter; upstream owns the first three)
OLD="$(node -p "require('./${MANIFEST}').version")"
NEW="$(node -e 'const v=process.argv[1].split("."); v[3]=String((+(v[3]||0))+1); console.log(v.slice(0,4).join("."))' "$OLD")"
node -e 'const fs=require("fs"),p=process.argv[3];let s=fs.readFileSync(p,"utf8");fs.writeFileSync(p,s.replace(`"version": "${process.argv[1]}"`,`"version": "${process.argv[2]}"`))' "$OLD" "$NEW" "$MANIFEST"
echo "→ releasing v${NEW} (was ${OLD})"

ADDON_ID="$(node -p "require('./${MANIFEST}').browser_specific_settings.gecko.id")"
XPI="faqutwo-transcript-browser-extension-${NEW}.xpi"

# sign (reuses sign.sh: Node guard + web-ext sign → dist/)
./sign.sh
SIGNED="$(ls -t dist/*.xpi | head -1)"

# publish the signed build as a public GitHub Release asset (stable, predictable URL)
gh release create "v${NEW}" "${SIGNED}#${XPI}" -R "$REPO" -t "v${NEW}" \
  -n "Signed Firefox build of v${NEW} (faqutwo live-transcript fork). Auto-update target."

# point Firefox at the new signed xpi (latest-only is enough — FF jumps to the highest applicable)
LINK="https://github.com/${REPO}/releases/download/v${NEW}/${XPI}"
cat > updates.json <<JSON
{
  "addons": {
    "${ADDON_ID}": {
      "updates": [
        { "version": "${NEW}", "update_link": "${LINK}" }
      ]
    }
  }
}
JSON

git add "$MANIFEST" updates.json
git commit -m "release v${NEW}"
git push

echo "✓ released v${NEW}. Installed copies auto-update from update_url within ~a day."
echo "  First install (once): ${SIGNED} → Firefox about:addons → ⚙ → Install Add-on From File."
