export interface PlanProposal {
  id: string;
  summary: string;
  plan: string;          // raw markdown
  sections: PlanSection[];
  comments: PlanComment[];
  status: "pending" | "accepted" | "revising";
}

export interface PlanSection {
  title: string;         // heading text
  level: number;         // 1-3 for h1-h3
  content: string;       // HTML-rendered content under this heading
  startLine: number;     // line index in plan text
  endLine: number;
}

export interface PlanComment {
  id: string;
  sectionIndex: number;
  text: string;
}
