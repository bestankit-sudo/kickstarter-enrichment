export type EnrichmentStatus =
  | "pending"
  | "in_progress"
  | "partial"
  | "done"
  | "needs_review"
  | "failed";

export type MatchConfidence = "high" | "medium" | "low";

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
  status: EnrichmentStatus;
};

export type PersonRoleTarget = "Founder" | "Co-Founder" | "C Level executive" | "Director level executive";

export type PersonRow = {
  pageId: string;
  personKey: string;
  status: EnrichmentStatus;
};
