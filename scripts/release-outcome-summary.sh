#!/usr/bin/env bash
# Release packages workflow summary: outcome, stages, and optional pack evidence.
set -euo pipefail

has_changesets=${HAS_CHANGESETS:-false}
qualify_outcome=${QUALIFY_OUTCOME:-skipped}
changesets_outcome=${CHANGESETS_OUTCOME:-skipped}
preview_outcome=${PREVIEW_OUTCOME:-skipped}
job_status=${JOB_STATUS:-success}
workflow_sha=${CANDIDATE_SHA:-}

if [ "$changesets_outcome" = failure ] || [ "$changesets_outcome" = cancelled ] \
  || [ "$qualify_outcome" = failure ] || [ "$qualify_outcome" = cancelled ] \
  || [ "$preview_outcome" = failure ] || [ "$preview_outcome" = cancelled ] \
  || { [ "$qualify_outcome" = success ] && [ "$preview_outcome" != success ]; } \
  || [ "$job_status" = failure ] || [ "$job_status" = cancelled ]; then
  outcome=failed
elif [ "$qualify_outcome" = success ]; then
  outcome=preview-release
else
  outcome=version-maintenance-only
fi

if [ "$has_changesets" = true ]; then
  version_maintenance=executed
else
  version_maintenance=skipped
fi

if [ "$qualify_outcome" = success ]; then
  qualification=executed
elif [ "$qualify_outcome" = failure ] || [ "$qualify_outcome" = cancelled ]; then
  qualification=failed
else
  qualification=skipped
fi

if [ "$preview_outcome" = success ]; then
  preview=resolved
elif [ "$preview_outcome" = failure ] || [ "$preview_outcome" = cancelled ]; then
  preview=failed
else
  preview=skipped
fi

if [ "$outcome" = preview-release ]; then
  distribution_line='distribution: pkg.pr.new previews resolved'
  candidate_sha=$workflow_sha
else
  distribution_line='distribution: no versioned release'
  if [ "$qualification" = executed ]; then
    candidate_sha=$workflow_sha
  else
    candidate_sha='(not qualified)'
  fi
fi

cat <<EOF
outcome: $outcome
workflow_sha: $workflow_sha
candidate_sha: $candidate_sha
$distribution_line

stages:
- version-maintenance: $version_maintenance
- qualification: $qualification
- pkg.pr.new-preview: $preview
EOF

if [ "$qualification" = executed ] && [ -n "${EVIDENCE_FILE:-}" ] && [ -f "$EVIDENCE_FILE" ]; then
  echo
  echo "packages:"
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const evidence = JSON.parse(readFileSync(process.env.EVIDENCE_FILE, "utf8"));
    for (const pkg of evidence.packages ?? []) {
      console.log(`- ${pkg.name}@${pkg.version} ${pkg.tarball} sha256:${pkg.digest}`);
    }
    console.log("");
    console.log("inter-package ranges:");
    const ranges = evidence.interPackageRanges ?? [];
    if (ranges.length === 0) console.log("- (none)");
    for (const range of ranges) {
      console.log(`- ${range.package} ${range.field} ${range.name}: ${range.specifier}`);
    }
    console.log("");
    console.log("workspace-only refs:");
    const refs = evidence.workspaceRefs ?? [];
    console.log(refs.length === 0 ? "- none" : refs.map((ref) => `- ${ref}`).join("\n"));
    console.log("");
    console.log("test groups:");
    for (const group of evidence.testGroups ?? []) console.log(`- ${group}: executed`);
    console.log("");
    console.log("executed bins:");
    const bins = evidence.executedBins ?? [];
    if (bins.length === 0) console.log("- (none)");
    for (const bin of bins) console.log(`- ${bin}`);
  '
fi

if [ "$qualification" = executed ]; then
  echo
  echo "follow-ups vs ${candidate_sha}:"
  while IFS=$'\t' read -r issue_number issue_label || [ -n "${issue_number:-}" ]; do
    [ -z "${issue_number:-}" ] && continue
    state=pending
    if command -v gh >/dev/null 2>&1 && { [ -n "${GITHUB_TOKEN:-}" ] || [ -n "${GH_TOKEN:-}" ]; }; then
      state=$(gh issue view "$issue_number" --repo "${GITHUB_REPOSITORY:-ScriptedAlchemy/agent-bundle}" \
        --json state --jq .state 2>/dev/null || echo pending)
      state=$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')
    fi
    echo "- #$issue_number $issue_label: $state"
    issue_number=
  done <<'EOF'
680	executable/preflight selection
681	retention
683	native acceptance
685	legacy purge
686	production Flight streaming
688	schema-label provenance
EOF
fi
