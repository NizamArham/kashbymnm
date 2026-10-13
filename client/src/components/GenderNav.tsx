import { CategoryTreeNode } from "../lib/categoryTree";

// The Men / Women / Kids tabs and their hover category panel — shared by Stocks and
// Manage products so the two pages browse the catalogue exactly the same way.
export interface GenderNavItem {
  value: string;
  label: string;
  count: number;
  categories: CategoryTreeNode[];
}

// ---------------------------------------------------------------------------
// Gender tabs
// ---------------------------------------------------------------------------
export function GenderNavTabs({
  items,
  activeValue,
  onHover,
  onSelectGender,
}: {
  items: GenderNavItem[];
  activeValue: string;
  onHover: (value: string | null) => void;
  onSelectGender: (value: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 flex-shrink-0">
      {items.map((item) => {
        const isActive = activeValue === item.value;
        return (
          <button
            key={item.value}
            onMouseEnter={() => onHover(item.value)}
            onClick={() => onSelectGender(item.value)}
            className={`relative flex-shrink-0 flex items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors ${
              isActive ? "text-gray-900" : "text-gray-500 hover:text-gray-900"
            }`}
          >
            {item.label}
            <span className="text-xs text-gray-400">{item.count}</span>
            {isActive && (
              <span className="absolute left-3 right-3 -bottom-2 h-0.5 bg-gray-900 rounded-full" />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mega-menu panel
// ---------------------------------------------------------------------------
export function GenderNavPanel({
  item,
  selectedGender,
  selectedCategory,
  selectedSubCategory,
  onSelectCategory,
  onSelectSubCategory,
}: {
  item: GenderNavItem;
  selectedGender?: string;
  selectedCategory?: string;
  selectedSubCategory?: string;
  onSelectCategory: (genderValue: string, category: string) => void;
  onSelectSubCategory: (genderValue: string, category: string, subCategory: string) => void;
}) {
  return (
    <div className="absolute left-0 right-0 top-full pt-2 z-30">
      <div className="bg-white border border-gray-200 rounded-2xl shadow-xl p-7 max-h-[70vh] overflow-y-auto">
        <div className="columns-2 sm:columns-4 lg:columns-6 gap-x-8">
          {item.categories.map((cat) => {
            const isCatActive =
              selectedGender === item.value &&
              selectedCategory === cat.category &&
              !selectedSubCategory;
            return (
              <div key={cat.category} className="break-inside-avoid mb-7">
                <button
                  onClick={() => onSelectCategory(item.value, cat.category)}
                  className={`group w-full flex items-center justify-between gap-2 pb-2 mb-2.5 border-b transition-colors ${
                    isCatActive ? "border-gray-900" : "border-gray-100 hover:border-gray-300"
                  }`}
                >
                  <span
                    className={`text-sm font-semibold truncate transition-colors ${
                      isCatActive ? "text-gray-900" : "text-gray-700 group-hover:text-gray-900"
                    }`}
                  >
                    {cat.category}
                  </span>
                  <span className="flex-shrink-0 text-[11px] font-medium text-gray-400 bg-gray-50 rounded-full px-2 py-0.5">
                    {cat.count}
                  </span>
                </button>
                {cat.subCategories.length > 0 && (
                  <div className="space-y-0.5">
                    {cat.subCategories.map((sub) => {
                      const isSubActive =
                        selectedGender === item.value &&
                        selectedCategory === cat.category &&
                        selectedSubCategory === sub.name;
                      return (
                        <button
                          key={sub.name}
                          onClick={() => onSelectSubCategory(item.value, cat.category, sub.name)}
                          className={`w-full flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 -mx-2 text-sm transition-colors ${
                            isSubActive ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
                          }`}
                        >
                          <span className="truncate">{sub.name}</span>
                          <span className={`flex-shrink-0 text-[11px] ${isSubActive ? "text-gray-300" : "text-gray-400"}`}>
                            {sub.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
