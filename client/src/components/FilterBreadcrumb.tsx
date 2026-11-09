import { Fragment } from "react";

export interface Crumb {
  label: string;
  // Narrows the list back to this level. The last crumb is where you already are, so it never needs one.
  onClick?: () => void;
}

// Where the list is narrowed to — "All › Women › Pants & Chinos › Elastic Waist Pant". Every step but the last takes you back to it
// (click "Women" to see all of Women again), so the path is the filter as well as the label for it.
export function FilterBreadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  return (
    <nav aria-label="Filtered to" className="inline">
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <Fragment key={`${i}-${crumb.label}`}>
            {i > 0 && <span className="text-gray-300"> › </span>}
            {last || !crumb.onClick ? (
              <span className={last && crumbs.length > 1 ? "font-medium text-gray-900" : undefined} aria-current={last ? "page" : undefined}>
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={crumb.onClick}
                title={`Show everything in ${crumb.label}`}
                className="rounded text-gray-500 underline-offset-2 hover:text-gray-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-300"
              >
                {crumb.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
