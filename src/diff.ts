/** Small dependency-free line diff (LCS) for reviewable edit results. */
export function unifiedDiff(oldText: string, newText: string, label: string, context = 2, maxLines = 120): string {
  if (oldText === newText) return `(no changes to ${label})`;
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // Trim common prefix/suffix to keep the LCS table small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  type Op = { t: " " | "-" | "+"; s: string };
  let ops: Op[] = [];
  if (midA.length * midB.length > 4_000_000) {
    ops = [...midA.map((s) => ({ t: "-" as const, s })), ...midB.map((s) => ({ t: "+" as const, s }))];
  } else {
    const n = midA.length;
    const m = midB.length;
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] = midA[i] === midB[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) { ops.push({ t: " ", s: midA[i]! }); i++; j++; }
      else if (table[i + 1]![j]! >= table[i]![j + 1]!) ops.push({ t: "-", s: midA[i++]! });
      else ops.push({ t: "+", s: midB[j++]! });
    }
    while (i < n) ops.push({ t: "-", s: midA[i++]! });
    while (j < m) ops.push({ t: "+", s: midB[j++]! });
  }

  const before = a.slice(Math.max(0, start - context), start).map((s) => ({ t: " " as const, s }));
  const after = a.slice(endA, endA + context).map((s) => ({ t: " " as const, s }));
  const all = [...before, ...ops, ...after];
  const lines = [`--- a/${label}`, `+++ b/${label}`, ...all.map((o) => `${o.t}${o.s}`)];
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more diff lines)`].join("\n");
  return lines.join("\n");
}
