import { ReactNode } from "react";
import { X, AlertTriangle } from "lucide-react";

export interface ModalOption {
  key: string;
  icon: ReactNode;
  iconBgClass?: string;
  title: string;
  subtitle: string;
  onClick: () => void;
}

export default function OptionsModal({
  heading,
  subtitle,
  options,
  error,
  onClose,
}: {
  heading: string;
  subtitle?: string;
  options: ModalOption[];
  error?: string | null;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-sm w-full shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 border-b border-gray-100 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900">{heading}</h3>
            {subtitle && <p className="text-xs text-gray-400 truncate">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-2.5">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={opt.onClick}
              className="w-full flex items-center gap-3 px-4 py-3 border border-gray-200 rounded-xl hover:border-black hover:shadow-sm transition text-left"
            >
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  opt.iconBgClass ?? "bg-gray-100"
                }`}
              >
                {opt.icon}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900">{opt.title}</p>
                <p className="text-xs text-gray-400">{opt.subtitle}</p>
              </div>
            </button>
          ))}

          {error && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-1">
              <AlertTriangle size={13} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}