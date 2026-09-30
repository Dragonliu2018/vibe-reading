export type InterviewMode = 'read' | 'quiz';

export function isInterviewMode(value: unknown): value is InterviewMode {
  return value === 'read' || value === 'quiz';
}

export function normalizeInterviewSearch(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchesInterviewSearch(text: string, query: string): boolean {
  const normalized = normalizeInterviewSearch(text);
  return normalizeInterviewSearch(query).split(' ').filter(Boolean).every(term => normalized.includes(term));
}

export function matchesInterviewFilters(
  question: { searchText: string; important: boolean; occurrences: Array<{ company: string; team?: string; origin: 'Private' | 'Public' }> },
  query: string,
  importantOnly: boolean,
  company: string,
  team: string,
  origin = '',
): boolean {
  return matchesInterviewSearch(question.searchText, query)
    && (!importantOnly || question.important)
    && ((!company && !team && !origin) || question.occurrences.some(item =>
      (!company || item.company === company) && (!team || item.team === team) && (!origin || item.origin === origin)));
}

export function interviewAnswerState(expanded: boolean) {
  return {
    answerHidden: !expanded,
    detailsHidden: !expanded,
    previewHidden: !expanded,
    action: expanded ? '收起' : '查看答案',
  };
}
