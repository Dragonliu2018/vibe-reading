/** Interview pages only. Answers remain complete and visible without JS. */
import { isInterviewMode, normalizeInterviewSearch, matchesInterviewFilters, interviewAnswerState, type InterviewMode } from './interview-state';
let lifecycle: AbortController | undefined;

function initInterview() {
  if (document.body.dataset.contentType !== 'Interview') {
    lifecycle?.abort();
    lifecycle = undefined;
    return;
  }
  const article = document.querySelector<HTMLElement>('article.prose');
  const toolbar = document.querySelector<HTMLElement>('.interview-toolbar');
  if (!article || !toolbar || toolbar.dataset.ready) return;
  const cards = [...article.querySelectorAll<HTMLElement>('.interview-question')];
  if (!cards.length) return;
  // The toolbar starts hidden outside the Markdown slot. Place it after the
  // authored series navigation, before the first chapter, before revealing it.
  const seriesNavigation = article.querySelector<HTMLElement>('.interview-series');
  if (seriesNavigation) seriesNavigation.after(toolbar);
  else article.querySelector('.interview-chapter')?.before(toolbar);
  lifecycle?.abort();
  lifecycle = new AbortController();
  const signal = lifecycle.signal;
  toolbar.dataset.ready = 'true';

  const input = toolbar.querySelector<HTMLInputElement>('input[type="search"]')!;
  const importantButton = toolbar.querySelector<HTMLButtonElement>('[data-interview-important]')!;
  const organizationSelect = toolbar.querySelector<HTMLSelectElement>('[data-interview-organization]')!;
  const originSelect = toolbar.querySelector<HTMLSelectElement>('[data-interview-origin]')!;
  const count = toolbar.querySelector<HTMLOutputElement>('.interview-count')!;
  const annotationProgress = toolbar.querySelector<HTMLElement>('.interview-annotation-progress')!;
  const hint = toolbar.querySelector<HTMLElement>('.interview-mode-hint')!;
  const modeButtons = [...toolbar.querySelectorAll<HTMLButtonElement>('[data-interview-mode]')];
  const chapters = [...article.querySelectorAll<HTMLElement>('.interview-chapter')];
  const tocGroups = [...document.querySelectorAll<HTMLDetailsElement>('.interview-toc-group')];
  const manualGroups = new WeakSet<HTMLDetailsElement>();
  let activeChapter = '';
  tocGroups.forEach(group => group.querySelector('summary')?.addEventListener('click', () => manualGroups.add(group)));
  // Every new page starts in self-test mode, regardless of earlier preferences.
  let mode: InterviewMode = 'quiz';
  let importantOnly = false;

  const questions = cards.map(card => {
    const heading = card.querySelector<HTMLHeadingElement>('h3')!;
    const answer = card.querySelector<HTMLElement>('.interview-answer')!;
    const details = answer.querySelector<HTMLElement>('.interview-details')!;
    const preview = answer.querySelector<HTMLElement>('.interview-preview');
    const searchText = normalizeInterviewSearch(`${heading.textContent} ${answer.textContent}`);
    const important = card.dataset.important === 'true';
    // Filter data comes from the question card, not its visual source links.
    const occurrences = JSON.parse(card.dataset.occurrences ?? '[]') as Array<{ company: string; team?: string; origin: 'Private' | 'Public' }>;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'interview-question-toggle';
    button.setAttribute('aria-controls', answer.id);
    const title = document.createElement('span');
    title.className = 'interview-question-title';
    const hasInteractiveTitle = !!heading.querySelector('a, button, input, select, textarea');
    const plainTitle = heading.textContent ?? '';
    const action = document.createElement('span');
    action.className = 'interview-question-action';
    action.setAttribute('aria-hidden', 'true');
    if (hasInteractiveTitle) {
      // Do not nest authored links or other controls inside a button.
      button.classList.add('interview-question-toggle-standalone');
      button.append(action);
      heading.after(button);
    } else {
      // Move, do not copy: keep inline code and the heading's stable ID.
      title.append(...heading.childNodes);
      button.append(title, action);
      heading.append(button);
    }
    const question = { card, heading, answer, details, preview, button, action, searchText, important, occurrences, plainTitle, hasInteractiveTitle, expanded: false };
    button.addEventListener('click', () => {
      question.expanded = !question.expanded;
      render(question);
    });
    return question;
  });
  const occurrenceDetails = [...article.querySelectorAll<HTMLDetailsElement>('.interview-occurrences')];
  occurrenceDetails.forEach(current => current.addEventListener('toggle', () => {
    if (!current.open) return;
    occurrenceDetails.forEach(other => { if (other !== current) other.open = false; });
  }, { signal }));
  document.addEventListener('click', event => {
    if (event.target instanceof Node && occurrenceDetails.some(details => details.contains(event.target))) return;
    occurrenceDetails.forEach(details => { details.open = false; });
  }, { signal });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    occurrenceDetails.forEach(details => { details.open = false; });
  }, { signal });
  const taggedCount = questions.filter(question => question.important || question.occurrences.length > 0).length;
  annotationProgress.textContent = `已标注 ${taggedCount} / ${questions.length} 题`;
  annotationProgress.hidden = taggedCount === 0;
  const occurrences = questions.flatMap(question => question.occurrences);
  const companies = [...new Set(occurrences.map(item => item.company))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const origins = new Set(occurrences.map(item => item.origin));
  importantButton.hidden = !questions.some(question => question.important);
  organizationSelect.closest<HTMLElement>('.interview-organization-filter')!.hidden = companies.length === 0;
  originSelect.closest<HTMLElement>('.interview-origin-filter')!.hidden = origins.size < 2;
  for (const option of [...originSelect.options]) {
    if (option.value) option.hidden = !origins.has(option.value as 'Private' | 'Public');
  }
  for (const [companyIndex, company] of companies.entries()) {
    const group = document.createElement('optgroup');
    group.label = company;
    const allCompany = new Option(`${company}（全部）`, `company-${companyIndex}`);
    allCompany.dataset.company = company;
    group.append(allCompany);
    const teams = [...new Set(occurrences.filter(item => item.company === company && item.team).map(item => item.team!))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    for (const [teamIndex, team] of teams.entries()) {
      const teamOption = new Option(`${company} / ${team}`, `team-${companyIndex}-${teamIndex}`);
      teamOption.dataset.company = company;
      teamOption.dataset.team = team;
      group.append(teamOption);
    }
    organizationSelect.append(group);
  }

  function render(question: typeof questions[number]) {
    const { card, answer, details, preview, button, action, expanded } = question;
    const state = interviewAnswerState(expanded);
    answer.hidden = state.answerHidden;
    details.hidden = state.detailsHidden;
    if (preview) preview.hidden = state.previewHidden;
    button.setAttribute('aria-expanded', String(expanded));
    card.dataset.expanded = String(expanded);
    action.textContent = state.action;
    if (question.hasInteractiveTitle) button.setAttribute('aria-label', `${state.action}：${question.plainTitle}`);
  }

  function updateMode() {
    toolbar!.dataset.mode = mode;
    modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.interviewMode === mode)));
    hint.textContent = {
      read: '完整阅读答案，点击题目可折叠。',
      quiz: '先尝试回答，再点击题目核对答案。',
    }[mode];
    questions.forEach(question => { question.expanded = mode === 'read'; render(question); });
  }

  const empty = document.createElement('p');
  empty.className = 'interview-empty';
  empty.textContent = '没有符合条件的题目，试试调整搜索或筛选。';
  empty.hidden = true;
  empty.setAttribute('data-pagefind-ignore', 'all');
  toolbar.after(empty);

  function filter() {
    const query = normalizeInterviewSearch(input.value);
    const selectedOrganization = organizationSelect.selectedOptions[0];
    const company = selectedOrganization?.dataset.company ?? '';
    const team = selectedOrganization?.dataset.team ?? '';
    const origin = originSelect.value;
    let visible = 0;
    for (const question of questions) {
      question.card.hidden = !matchesInterviewFilters(question, query, importantOnly, company, team, origin);
      if (!question.card.hidden) visible++;
    }
    chapters.forEach(chapter => {
      chapter.hidden = [...chapter.querySelectorAll<HTMLElement>('.interview-question')].every(card => card.hidden);
    });
    // Keep the navigation consistent with the visible questions.
    tocGroups.forEach(group => {
      const chapter = document.getElementById(group.dataset.chapterId ?? '')?.closest<HTMLElement>('.interview-chapter');
      group.hidden = chapter?.hidden ?? false;
    });
    document.querySelectorAll<HTMLAnchorElement>('.interview-toc a').forEach(link => {
      const target = document.getElementById(link.dataset.id ?? '');
      const card = target?.closest<HTMLElement>('.interview-question');
      if (link.parentElement?.tagName === 'LI') link.parentElement.hidden = card?.hidden ?? false;
    });
    count.textContent = query || importantOnly || company || team || origin ? `${visible} / ${questions.length} 题` : `共 ${questions.length} 题`;
    empty.hidden = visible > 0;
  }

  modeButtons.forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.interviewMode;
    if (!isInterviewMode(next) || next === mode) return;
    // Keep the question currently being read in place when many answers collapse.
    const top = toolbar!.getBoundingClientRect().bottom;
    const current = questions.find(q => !q.card.hidden && q.card.getBoundingClientRect().bottom > top);
    const before = current?.heading.getBoundingClientRect().top;
    mode = next;
    updateMode();
    if (current && before !== undefined && before < window.innerHeight) {
      const delta = current.heading.getBoundingClientRect().top - before;
      if (window.matchMedia('(min-width: 960px)').matches) document.querySelector('.main-scroll')?.scrollBy(0, delta);
      else window.scrollBy(0, delta);
    }
  }));
  input.addEventListener('input', filter);
  importantButton.addEventListener('click', () => {
    importantOnly = !importantOnly;
    importantButton.setAttribute('aria-pressed', String(importantOnly));
    filter();
  });
  organizationSelect.addEventListener('change', filter);
  originSelect.addEventListener('change', filter);

  function activateChapter(target: HTMLElement, force = false) {
    const chapterId = target.closest('.interview-chapter')?.querySelector('h2')?.id ?? target.id;
    if (!force && chapterId === activeChapter) return;
    activeChapter = chapterId;
    tocGroups.forEach(group => {
      const active = group.dataset.chapterId === chapterId;
      group.dataset.active = String(active);
      if (active) group.open = true;
      else if (!manualGroups.has(group)) group.open = false;
    });
  }

  function revealTarget(id: string) {
    const target = document.getElementById(id);
    if (!target || !article!.contains(target)) return;
    // Deep links also work if search or a filter has hidden this card/chapter.
    if (target.closest<HTMLElement>('.interview-question')?.hidden || target.closest<HTMLElement>('.interview-chapter')?.hidden) {
      input.value = '';
      importantOnly = false;
      importantButton.setAttribute('aria-pressed', 'false');
      organizationSelect.value = '';
      originSelect.value = '';
      filter();
    }
    const question = questions.find(q => q.card.contains(target));
    if (question) { question.expanded = true; render(question); }
    activateChapter(target, true);
  }

  // Capture runs before the existing desktop/mobile TOC scroll handlers.
  document.addEventListener('click', event => {
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href^="#"]') : null;
    if (!link) return;
    try { revealTarget(decodeURIComponent(link.hash.slice(1))); } catch { /* Malformed authored hash. */ }
  }, { capture: true, signal });
  document.addEventListener('article:section-active', event => {
    const id = (event as CustomEvent<string>).detail;
    const target = document.getElementById(id);
    if (target) activateChapter(target);
  }, { signal });
  const revealHash = () => {
    if (!location.hash) return;
    try { revealTarget(decodeURIComponent(location.hash.slice(1))); } catch { /* Invalid URI. */ }
  };
  window.addEventListener('hashchange', revealHash, { signal });
  updateMode();
  filter();
  toolbar.hidden = false;
  revealHash();
  // A collapsed answer changes the initial fragment's position. Re-align after
  // all article enhancements (including code blocks) have finished.
  if (location.hash) requestAnimationFrame(() => {
    if (signal.aborted) return;
    let target: HTMLElement | null;
    try { target = document.getElementById(decodeURIComponent(location.hash.slice(1))); } catch { return; }
    if (!target) return;
    const desktop = window.matchMedia('(min-width: 960px)').matches;
    const scroller = desktop ? document.querySelector<HTMLElement>('.main-scroll') : null;
    const offset = toolbar.offsetHeight + (desktop ? 16 : 68);
    const delta = target.getBoundingClientRect().top - (scroller?.getBoundingClientRect().top ?? 0) - offset;
    if (scroller) scroller.scrollBy(0, delta);
    else window.scrollBy(0, delta);
  });
}

initInterview();
document.addEventListener('astro:page-load', initInterview);
