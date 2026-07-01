// SPDX-License-Identifier: Apache-2.0

// Diff-overlap attribution algorithm.
//
// Attribution is computed per changed line based on whether that line was last
// modified by an agent edit record.
//
// Implementation:
//   1. For each agent edit on a file, compute the set of lines the edit
//      actually ADDED — `contentAfter.lines - contentBefore.lines`.
//      A line that appears in both contentBefore and contentAfter wasn't
//      modified by this edit, so it doesn't count as agent-authored
//      regardless of how recent the edit is. This is what "last modified
//      by agent" means in practice — the agent has to have changed the
//      line, not just preserved it.
//   2. For each commit-added line, find the agent edit with the latest
//      timestamp whose `addedByEdit` set contains the line. If found,
//      attribute the commit-added line to that edit's agent; otherwise
//      leave it unattributed.
//
// An earlier approach of set-membership over all lines that ever appeared
// in any agent's contentAfter over-attributed boilerplate (`}`, blank lines,
// common imports) and ignored edit order entirely. This approach instead
// requires the line to have been a real change in some agent edit AND to
// have survived to the commit.

export interface CommitDiffFile {
  addedLines: string[];
  removedLines: string[];
}

export interface AgentEdit {
  // contentBefore is required so we can compute which lines the
  // edit actually added (vs. preserved). EditRecord already carries it;
  // the wire format was previously stripping it.
  contentBefore: string;
  contentAfter: string;
  timestamp: string;
}

export interface AttributionResult {
  overallPercentage: number;
  agentAttributedLines: number;
  totalChangedLines: number;
  perFile: Record<
    string,
    { percentage: number; attributedLines: number; totalLines: number }
  >;
}

// Return string[] (preserving duplicate occurrences) instead of
// Set<string>. A line added N times by the agent in one edit contributes N
// claimable occurrences to the attribution pool. Blank lines are still
// excluded — they are excluded symmetrically from both numerator and
// denominator now (see computeAttribution).
function linesAddedByEdit(edit: AgentEdit): string[] {
  const before = new Set<string>();
  for (const line of edit.contentBefore.split('\n')) {
    // Skip empty lines — they are handled symmetrically at the call site.
    if (line.length > 0) before.add(line);
  }
  const added: string[] = [];
  for (const line of edit.contentAfter.split('\n')) {
    // Skip blank lines here; the denominator in computeAttribution applies the
    // same blank filter so numerator and denominator stay symmetric.
    if (line.length === 0) continue;
    // Only count lines the edit actually introduced (not lines preserved
    // from contentBefore). The `before` set uses membership — not a
    // multiset — because we only care whether the line pre-existed, not
    // how many copies of it did.
    if (!before.has(line)) added.push(line);
  }
  return added;
}

export function computeAttribution(input: {
  commitDiffByFile: Record<string, CommitDiffFile>;
  agentEditsByFile: Record<string, AgentEdit[]>;
}): AttributionResult {
  const perFile: AttributionResult['perFile'] = {};
  let totalAttributed = 0;
  let totalLines = 0;

  for (const [path, diff] of Object.entries(input.commitDiffByFile)) {
    const edits = input.agentEditsByFile[path] ?? [];
    // Pre-compute "lines this edit added" for each edit; cheap because the
    // edit count per file is bounded by the 24h retention window. Sorted
    // newest-first so the order is deterministic and ready for a future
    // per-edit breakdown if one is added.
    const editAddedArrays = edits
      .map((e) => ({ added: linesAddedByEdit(e), timestamp: e.timestamp }))
      .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    // Filter blank lines from the denominator symmetrically.
    // `total` now counts only non-blank added lines, matching the numerator.
    const changed = diff.addedLines.filter((l) => l.length > 0);
    const total = changed.length;

    // Build a multiset (Map<line, remaining count>) from all edits' added
    // arrays. This lets each occurrence in the diff consume exactly one entry
    // from the pool, preventing over-attribution.
    const remaining = new Map<string, number>();
    for (const e of editAddedArrays) {
      for (const line of e.added) {
        remaining.set(line, (remaining.get(line) ?? 0) + 1);
      }
    }

    let attributed = 0;
    for (const line of changed) {
      // Pool semantics: `remaining` holds the total number of occurrences each
      // line was genuinely added across all agent edits. Each diff occurrence
      // consumes one unit, so the diff can never be credited more occurrences
      // of a line than the agent actually added. (editAddedArrays is kept sorted
      // newest-first only to preserve that invariant if a per-edit breakdown is
      // ever added; it does not affect the aggregate count.)
      const count = remaining.get(line) ?? 0;
      if (count > 0) {
        attributed++;
        remaining.set(line, count - 1);
      }
    }

    perFile[path] = {
      totalLines: total,
      attributedLines: attributed,
      percentage: total === 0 ? 0 : attributed / total,
    };
    totalAttributed += attributed;
    totalLines += total;
  }

  return {
    overallPercentage: totalLines === 0 ? 0 : totalAttributed / totalLines,
    agentAttributedLines: totalAttributed,
    totalChangedLines: totalLines,
    perFile,
  };
}
