// SPDX-License-Identifier: GPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from "react";
let ask: ((message: string, verification?: string) => Promise<boolean>) | null =
  null;
export function confirmAction(
  message: string,
  verification?: string,
): Promise<boolean> {
  if (!ask) return Promise.resolve(false);
  return ask(message, verification);
}
export function Modal({
  title,
  children,
  onClose,
  alert = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  alert?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current
      ?.querySelector<HTMLElement>(
        'button,input,select,textarea,[tabindex="0"]',
      )
      ?.focus();
    const key = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"],[role="alertdialog"]',
      );
      const top =
        document.querySelector('[role="alertdialog"]') ||
        dialogs[dialogs.length - 1];
      if (top !== ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const els = [
          ...ref.current!.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
          ),
        ].filter((n) => n.getClientRects().length);
        const first = els[0],
          last = els.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      const remaining = [
        ...document.querySelectorAll('[role="dialog"],[role="alertdialog"]'),
      ];
      if (
        !remaining.length ||
        remaining.some((d) => previous && d.contains(previous))
      )
        previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className="modal review-dialog"
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={title}
      >
        <h2>{title}</h2>
        {children}
      </section>
    </div>
  );
}
export function ConfirmationHost() {
  const [request, setRequest] = useState<{
    message: string;
    verification?: string;
    resolve: (v: boolean) => void;
  } | null>(null);
  const [typed, setTyped] = useState("");
  useEffect(() => {
    ask = (message, verification) =>
      new Promise((resolve) => {
        setTyped("");
        setRequest({ message, verification, resolve });
      });
    return () => {
      ask = null;
    };
  }, []);
  if (!request) return null;
  const finish = (v: boolean) => {
    request.resolve(v);
    setRequest(null);
  };
  return (
    <Modal title="Review changes" onClose={() => finish(false)} alert>
      <p className="review-message">{request.message}</p>
      {request.verification && (
        <label>
          Type {request.verification} to continue
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
        </label>
      )}
      <div className="form-actions">
        <button className="secondary" onClick={() => finish(false)}>
          Cancel
        </button>
        <button
          disabled={!!request.verification && typed !== request.verification}
          onClick={() => finish(true)}
        >
          Confirm
        </button>
      </div>
    </Modal>
  );
}
