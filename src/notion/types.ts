export type EnrichmentStatus =
  | "pending"
  | "in_progress"
  | "partial"
  | "done"
  | "needs_review"
  | "failed"
  | "stale";

export type PeopleEnrichStatus =
  | "done"
  | "partial"
  | "failed"
  | "needs_review"
  | "skipped"
  | "stale";

export type MatchConfidence = "high" | "medium" | "low";

export type CompanyOutreachReadiness =
  | "ready_person"
  | "ready_company_channel"
  | "review"
  | "blocked";

export type BestOutreachPath =
  | "linkedin_person"
  | "work_email"
  | "company_email"
  | "linkedin_person_review"
  | "social_dm"
  | "contact_form";

export type PreferredOutreachPath =
  | "linkedin"
  | "work_email"
  | "company_email"
  | "social_dm"
  | "contact_form";

export type OutreachRelevance =
  | "founder"
  | "co_founder"
  | "ceo"
  | "partnerships"
  | "marketing"
  | "other";

export type DiscoveryMethod =
  | "apollo"
  | "serp_fallback"
  | "manual"
  | "founder_direct";

export type PersonRoleTarget = "Founder" | "Co-Founder" | "C Level executive" | "Director level executive";

export type KickstarterCampaign = {
  pageId: string;
  campaignName: string;
  kickstarterUrlRaw: string;
  kickstarterUrlKey: string;
  externalLink: string;
  founderCreator: string;
};

export type CompanyRow = {
  pageId: string;
  campaignName: string;
  kickstarterUrlRaw: string;
  kickstarterUrlKey: string;
  externalLink: string;
  companyDomain: string;
  companyName: string;
  companyDescription: string;
  status: EnrichmentStatus;
  linkedinCompanyUrl: string;
  genericBusinessEmail: string;
  apolloOrgId: string;
  employeeCount: number | null;
  industry: string;
  foundedYear: number | null;
  totalFunding: string;
  fundingStage: string;
  companyPhone: string;
  keywords: string;
  xUrl: string;
  instagramUrl: string;
  facebookUrl: string;
  youtubeUrl: string;
  tiktokUrl: string;
  contactFormUrl: string;
  lastCheckedAt: string;
};

export type PersonRow = {
  pageId: string;
  personKey: string;
  status: PeopleEnrichStatus;
  apolloPersonId: string;
  linkedinPersonUrl: string;
  matchConfidence: MatchConfidence;
  isPrimaryCandidate: boolean;
  candidateRank: number | null;
  discoveryMethod: DiscoveryMethod | "";
  outreachRelevance: OutreachRelevance | "";
  evidenceSummary: string;
  workEmails: string;
  emailStatus: string;
  fullName: string;
  firstName: string;
  lastName: string;
  headline: string;
  city: string;
  country: string;
  photoUrl: string;
};
