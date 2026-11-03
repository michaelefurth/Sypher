#!/bin/bash
# Copies the public website from this repository into the web root.
# Used by both deploy paths, so they always ship the same files:
#   - cPanel → Git Version Control → "Deploy HEAD Commit" (.cpanel.yml)
#   - the cron auto-deploy (scripts/cpanel-autodeploy.sh)
# Supabase code, docs, brand masters, build scripts and partials stay in the repository only.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

DEPLOYPATH="${DEPLOYPATH:-/home/syphsevs/public_html/}"
if [ ! -d "$DEPLOYPATH" ]; then
  echo "Web root $DEPLOYPATH not found; set DEPLOYPATH." >&2
  exit 1
fi

/bin/cp index.html about.html approach.html contact.html services.html solutions.html work.html privacy.html 404.html "$DEPLOYPATH"
/bin/cp favicon.ico robots.txt sitemap.xml site.webmanifest .htaccess "$DEPLOYPATH"
/bin/cp -R assets for insights portal "$DEPLOYPATH"
echo "Copied the site to $DEPLOYPATH"
