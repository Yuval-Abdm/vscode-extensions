// Éditeur de rebase interactif (webview) : actions par commit, glisser-déposer, messages des reword et squash.
// Les commits sont listés du plus ancien (en haut, appliqué en premier) au plus récent.
(function () {
  const vscode = acquireVsCodeApi();
  const strings = JSON.parse(document.getElementById('strings').textContent);
  const list = document.getElementById('items');
  const error = document.getElementById('error');
  let items = [];
  let editMessages = true;
  let dragged = -1;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Message proposé pour un squash : tête du groupe puis squash jusqu'à celui-ci (même règle que l'extension). */
  function squashMessage(index) {
    let head = index - 1;
    while (head > 0 && ['squash', 'fixup', 'drop'].includes(items[head].action)) head--;
    if (head < 0) return items[index].message;
    const first = items[head];
    const parts = [first.action === 'reword' && first.newMessage !== undefined ? first.newMessage : first.message];
    for (let i = head + 1; i <= index; i++) {
      if (items[i].action === 'squash') parts.push(items[i].message);
    }
    return parts.join('\n\n');
  }

  function render() {
    list.replaceChildren(
      ...items.map((item, index) => {
        const row = el('div', `item ${item.action}`);
        row.draggable = true;
        row.dataset.index = String(index);
        row.appendChild(el('span', 'handle', '⠿'));
        const select = el('select');
        for (const action of ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']) {
          const option = el('option', '', strings.actions[action]);
          option.value = action;
          option.selected = item.action === action;
          select.appendChild(option);
        }
        select.addEventListener('change', () => {
          item.action = select.value;
          // Le message saisi pour une autre action n'est jamais repris.
          item.newMessage = undefined;
          if (item.action === 'squash' && editMessages) item.newMessage = squashMessage(index);
          if (item.action === 'reword') item.newMessage = item.message;
          render();
        });
        row.appendChild(select);
        row.appendChild(el('span', 'sha', item.sha.slice(0, 8)));
        row.appendChild(el('span', 'summary', item.summary));
        if (editMessages && (item.action === 'reword' || item.action === 'squash')) {
          const text = el('textarea');
          text.value = item.newMessage ?? item.message;
          text.addEventListener('input', () => {
            item.newMessage = text.value;
          });
          text.addEventListener('dragstart', (event) => event.stopPropagation());
          row.draggable = false;
          row.querySelector('.handle').addEventListener('mousedown', () => {
            row.draggable = true;
          });
          row.appendChild(text);
        }
        row.addEventListener('dragstart', () => {
          dragged = index;
          row.classList.add('dragging');
        });
        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          dragged = -1;
          if (row.querySelector('textarea')) row.draggable = false;
        });
        row.addEventListener('mouseup', () => {
          if (row.querySelector('textarea')) row.draggable = false;
        });
        row.addEventListener('dragover', (event) => {
          event.preventDefault();
          row.classList.add('over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('over'));
        row.addEventListener('drop', (event) => {
          event.preventDefault();
          if (dragged < 0 || dragged === index) return;
          const [moved] = items.splice(dragged, 1);
          items.splice(index, 0, moved);
          dragged = -1;
          render();
        });
        return row;
      }),
    );
    error.textContent = validate() ?? '';
  }

  function validate() {
    const kept = items.filter((item) => item.action !== 'drop');
    if (!kept.length) return strings.errors.empty;
    if (kept[0].action === 'squash' || kept[0].action === 'fixup') return strings.errors.squashFirst;
    return undefined;
  }

  document.getElementById('start').addEventListener('click', () => {
    if (validate()) return;
    vscode.postMessage({ type: 'start', items });
  });
  document.getElementById('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));

  window.addEventListener('message', (event) => {
    if (event.data.type !== 'items') return;
    items = event.data.items;
    editMessages = event.data.editMessages;
    render();
  });
  vscode.postMessage({ type: 'ready' });
})();
