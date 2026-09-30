import yaml from 'js-yaml';
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Interview-only, progressive enhancement: keep every original node and heading
 * in the initial HTML. Without JavaScript the complete article is still readable.
 * Only numbered h3 questions are cards; references and ordinary prose stay prose.
 */
const element = (tagName, properties, children) => ({ type: 'element', tagName, properties, children });
const text = node => node.type === 'text' ? node.value : (node.children ?? []).map(text).join('');
const isHeading = (node, level) => node.type === 'element' && node.tagName === `h${level}`;
const isQuestion = node => isHeading(node, 3) && /^\d+\.\d+\s+/.test(text(node));
// A multiline YAML comment keeps the annotation beside its question without
// putting authoring metadata into the rendered article or heading text.
const metadataMarker = /^<!--[ \t]*interview-meta[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*-->$/;

function questionMetadata(node, heading, base) {
  if (node?.type !== 'raw' || !node.value.trim().startsWith('<!-- interview-meta')) return null;
  const match = node.value.trim().match(metadataMarker);
  const fail = message => { throw new Error(`题目「${text(heading)}」的 interview-meta ${message}`); };
  if (!match) fail('格式错误');
  let data;
  try { data = yaml.load(match[1]); } catch { fail('不是有效的 YAML'); }
  if (!data || Array.isArray(data) || typeof data !== 'object') fail('必须是对象');
  if (Object.keys(data).some(key => !['important', 'reports', 'occurrences'].includes(key))) fail('包含不支持的字段');
  if (data.important !== undefined && typeof data.important !== 'boolean') fail('important 必须是布尔值');
  if (data.reports !== undefined && !Array.isArray(data.reports)) fail('reports 必须是数组');
  if (data.occurrences !== undefined && !Array.isArray(data.occurrences)) fail('occurrences 必须是数组');
  if (!data.important && !(data.reports?.length) && !(data.occurrences?.length)) fail('至少需要一项可见标注');
  for (const [index, occurrence] of (data.occurrences ?? []).entries()) {
    const invalid = message => fail(`occurrences 第 ${index + 1} 条${message}`);
    if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) invalid('必须是对象');
    if (Object.keys(occurrence).some(key => !['company', 'team', 'date', 'round', 'origin', 'source'].includes(key))) invalid('包含不支持的字段');
    for (const field of ['company', 'team', 'round']) {
      if ((field === 'company' || hasOwn(occurrence, field)) && (typeof occurrence[field] !== 'string' || !occurrence[field].trim())) invalid(`${field} 必须是非空文本`);
    }
    const date = occurrence.date instanceof Date && !Number.isNaN(occurrence.date.valueOf())
      ? occurrence.date.toISOString().slice(0, 10) : occurrence.date;
    if (!((typeof date === 'string' || Number.isInteger(date)) && /^20\d{2}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/.test(String(date)))) invalid('date 必须是 YYYY、YYYY-MM 或 YYYY-MM-DD');
    occurrence.date = String(date);
    if (occurrence.origin !== 'Private' && occurrence.origin !== 'Public') invalid('origin 必须是 Private 或 Public');
    const source = occurrence.source;
    const sourceIsEmpty = source == null || (typeof source === 'string' && !source.trim());
    if (occurrence.origin === 'Public' && sourceIsEmpty) invalid('Public 记录必须填写 HTTPS 来源链接');
    if (sourceIsEmpty) {
      delete occurrence.source;
    } else {
      if (typeof source !== 'string') invalid('source 必须是链接文本');
      const value = source.trim();
      if (occurrence.origin === 'Private' && value.startsWith('/') && !value.startsWith('//')) {
        const articlePrefix = `${base}/articles/`;
        if (!value.startsWith('/articles/') && !value.startsWith(articlePrefix)) invalid('站内 source 必须指向 /articles/...');
        occurrence.source = value.startsWith(articlePrefix) ? value : `${base}${value}`;
      } else {
        try { if (new URL(value).protocol !== 'https:') invalid('source 必须是 HTTPS 或站内文章链接'); }
        catch { invalid('source 必须是有效的 HTTPS 或站内文章链接'); }
        occurrence.source = value;
      }
    }
  }
  for (const report of data.reports ?? []) {
    if (!report || Array.isArray(report) || typeof report !== 'object' ||
        Object.keys(report).some(key => !['company', 'team', 'year', 'source'].includes(key)) ||
        typeof report.company !== 'string' || !report.company.trim() ||
        (report.team !== undefined && (typeof report.team !== 'string' || !report.team.trim())) ||
        !Number.isInteger(report.year) || report.year < 2000 || report.year > 2100 ||
        typeof report.source !== 'string') fail('reports 需要 company、year 和 source');
    try {
      if (new URL(report.source).protocol !== 'https:') fail('source 必须是 HTTPS 链接');
    } catch { fail('source 必须是有效的 HTTPS 链接'); }
  }
  return data;
}

function isConclusion(node) {
  if (node?.type !== 'element' || node.tagName !== 'p') return false;
  const first = node.children.find(child => child.type !== 'text' || child.value.trim());
  return first?.tagName === 'strong' && /^(结论|核心结论|简答|一句话(?:回答)?)[：:]$/.test(text(first).trim());
}

export function rehypeInterview({ base = '' } = {}) {
  const normalizedBase = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
  return (tree, file) => {
    if (file?.data?.astro?.frontmatter?.contentType !== 'Interview') return;

    // Presentation only: the source series links and their destinations survive.
    for (const node of tree.children) {
      if (node.tagName === 'p' && /^系列导航[：:]/.test(text(node))) {
        node.properties ??= {};
        node.properties.className = [...(node.properties.className ?? []), 'interview-series'];
        for (const child of node.children) {
          if (child.tagName === 'a' && text(child).includes('本文')) {
            child.properties ??= {};
            child.properties.ariaCurrent = 'page';
          }
        }
      }
    }

    // Prevent collisions with author-supplied IDs; Astro assigns heading slugs
    // after this plugin, so none of the generated IDs use the heading namespace.
    const ids = new Set();
    const collectIds = node => {
      if (node.properties?.id) ids.add(node.properties.id);
      node.children?.forEach(collectIds);
    };
    collectIds(tree);
    let sequence = 0;
    const nextId = () => {
      let id;
      do { id = `interview-answer-${++sequence}`; } while (ids.has(id));
      ids.add(id);
      return id;
    };

    const cards = nodes => {
      const result = [];
      for (let i = 0; i < nodes.length;) {
        if (!isQuestion(nodes[i])) { result.push(nodes[i++]); continue; }
        const heading = nodes[i++];
        // Metadata belongs to this question only and is omitted from the answer.
        // A blank-line text node may sit between the heading and the HTML comment.
        let markerIndex = i;
        while (nodes[markerIndex]?.type === 'text' && !nodes[markerIndex].value.trim()) markerIndex++;
        const metadata = questionMetadata(nodes[markerIndex], heading, normalizedBase);
        if (metadata) nodes.splice(markerIndex, 1);
        const firstText = heading.children[0];
        const number = firstText?.type === 'text' && firstText.value.match(/^(\d+\.\d+\s+)(.*)$/s);
        if (number) {
          heading.children.splice(0, 1,
            element('span', { className: ['interview-question-number'] }, [{ type: 'text', value: number[1] }]),
            { type: 'text', value: number[2] },
          );
        }
        const answer = [];
        while (i < nodes.length && !isHeading(nodes[i], 2) && !isHeading(nodes[i], 3)) answer.push(nodes[i++]);
        const first = answer.findIndex(node => node.type !== 'text' || node.value.trim());
        const hasConclusion = first >= 0 && isConclusion(answer[first]);
        const preview = hasConclusion ? answer.splice(first, 1) : [];
        const id = nextId();
        const labels = [];
        if (metadata?.important) labels.push(element('span', { className: ['interview-important'] }, [{ type: 'text', value: '★ 重点' }]));
        const occurrences = [...(metadata?.occurrences ?? [])];
        for (const report of metadata?.reports ?? []) occurrences.push({
          company: report.company, ...(report.team ? { team: report.team } : {}),
          date: String(report.year), origin: 'Public', source: report.source,
        });
        const groups = new Map();
        for (const occurrence of occurrences) {
          const key = JSON.stringify([occurrence.company, occurrence.team ?? '']);
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(occurrence);
        }
        for (const group of groups.values()) {
          const first = group[0];
          const organization = first.team ? `${first.company} · ${first.team}` : first.company;
          const privateCount = group.filter(item => item.origin === 'Private').length;
          const publicCount = group.length - privateCount;
          const breakdown = [privateCount && `Private ${privateCount}`, publicCount && `Public ${publicCount}`].filter(Boolean).join(' · ');
          const entries = group.map(item => {
            const context = `${item.date}${item.round ? ` · ${item.round}` : ''}`;
            return element('li', {}, [
              element('span', { className: ['interview-occurrence-origin'], dataOrigin: item.origin }, [{ type: 'text', value: item.origin }]),
              element('span', { className: ['interview-occurrence-context'] }, [{ type: 'text', value: context }]),
              ...(item.source ? [element('a', {
                className: ['interview-occurrence-source'], href: item.source,
                ...(!item.source.startsWith('/') ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
                ariaLabel: item.origin === 'Private' ? `查看 ${organization} Private 复盘` : `查看 ${organization} Public 面经来源`,
              }, [{ type: 'text', value: item.source.startsWith('/') ? '博客 →' : `${item.origin === 'Private' ? '复盘' : '来源'} ↗` }])] : []),
            ]);
          });
          const originLabel = privateCount && publicCount ? 'Private + Public' : privateCount ? 'Private' : 'Public';
          labels.push(element('details', { className: ['interview-occurrences'] }, [
            element('summary', {
              ariaLabel: `${organization}，${group.length} 条记录（${breakdown}）`,
            }, [
              element('span', { className: ['interview-organization-name'] }, [{ type: 'text', value: organization }]),
              element('span', { className: ['interview-origin-summary'], dataOrigin: privateCount && publicCount ? 'Mixed' : privateCount ? 'Private' : 'Public' }, [{ type: 'text', value: originLabel }]),
              element('span', { className: ['interview-occurrence-count'] }, [{ type: 'text', value: `${group.length} 次` }]),
            ]),
            element('div', { className: ['interview-occurrence-popover'] }, [
              element('div', { className: ['interview-occurrence-heading'] }, [
                element('span', {}, [{ type: 'text', value: organization }]),
                element('small', {}, [{ type: 'text', value: `${group.length} 条记录` }]),
              ]),
              element('ul', {}, entries),
            ]),
          ]));
        }
        result.push(element('section', {
          className: ['interview-question'],
          ...(metadata?.important ? { dataImportant: 'true' } : {}),
          ...(occurrences.length ? {
            dataOccurrences: JSON.stringify(occurrences.map(item => ({
              company: item.company, ...(item.team ? { team: item.team } : {}), origin: item.origin,
            }))),
          } : {}),
        }, [
          heading,
          ...(labels.length ? [element('div', { className: ['interview-labels'], ariaLabel: '题目标注' }, labels)] : []),
          element('div', { className: ['interview-answer'], id }, [
            ...(hasConclusion ? [element('div', { className: ['interview-preview'] }, preview)] : []),
            element('div', { className: ['interview-details'] }, answer),
          ]),
        ]));
      }
      return result;
    };

    const result = [];
    for (let i = 0; i < tree.children.length;) {
      if (!isHeading(tree.children[i], 2)) {
        const lead = [];
        while (i < tree.children.length && !isHeading(tree.children[i], 2)) lead.push(tree.children[i++]);
        result.push(...cards(lead));
        continue;
      }
      const heading = tree.children[i++];
      const body = [];
      while (i < tree.children.length && !isHeading(tree.children[i], 2)) body.push(tree.children[i++]);
      if (body.some(isQuestion)) {
        result.push(element('section', { className: ['interview-chapter'] }, [heading, ...cards(body)]));
      } else {
        result.push(heading, ...body);
      }
    }
    tree.children = result;
  };
}
