import { useMemo, useState } from "react";

export type SortDir = "asc" | "desc";

// Shared "click a column header to sort" state + sorting logic, paired
// with <SortHeader> in components/ui.tsx. The caller supplies how to pull
// a comparable value out of one row for a given key — everything else
// (which column is active, which direction, re-sorting on click, string
// vs number comparison) is handled here instead of being re-written per
// table, matching how it already worked on Stocks/Analytics before this
// was pulled out into a shared hook.
export function useSortableData<T, K extends string>(
  data: T[],
  getValue: (item: T, key: K) => string | number,
  defaultKey: K,
  defaultDir: SortDir = "asc"
) {
  const [sortKey, setSortKey] = useState<K>(defaultKey);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  function toggleSort(key: K) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const sorted = useMemo(() => {
    const copy = [...data];
    copy.sort((a, b) => {
      const av = getValue(a, sortKey);
      const bv = getValue(b, sortKey);
      const cmp = typeof av === "string" ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [data, sortKey, sortDir]);

  return { sorted, sortKey, sortDir, toggleSort };
}
