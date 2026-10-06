// Graphe des commits (webview) : lignes virtualisées, graphe SVG, recherche, détails du commit sélectionné.
// Aucun texte venant de git n'est inséré en HTML : textContent uniquement.
(function () {
  const vscode = acquireVsCodeApi();
  const strings = JSON.parse(document.getElementById('strings').textContent);
  const ROW = 24;
  const LANE = 14;
  const RADIUS = 4;
  const COLORS = ['#3794ff', '#f0883e', '#89d185', '#c586c0', '#e5c07b', '#4ec9b0', '#f14c4c', '#d7ba7d'];
  const SVG = 'http://www.w3.org/2000/svg';

  const list = document.getElementById('list');
  const spacer = document.getElementById('spacer');
  const viewport = document.getElementById('rows');
  const details = document.getElementById('details');
  const search = document.getElementById('search');
  const allToggle = document.getElementById('all');
  const count = document.getElementById('count');

  let rows = [];
  let hasMore = false;
  let loading = false;
  let selected = -1;
  let maxWidth = 1;
  let matches = new Set();
  let matchOrder = [];
  let matchIndex = -1;

  const color = (index) => COLORS[index % COLORS.length];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function graphCell(row) {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('width', String(maxWidth * LANE + LANE));
    svg.setAttribute('height', String(ROW));
    const x = (column) => LANE / 2 + column * LANE;
    const segment = (x1, y1, x2, y2, lane) => {
      const path = document.createElementNS(SVG, 'path');
      const mid = (y1 + y2) / 2;
      path.setAttribute('d', x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`);
      path.setAttribute('stroke', color(lane));
      path.setAttribute('stroke-width', '2');
      path.setAttribute('fill', 'none');
      svg.appendChild(path);
    };
    for (const edge of row.up) segment(x(edge.from), 0, x(edge.to), ROW / 2, edge.color);
    for (const edge of row.down) segment(x(edge.from), ROW / 2, x(edge.to), ROW, edge.color);
    const dot = document.createElementNS(SVG, 'circle');
    const merge = row.parents.length > 1;
    dot.setAttribute('cx', String(x(row.column)));
    dot.setAttribute('cy', String(ROW / 2));
    dot.setAttribute('r', String(merge ? RADIUS + 1 : RADIUS));
    dot.setAttribute('fill', merge ? 'var(--vscode-editor-background)' : color(row.color));
    dot.setAttribute('stroke', color(row.color));
    dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
    return svg;
  }

  function renderRow(row, index) {
    let className = 'row';
    if (index === selected) className += ' selected';
    if (matches.has(index)) className += ' match';
    const div = el('div', className);
    div.style.top = `${index * ROW}px`;
    div.dataset.index = String(index);
    div.dataset.vscodeContext = JSON.stringify({ webviewSection: 'commit', sha: row.sha, preventDefaultContextMenuItems: true });
    const graph = el('div', 'graph');
    graph.appendChild(graphCell(row));
    div.appendChild(graph);
    const message = el('div', 'message');
    for (const ref of row.refs) {
      const badge = el('span', `ref ${ref.kind}${ref.current ? ' current' : ''}`, ref.name);
      if (ref.kind === 'branch') {
        badge.dataset.vscodeContext = JSON.stringify({ webviewSection: 'branch', branch: ref.name, sha: row.sha, preventDefaultContextMenuItems: true });
      }
      message.appendChild(badge);
    }
    message.appendChild(el('span', 'summary', row.summary));
    message.title = row.summary;
    div.appendChild(message);
    div.appendChild(el('div', 'author', row.author));
    div.appendChild(el('div', 'date', row.date));
    div.appendChild(el('div', 'sha', row.sha.slice(0, 8)));
    return div;
  }

  function render() {
    spacer.style.height = `${rows.length * ROW}px`;
    document.documentElement.style.setProperty('--graph-width', `${maxWidth * LANE + LANE}px`);
    const first = Math.max(0, Math.floor(list.scrollTop / ROW) - 10);
    const last = Math.min(rows.length, Math.ceil((list.scrollTop + list.clientHeight) / ROW) + 10);
    viewport.replaceChildren(...rows.slice(first, last).map((row, i) => renderRow(row, first + i)));
    count.textContent = strings.commits.replace('{0}', String(rows.length)) + (hasMore ? '+' : '');
    if (hasMore && !loading && last >= rows.length - 50) {
      loading = true;
      vscode.postMessage({ type: 'loadMore' });
    }
  }

  function reveal(index) {
    const top = index * ROW;
    if (top < list.scrollTop || top + ROW > list.scrollTop + list.clientHeight) list.scrollTop = top - list.clientHeight / 2;
  }

  function select(index) {
    if (index < 0 || index >= rows.length) return;
    selected = index;
    reveal(index);
    render();
    details.hidden = false;
    details.replaceChildren(el('div', 'meta', strings.loading));
    vscode.postMessage({ type: 'select', sha: rows[index].sha });
  }

  function showDetails(message) {
    if (selected < 0 || rows[selected].sha !== message.sha) return;
    const row = rows[selected];
    const children = [el('div', 'meta', `${row.sha} · ${row.author} <${row.authorMail}> · ${message.date}`), el('pre', '', message.message)];
    message.files.forEach((file, index) => {
      const line = el('div', 'file');
      line.appendChild(el('span', 'status', file.status));
      line.appendChild(document.createTextNode(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path));
      line.title = strings.openDiff;
      line.addEventListener('dblclick', () => vscode.postMessage({ type: 'openFile', sha: row.sha, index }));
      line.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') vscode.postMessage({ type: 'openFile', sha: row.sha, index });
      });
      line.tabIndex = 0;
      children.push(line);
    });
    if (!message.files.length) children.push(el('div', 'meta', strings.noFiles));
    details.replaceChildren(...children);
  }

  function find() {
    const query = search.value.trim().toLowerCase();
    matches = new Set();
    matchOrder = [];
    matchIndex = -1;
    if (query) {
      rows.forEach((row, index) => {
        const hit =
          row.summary.toLowerCase().includes(query) ||
          row.author.toLowerCase().includes(query) ||
          row.sha.startsWith(query) ||
          row.refs.some((ref) => ref.name.toLowerCase().includes(query));
        if (hit) {
          matches.add(index);
          matchOrder.push(index);
        }
      });
    }
    render();
  }

  list.addEventListener('scroll', () => requestAnimationFrame(render));
  window.addEventListener('resize', () => requestAnimationFrame(render));
  viewport.addEventListener('click', (event) => {
    const row = event.target.closest('.row');
    if (row) select(Number(row.dataset.index));
  });
  document.addEventListener('keydown', (event) => {
    if (event.target === search) return;
    if (event.key === 'ArrowDown') select(Math.min(rows.length - 1, selected + 1));
    else if (event.key === 'ArrowUp') select(Math.max(0, selected - 1));
    else return;
    event.preventDefault();
  });
  search.addEventListener('input', find);
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || !matchOrder.length) return;
    matchIndex = (matchIndex + (event.shiftKey ? matchOrder.length - 1 : 1)) % matchOrder.length;
    select(matchOrder[matchIndex]);
  });
  allToggle.addEventListener('change', () => vscode.postMessage({ type: 'setAll', all: allToggle.checked }));
  document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'rows') {
      if (message.reset) {
        const previous = selected >= 0 ? rows[selected].sha : undefined;
        rows = [];
        maxWidth = 1;
        selected = -1;
        rows = message.rows;
        if (previous) selected = rows.findIndex((row) => row.sha === previous);
        if (selected < 0) details.hidden = true;
      } else {
        rows = rows.concat(message.rows);
      }
      for (const row of message.rows) maxWidth = Math.max(maxWidth, row.width);
      hasMore = message.hasMore;
      loading = false;
      allToggle.checked = message.all;
      if (search.value) find();
      else render();
    } else if (message.type === 'details') {
      showDetails(message);
    } else if (message.type === 'error') {
      loading = false;
      count.textContent = message.message;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
