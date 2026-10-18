import { ReactNode } from "react";
import { Modal } from "./ui";

// The one dialog shape for the steps of a return or exchange (Parcel received, Inspection report, an exchange's old items): a single fixed,
// wide size so they all look the same and never jump about, split in two — the thing itself (the parcel, the figures) on the left, the items
// on the right, which scrolls when there are many. A message — what's missing, or what went wrong — sits in the footer beside the buttons.
export default function StepModal({
  title,
  subtitle,
  onClose,
  left,
  children,
  message,
  buttons,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  // The left pane.
  left: ReactNode;
  // The right pane.
  children: ReactNode;
  // Shown in red beside the buttons.
  message?: string | null;
  buttons: ReactNode;
}) {
  return (
    <Modal size="3xl" height="h-[min(40rem,calc(100dvh-2rem))]" flush title={title} subtitle={subtitle} onClose={onClose}
      footer={
        <>
          <span className={`mr-auto min-w-0 basis-full text-xs sm:basis-0 sm:flex-1 ${message ? "text-red-500" : "text-gray-400"}`}>{message}</span>
          {buttons}
        </>
      }
    >
      <div className="h-full overflow-y-auto lg:grid lg:grid-cols-[24rem_minmax(0,1fr)] lg:overflow-hidden">
        <div className="border-b border-gray-100 bg-gray-50/70 px-5 py-5 lg:overflow-y-auto lg:border-b-0 lg:border-r">{left}</div>
        <div className="px-6 py-5 lg:overflow-y-auto">{children}</div>
      </div>
    </Modal>
  );
}
