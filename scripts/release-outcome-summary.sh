#!/usr/bin/env bash
# Release packages workflow summary: outcome, stages, and optional pack evidence.
set -euo pipefail

publish_enabled=${PUBLISH_ENABLED:-false}
has_changesets=${HAS_CHANGESETS:-false}
published=${PUBLISHED:-false}
qualify_outcome=${QUALIFY_OUTCOME:-skipped}
changesets_outcome=${CHANGESETS_OUTCOME:-skipped}
registry_outcome=${REGISTRY_OUTCOME:-skipped}
job_status=${JOB_STATUS:-success}
workflow_sha=${CANDIDATE_SHA:-}

if [ "$changesets_outcome" = failure ] || [ "$changesets_outcome" = cancelled ] \
  || [ "$qualify_outcome" = failure ] || [ "$qualify_outcome" = cancelled ] \
  || [ "$registry_outcome" = failure ] || [ "$registry_outcome" = cancelled ] \
  || [ "$job_status" = failure ] || [ "$job_status" = cancelled ]; then
  outcome=failed
elif [ "$published" = true ] && [ "$publish_enabled" = true ]; then
  outcome=published
elif [ "$qualify_outcome" = success ]; then
  outcome=qualified-without-publish
else
  outcome=version-maintenance-only
fi

if [ "$has_changesets" = true ]; then
  version_maintenance=executed
else
  version_maintenance=skipped
fi

if [ "$qualify_outcome" = success ] || [ "$published" = true ]; then
  qualification=executed
elif [ "$qualify_outcome" = failure ] || [ "$qualify_outcome" = cancelled ]; then
  qualification=failed
else
  qualification=skipped
fi

if [ "$published" = true ]; then
  publication=executed
else
  publication=skipped
fi

if [ "$registry_outcome" = success ]; then
  registry=executed
elif [ "$registry_outcome" = failure ]; then
  registry=failed
else
  registry=skipped
fi

if [ "$outcome" = published ]; then
  publication_line='publication: published'
  candidate_sha=$workflow_sha
else
  publication_line='publication: NOT PUBLISHED'
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
$publication_line

stages:
- version-maintenance: $version_maintenance
- qualification: $qualification
- publication: $publication
- registry-verification: $registry
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
