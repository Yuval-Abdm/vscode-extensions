// Section « Rechercher » (webview) : champ de recherche, choix du serveur, résultats avec lettres trouvées en gras.
// Aucun texte venant du serveur n'est inséré en HTML : textContent uniquement.
(function () {
  const vscode = acquireVsCodeApi();
  const strings = JSON.parse(document.getElementById('strings').textContent);
  const profile = document.getElementById('profile');
  const query = document.getElementById('query');
  const reload = document.getElementById('reload');
  const status = document.getElementById('status');
  const results = document.getElementById('results');

  const saved = vscode.getState() || {};
  query.value = saved.query || '';
  let items = [];
  let active = 0;
  let timer;

  const save = () => vscode.setState({ query: query.value });

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Texte avec les lettres trouvées en gras ; `offset` : position du texte dans le chemin complet. */
  function highlighted(className, value, positions, offset) {
    const span = el('span', className);
    let run = '';
    let marked = false;
    const flush = () => {
      if (!run) return;
      span.appendChild(marked ? el('mark', '', run) : document.createTextNode(run));
      run = '';
    };
    for (let i = 0; i < value.length; i++) {
      const hit = positions.has(offset + i);
      if (hit !== marked) {
        flush();
        marked = hit;
      }
      run += value[i];
    }
    flush();
    return span;
  }

  function setActive(index) {
    if (!items.length) return;
    active = (index + items.length) % items.length;
    results.querySelectorAll('li.item').forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    results.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function open(index, pin) {
    const item = items[index];
    if (item) vscode.postMessage({ type: 'open', path: item.path, pin });
  }

  function render(data) {
    items = data.items;
    active = 0;
    status.textContent = data.status.text || '';
    status.className = data.status.kind;
    reload.disabled = data.status.kind === 'busy';
    results.replaceChildren();
    items.forEach((item, index) => {
      const li = el('li', 'item');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(index === 0));
      li.title = item.path;
      const slash = item.path.lastIndexOf('/');
      const positions = new Set(item.positions);
      li.appendChild(highlighted('name', item.path.slice(slash + 1), positions, slash + 1));
      if (slash > 0) li.appendChild(highlighted('dir', item.path.slice(0, slash), positions, 0));
      const compare = el('button', 'compare');
      compare.type = 'button';
      compare.title = strings.compare;
      compare.setAttribute('aria-label', strings.compare);
      compare.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v12M11 2v12M2 5h6M8 11h6"/></svg>';
      compare.addEventListener('click', (event) => {
        event.stopPropagation();
        vscode.postMessage({ type: 'compare', path: item.path });
      });
      li.appendChild(compare);
      li.addEventListener('click', () => {
        setActive(index);
        open(index, false);
      });
      li.addEventListener('dblclick', () => open(index, true));
      results.appendChild(li);
    });
    if (!items.length && data.status.kind === 'done' && data.query) results.appendChild(el('li', 'empty', strings.noResult));
    if (!data.query && data.status.kind !== 'none') results.prepend(el('li', 'hint', data.more ? `${strings.hint} ${strings.more}` : strings.hint));
    if (data.status.kind === 'none') results.appendChild(el('li', 'empty', strings.noServer));
  }

  query.addEventListener('focus', () => vscode.postMessage({ type: 'start' }));
  query.addEventListener('input', () => {
    save();
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'query', value: query.value }), 60);
  });
  query.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive(active + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      open(active, true);
    } else if (event.key === 'Escape' && query.value) {
      query.value = '';
      query.dispatchEvent(new Event('input'));
    }
  });
  reload.addEventListener('click', () => vscode.postMessage({ type: 'reload' }));
  profile.addEventListener('change', () => vscode.postMessage({ type: 'profile', id: profile.value }));

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data.type === 'profiles') {
      profile.replaceChildren(...data.profiles.map((p) => {
        const option = el('option', '', p.label);
        option.value = p.id;
        return option;
      }));
      profile.value = data.selected || '';
      profile.hidden = data.profiles.length < 2;
    } else if (data.type === 'results') {
      render(data);
    } else if (data.type === 'focus') {
      query.focus();
      query.select();
    }
  });

  vscode.postMessage({ type: 'ready' });
  // Recherche restaurée (section rouverte) : relancée telle quelle.
  if (query.value) vscode.postMessage({ type: 'query', value: query.value });
})();
