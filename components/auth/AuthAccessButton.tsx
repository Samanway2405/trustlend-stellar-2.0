"use client";

import { useState, useRef, useEffect } from "react";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/ui/FocusTrap";
import { type UserRole } from "@/lib/auth/roles";
import { StellarSignInButton } from "@/components/auth/StellarSignInButton";

interface AuthAccessButtonProps {
  className?: string;
  buttonLabel?: string;
}

export function AuthAccessButton({ className, buttonLabel = "Sign in" }: AuthAccessButtonProps) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<UserRole>("borrower");
  const modalRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const closeModal = () => {
    setOpen(false);
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        closeModal();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Return focus to trigger button when modal closes
  useEffect(() => {
    if (!open) {
      const trigger = document.querySelector(".auth-trigger-text")?.closest("button") as HTMLElement;
      trigger?.focus();
    }
  }, [open]);

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <span className="auth-trigger-text">{buttonLabel}</span>
      </button>

      {open ? (
        <div className="auth-overlay" onClick={closeModal} role="presentation">
          <FocusTrap active={true} initialFocusRef={closeButtonRef}>
            <div
              className="auth-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="auth-modal-title"
              aria-describedby="auth-modal-description"
              onClick={(event) => event.stopPropagation()}
              ref={modalRef}
            >
              <button
                type="button"
                className="auth-close"
                onClick={closeModal}
                aria-label="Close sign in dialog"
                ref={closeButtonRef}
              >
                <X size={16} />
              </button>

              <p className="auth-kicker">Auth setup</p>
              <h2 id="auth-modal-title" className="auth-title font-display">Choose role and sign in</h2>
              <p id="auth-modal-description" className="sr-only">
                Dialog for signing in to TrustLend as a borrower or lender
              </p>

            <div className="auth-role-toggle">
              <button
                type="button"
                className={role === "borrower" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setRole("borrower")}
              >
                Borrower
              </button>
              <button
                type="button"
                className={role === "lender" ? "auth-chip auth-chip-active" : "auth-chip"}
                onClick={() => setRole("lender")}
              >
                Lender
              </button>
            </div>

            <div className="mt-8">
              <StellarSignInButton className="auth-primary w-full" role={role} />
            </div>

            <p className="auth-footnote mt-4 text-center text-sm text-gray-400">
              Your role will be securely locked to your wallet on first sign-in.
            </p>
          </div>
          </FocusTrap>
        </div>
      ) : null}
    </>
  );
}
