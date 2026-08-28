export type AutoReviewStatus = "queued" | "running" | "completed" | "failed" | "superseded";
export type AutoReviewContextMode = "worktree" | "diff_only";
export type AutoReviewConclusion = "findings" | "no_concerns";
export type AutoReviewSide = "LEFT" | "RIGHT";
export type AutoReviewConfidence = "high" | "medium" | "low";
export type AutoReviewTrigger = "launch" | "assignment" | "head_changed" | "reconnect" | "retry";

export interface ReviewCandidate {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  authorLogin: string;
  authorAvatar: string;
  baseSha: string;
  headSha: string;
  hasPendingReview: boolean;
  isDraft?: boolean;
}

export type AutoReviewCategory =
  | "correctness"
  | "security"
  | "data"
  | "concurrency"
  | "performance"
  | "maintainability"
  | "test_coverage"
  | "question";

export interface AutoReviewFinding {
  id: string;
  runId: string;
  ordinal: number;
  category: AutoReviewCategory;
  confidence: AutoReviewConfidence;
  path: string;
  line: number;
  endLine: number;
  side: AutoReviewSide;
  comment: string;
  evidence: string | null;
  githubUrl: string | null;
}

export interface AutoReviewRun {
  id: string;
  repo: string;
  prId: number;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  authorLogin: string;
  baseSha: string;
  headSha: string;
  status: AutoReviewStatus;
  trigger: AutoReviewTrigger;
  contextMode: AutoReviewContextMode | null;
  provider: "codex";
  model: string | null;
  reasoning: string | null;
  conclusion: AutoReviewConclusion | null;
  overallComment: string | null;
  toneSampleHash: string | null;
  queuedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  repairCount: number;
  recoveryCount: number;
  supersededByHeadSha: string | null;
  jsonArtifactPath: string | null;
  markdownArtifactPath: string | null;
  exportError: string | null;
  notificationKind: string | null;
  notificationDueAt: number | null;
  notifiedAt: number | null;
  viewedAt: number | null;
}

export interface AutoReviewRepoSetting {
  repo: string;
  enabled: boolean;
  modelOverride: string | null;
  reasoningOverride: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CompleteRunInput {
  id: string;
  contextMode: AutoReviewContextMode;
  conclusion: AutoReviewConclusion;
  overallComment: string | null;
  toneSampleHash: string | null;
  completedAt: number;
  findings: AutoReviewFinding[];
  exportError: string | null;
}

export interface FailRunInput {
  id: string;
  code: string;
  message: string;
  completedAt: number;
}
