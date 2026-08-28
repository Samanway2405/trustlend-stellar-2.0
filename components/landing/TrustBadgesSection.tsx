"use client";

import { motion } from "framer-motion";
import { ExternalLink, FileCheck2, Link2, ShieldCheck, Unlock } from "lucide-react";
import type { TrustBadge } from "@/types/landing";

interface TrustBadgesSectionProps {
  badges: TrustBadge[];
}

const ICONS = {
  shield: ShieldCheck,
  verified: FileCheck2,
  openSource: Unlock,
  chain: Link2,
} as const;

export function TrustBadgesSection({ badges }: TrustBadgesSectionProps) {
  if (badges.length === 0) return null;

  return (
    <section id="security" className="section-anchor trust-section">
      <div className="crypto-container py-20">
        <motion.h2
          className="trust-title font-display"
          initial={{ opacity: 0, y: -24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-100px" }}
          transition={{ duration: 0.7, ease: "easeOut" }}
        >
          Built to be checked, not trusted
        </motion.h2>
        <p className="trust-subtitle">
          Every claim below links to the policy, workflow, or source you can read
          for yourself.
        </p>

        <div className="trust-grid">
          {badges.map((badge, i) => {
            const Icon = ICONS[badge.icon];
            return (
              <motion.a
                key={badge.href}
                href={badge.href}
                {...(badge.external
                  ? { target: "_blank", rel: "noopener noreferrer" }
                  : {})}
                className="trust-card"
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-80px" }}
                transition={{ duration: 0.5, delay: i * 0.1, ease: "easeOut" }}
                whileHover={{ y: -4 }}
              >
                <span className="trust-card-icon" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <span className="trust-card-body">
                  <span className="trust-card-label">
                    {badge.label}
                    {badge.external ? (
                      <ExternalLink size={13} aria-hidden="true" />
                    ) : null}
                  </span>
                  <span className="trust-card-detail">{badge.detail}</span>
                </span>
              </motion.a>
            );
          })}
        </div>

        <p className="trust-footnote">
          TrustLend is non-custodial and open source. It has not yet completed a
          third-party audit — the contracts, CI checks, and disclosure policy
          above are what exists today.
        </p>
      </div>
    </section>
  );
}
