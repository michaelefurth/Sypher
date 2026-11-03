#!/bin/bash
# Auto-deploy for cPanel, run by cron (cPanel → Advanced → Cron Jobs), for example every 5 minutes:
#
#   */5 * * * * /bin/bash /home/syphsevs/repositories/Sypher/scripts/cpanel-autodeploy.sh >/dev/null 2>&1
#
# Use the path of the repository cPanel cloned (cPanel → Git Version Control shows it).
# Each run fetches the production branch (the branch the clone has checked out). If GitHub has a
# commit that hasn't been deployed yet, it checks it out and copies the site into public_html with
# scripts/deploy-site.sh, the same script .cpanel.yml runs. Nothing happens when there's nothing new.
#
# Settings (optional environment variables):
#   DEPLOY_BRANCH  branch to deploy        (default: the branch the clone has checked out)
#   DEPLOYPATH     web root                (default: /home/syphsevs/public_html/)
#   DEPLOY_LOG     log file                (default: ~/logs/sypher-autodeploy.log)
#
# A failed copy is retried on the next run. Only one run works at a time.

main() {
  set -uo pipefail
  local repo branch log deployed_file deployed remote
  repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  log="${DEPLOY_LOG:-$HOME/logs/sypher-autodeploy.log}"
  mkdir -p "$(dirname "$log")"
  say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$log"; }

  # One run at a time; a lock older than 30 minutes is treated as left over from a crash.
  # (LOCK is global so the exit trap can still see it after main returns.)
  LOCK="$repo/.git/autodeploy.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +30 2>/dev/null)" ]; then
      say "removing stale lock"; rm -rf "$LOCK"; mkdir "$LOCK" || return 0
    else
      return 0
    fi
  fi
  trap 'rm -rf "$LOCK"' EXIT

  cd "$repo" || return 1
  branch="${DEPLOY_BRANCH:-$(git symbolic-ref --quiet --short HEAD)}"
  if [ -z "$branch" ]; then say "no branch checked out; set DEPLOY_BRANCH"; return 1; fi

  if ! git fetch --quiet origin "$branch" 2>>"$log"; then say "could not fetch $branch from GitHub"; return 1; fi
  remote="$(git rev-parse "origin/$branch")"
  deployed_file="$repo/.git/autodeploy-deployed"
  deployed="$(cat "$deployed_file" 2>/dev/null || true)"
  [ "$remote" = "$deployed" ] && return 0

  say "deploying $branch at ${remote:0:7} (last deployed: ${deployed:0:7})"
  if [ "$(git rev-parse --abbrev-ref HEAD)" != "$branch" ]; then git checkout --quiet "$branch" 2>>"$log" || { say "could not check out $branch"; return 1; }; fi
  if ! git reset --hard --quiet "$remote" 2>>"$log"; then say "could not check out ${remote:0:7}"; return 1; fi
  if /bin/bash "$repo/scripts/deploy-site.sh" >> "$log" 2>&1; then
    echo "$remote" > "$deployed_file"
    say "deployed: $(git log -1 --format='%h %s')"
  else
    say "DEPLOY FAILED for ${remote:0:7}; will retry on the next run"
    return 1
  fi
}

# The whole script is read before it runs, so a deploy that updates this file can't trip it up.
main "$@"
exit $?
