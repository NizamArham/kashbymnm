import { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, Modal } from "./ui";

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
    <Modal
      size="sm"
      onClose={onClose}
      title={heading}
      subtitle={subtitle}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-2.5">
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
              <AlertTriangle size={12} className="text-amber-600 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-800">{error}</p>
            </div>
          )}
      </div>
    </Modal>
  );
}
