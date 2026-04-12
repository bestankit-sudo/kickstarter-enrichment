import type {
  BestOutreachPath,
  CompanyRow,
  MatchConfidence,
  PreferredOutreachPath,
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

export function preferredPersonOutreachPath(
  person: {
    linkedinUrl: string;
    confidence: MatchConfidence;
    workEmails: string;
  },
  companyRow: CompanyRow,
): PreferredOutreachPath {
  // 1. LinkedIn + high confidence
  if (person.linkedinUrl && person.confidence === "high") {
    return "linkedin";
  }

  // 2. Work email
  if (person.workEmails) {
    return "work_email";
  }

  // 3. LinkedIn + medium confidence
  if (person.linkedinUrl && person.confidence === "medium") {
    return "linkedin";
  }

  // 4. Fallback to company email
  if (companyRow.genericBusinessEmail) {
    return "company_email";
  }

  // 5. Fallback to social DM or contact form
  if (companyRow.instagramUrl || companyRow.tiktokUrl) {
    return "social_dm";
  }

  return "contact_form";
}
