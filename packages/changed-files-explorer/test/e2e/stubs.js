// Chargé par les tests e2e depuis le dossier de Changed Files Explorer : `require('vscode')` y renvoie
// l'API de cette extension, ce qui permet de simuler ses dialogues (chaque extension a sa propre instance d'API).
const vscode = require('vscode');

/** Valide automatiquement les dialogues modaux de l'extension avec le premier bouton, et les enregistre. */
function autoConfirm(modals) {
  vscode.window.showWarningMessage = async (message, ...rest) => {
    const opts = typeof rest[0] === 'object' && rest[0] && !Array.isArray(rest[0]) ? rest.shift() : {};
    modals.push(message);
    return opts.modal ? rest[0] : undefined;
  };
}

module.exports = { autoConfirm };
