import type {
  BestOutreachPath,
  CompanyRow,
  MatchConfidence,
} from "../notion/types.js";

type CandidateInfo = {
  linkedinUrl: string;
  confidence: MatchConfidence;
  workEmails: string;
} | null;

export function bestCompanyOutreachPath(
  primaryCandidate: CandidateInfo,
  companyRow: CompanyRow,
): BestOutreachPath | null {
  // 1. High-confidence LinkedIn person
  if (
    primaryCandidate?.linkedinUrl &&
    primaryCandidate.confidence === "high"
  ) {
    return "linkedin_person";
  }

  // 2. Verified person work email
  if (primaryCandidate?.workEmails) {
    return "work_email";
  }

  // 3. Generic business email
  if (companyRow.genericBusinessEmail) {
    return "company_email";
  }

  // 4. Medium-confidence LinkedIn person
  if (
    primaryCandidate?.linkedinUrl &&
    primaryCandidate.confidence === "medium"
  ) {
    return "linkedin_person_review";
  }

  // 5. Instagram or TikTok
  if (companyRow.instagramUrl || companyRow.tiktokUrl) {
    return "social_dm";
  }

  // 6. Contact form
  if (companyRow.contactFormUrl) {
    return "contact_form";
  }

  // 7. None
  return null;
}

