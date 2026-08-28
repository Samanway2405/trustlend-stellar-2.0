"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { HowItWorksStep } from "@/types/landing";

interface HowItWorksSectionProps {
  steps: HowItWorksStep[];
}

/** How long each step stays on screen before the walkthrough advances. */
const STEP_DURATION_MS = 6000;

export function HowItWorksSection({ steps }: HowItWorksSectionProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // Auto-advancing motion is disorienting for anyone who has asked the OS to
  // reduce it, so hold on one step and let them drive with the stepper instead.
  const autoplay = !prefersReducedMotion && !paused;

  useEffect(() => {
    if (!autoplay || steps.length < 2) return;
    const timer = setTimeout(() => {
      setActiveIndex((current) => (current + 1) % steps.length);
    }, STEP_DURATION_MS);
    return () => clearTimeout(timer);
    // activeIndex restarts the dwell timer each time the step changes, so a
    // manual selection gets a full turn rather than whatever time was left.
  }, [autoplay, activeIndex, steps.length]);

  const select = useCallback((index: number) => setActiveIndex(index), []);

  const onRailKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      setActiveIndex((current) => {
        const delta = event.key === "ArrowRight" ? 1 : -1;
        return (current + delta + steps.length) % steps.length;
      });
    },
    [steps.length],
  );

  if (steps.length === 0) return null;
  const active = steps[activeIndex];

  return (
    <section id="how-it-works" className="section-anchor how-section">
      <div className="crypto-container py-20">
        <motion.h2
          className="how-title font-display"
          initial={{ opacity: 0, y: -24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        >
          How TrustLend works
        </motion.h2>
        <p className="how-subtitle">
          Four steps from wallet to funded loan — every one of them enforced by a
          contract you can read.
        </p>

        <div
          className="how-layout"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocusCapture={() => setPaused(true)}
          onBlurCapture={() => setPaused(false)}
        >
          {/* ── Stepper rail ── */}
          <div
            className="how-rail"
            role="tablist"
            aria-label="How TrustLend works"
            onKeyDown={onRailKeyDown}
          >
            {steps.map((step, index) => {
              const isActive = index === activeIndex;
              return (
                <button
                  key={step.id}
                  type="button"
                  role="tab"
                  id={`how-tab-${step.id}`}
                  aria-selected={isActive}
                  aria-controls={`how-panel-${step.id}`}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => select(index)}
                  className={`how-step${isActive ? " how-step--active" : ""}`}
                >
                  <span className="how-step-index" aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="how-step-text">
                    <span className="how-step-caption">{step.caption}</span>
                    <span className="how-step-title">{step.title}</span>
                  </span>

                  {/* Progress bar doubles as the countdown to the next step. */}
                  {isActive ? (
                    <motion.span
                      className="how-step-progress"
                      aria-hidden="true"
                      key={`${step.id}-${autoplay}`}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: 1 }}
                      transition={
                        autoplay
                          ? { duration: STEP_DURATION_MS / 1000, ease: "linear" }
                          : { duration: 0.3, ease: "easeOut" }
                      }
                    />
                  ) : null}
                </button>
              );
            })}
          </div>

          {/* ── Animated stage ── */}
          <div
            className="how-stage"
            role="tabpanel"
            id={`how-panel-${active.id}`}
            aria-labelledby={`how-tab-${active.id}`}
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={active.id}
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -16 }}
                transition={{ duration: 0.45, ease: "easeOut" }}
                className="how-stage-inner"
              >
                <StepVisual visual={active.visual} animate={!prefersReducedMotion} />
                <h3 className="how-stage-title font-display">{active.title}</h3>
                <p className="how-stage-copy">{active.description}</p>
              </motion.div>
            </AnimatePresence>

            <a href="/auth" className="how-cta">
              Get started free
            </a>
          </div>
        </div>

        {/* Screen readers get the step change announced without the animation. */}
        <p className="sr-only" aria-live="polite">
          {`Step ${activeIndex + 1} of ${steps.length}: ${active.title}`}
        </p>
      </div>
    </section>
  );
}

/* ── Illustrations ───────────────────────────────────────────────────────── */

const PULSE = {
  animate: { opacity: [0.35, 1, 0.35] },
  transition: { duration: 2.4, repeat: Infinity, ease: "easeInOut" as const },
};

function StepVisual({
  visual,
  animate,
}: {
  visual: HowItWorksStep["visual"];
  animate: boolean;
}) {
  // Reduced motion still gets the diagram, just held still at full opacity.
  const pulse = animate ? PULSE : { animate: { opacity: 1 } };

  return (
    <div className="how-visual" aria-hidden="true">
      <svg viewBox="0 0 320 160" role="presentation" className="how-visual-svg">
        <defs>
          <linearGradient id="how-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#7f2fd1" />
            <stop offset="100%" stopColor="#25d39f" />
          </linearGradient>
        </defs>

        {visual === "wallet" ? (
          <g>
            <rect x="28" y="44" width="104" height="72" rx="12" fill="url(#how-grad)" opacity="0.16" />
            <rect x="28" y="44" width="104" height="72" rx="12" fill="none" stroke="url(#how-grad)" strokeWidth="2" />
            <circle cx="112" cy="80" r="7" fill="#7f2fd1" />
            <motion.g {...pulse}>
              <path d="M140 80 H196" stroke="#25d39f" strokeWidth="2.5" strokeDasharray="7 7" />
              <path d="M188 73 L196 80 L188 87" fill="none" stroke="#25d39f" strokeWidth="2.5" />
            </motion.g>
            <rect x="204" y="52" width="88" height="56" rx="12" fill="#ffffff" stroke="#d7ddf3" strokeWidth="2" />
            <path d="M232 80 l10 10 l20 -22" fill="none" stroke="#25d39f" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ) : null}

        {visual === "reputation" ? (
          <g>
            {[0, 1, 2, 3, 4].map((i) => (
              <motion.rect
                key={i}
                x={44 + i * 40}
                width="26"
                rx="5"
                fill="url(#how-grad)"
                y={124 - (i + 1) * 16}
                height={(i + 1) * 16}
                initial={animate ? { scaleY: 0 } : false}
                animate={{ scaleY: 1 }}
                style={{ originY: 1, transformBox: "fill-box" }}
                transition={{ duration: 0.5, delay: i * 0.12, ease: "easeOut" }}
              />
            ))}
            <path d="M32 128 H288" stroke="#d7ddf3" strokeWidth="2" />
          </g>
        ) : null}

        {visual === "funding" ? (
          <g>
            <circle cx="62" cy="80" r="26" fill="url(#how-grad)" opacity="0.18" />
            <circle cx="62" cy="80" r="26" fill="none" stroke="url(#how-grad)" strokeWidth="2" />
            <rect x="126" y="56" width="68" height="48" rx="10" fill="#ffffff" stroke="#7f2fd1" strokeWidth="2" />
            <rect x="150" y="72" width="20" height="18" rx="3" fill="#7f2fd1" />
            <path d="M154 72 v-6 a6 6 0 0 1 12 0 v6" fill="none" stroke="#7f2fd1" strokeWidth="2.5" />
            <circle cx="258" cy="80" r="26" fill="url(#how-grad)" opacity="0.18" />
            <circle cx="258" cy="80" r="26" fill="none" stroke="url(#how-grad)" strokeWidth="2" />
            <motion.circle
              cx="62"
              cy="80"
              r="5"
              fill="#25d39f"
              animate={animate ? { cx: [62, 160, 258] } : { cx: 160 }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
            />
          </g>
        ) : null}

        {visual === "repayment" ? (
          <g>
            <motion.path
              d="M40 118 C 96 118, 108 60, 160 60 S 232 34, 284 34"
              fill="none"
              stroke="url(#how-grad)"
              strokeWidth="3.5"
              strokeLinecap="round"
              initial={animate ? { pathLength: 0 } : false}
              animate={{ pathLength: 1 }}
              transition={{ duration: 1.6, ease: "easeOut" }}
            />
            <path d="M32 128 H288" stroke="#d7ddf3" strokeWidth="2" />
            <motion.circle cx="284" cy="34" r="7" fill="#25d39f" {...pulse} />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
