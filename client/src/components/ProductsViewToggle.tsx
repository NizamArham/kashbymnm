import { useNavigate } from "react-router-dom";
import { TabToggle } from "./ui";

// Stock and Manage are two views of the same products — counting what's on the shelf, or editing what's sold — so an
// admin switches between them right at the top of either page instead of through two menu entries. (Staff only
// ever see the Stock view, where this isn't shown.)
export default function ProductsViewToggle({ current }: { current: "stock" | "manage" }) {
  const navigate = useNavigate();
  return (
    <TabToggle
      value={current}
      onChange={(v) => navigate(v === "stock" ? "/inventory" : "/products")}
      options={[
        { value: "stock", label: "Stock" },
        { value: "manage", label: "Manage" },
      ]}
    />
  );
}
