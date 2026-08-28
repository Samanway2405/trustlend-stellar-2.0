export interface NavItem {
  label: string;
  href: string;
}

export interface HeroContent {
  eyebrow: string;
  titleMain: string;
  titleAccent: string;
  description: string;
}

export interface MetricItem {
  value: string;
  label: string;
}

export interface HighlightContent {
  title: string;
  description: string;
  callout: string;
}

export interface StepItem {
  step: string;
  title: string;
  description: string;
}

export interface ReasonItem {
  title: string;
}

export interface P2PStep {
  step: string;
  title: string;
  description: string;
}

export interface FaqItem {
  question: string;
  answer: string;
}

export interface AboutContent {
  title: string;
  description: string;
}

export interface FooterLink {
  label: string;
  href: string;
}

/** One frame of the animated "How it works" walkthrough. */
export interface HowItWorksStep {
  /** Stable key, also used as the deep-link hash for the step. */
  id: string;
  /** Short label shown in the stepper rail. */
  caption: string;
  title: string;
  description: string;
  /** Selects which illustration the section renders for this step. */
  visual: "wallet" | "reputation" | "funding" | "repayment";
}

/**
 * A verifiable trust signal. Every badge must point at something a visitor can
 * actually open and check — a policy, a workflow, a contract, or an explorer.
 * Nothing here should claim an audit or certification the project does not have.
 */
export interface TrustBadge {
  label: string;
  detail: string;
  href: string;
  /** Resolved to a lucide icon by the component. */
  icon: "shield" | "verified" | "openSource" | "chain";
  /** External links open in a new tab and get rel="noreferrer". */
  external?: boolean;
}
