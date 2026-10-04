// @ts-check
// Conversion d'un `.vscode/sftp.json` (extension SFTP de Natizyskunk / liximomo) vers le format deploy.json.
// Fonction pure (aucune dépendance à vscode) : les mots de passe sont renvoyés à part pour le coffre sécurisé.

/** Formatage par défaut des messages (« {0} » → argument), remplacé par vscode.l10n.t dans l'extension. */
const format = (message, ...args) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)]));

/**
 * @param {any} json contenu de sftp.json (objet ou tableau de configurations)
 * @param {(message: string, ...args: any[]) => string} [t] traduction des avertissements
 * @returns {{ config: { defaultProfile?: string, profiles: Record<string, any> }, secrets: { profile: any, password: string }[], warnings: string[] }}
 */
function convertSftpConfig(json, t = format) {
  const entries = Array.isArray(json) ? json : [json];
  /** @type {Record<string, any>} */
  const profiles = {};
  const secrets = [];
  const warnings = [];
  let defaultProfile;

  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object') return;
    // Une entrée peut définir des sous-profils qui surchargent ses valeurs (« profiles » + « defaultProfile »)
    const variants = entry.profiles && typeof entry.profiles === 'object'
      ? Object.entries(entry.profiles).map(([sub, o]) => ({ sub, cfg: { ...entry, ...o } }))
      : [{ sub: undefined, cfg: entry }];

    for (const { sub, cfg } of variants) {
      const base = slug(entry.name || `profil${i + 1}`);
      const name = uniqueName(profiles, sub ? (variants.length > 1 || entry.name ? `${base}-${slug(sub)}` : slug(sub)) : base);
      if (!cfg.host) {
        warnings.push(t('"{0}" skipped: no "host"', name));
        continue;
      }
      const protocol = cfg.protocol === 'sftp' ? 'sftp' : cfg.secure ? 'ftps' : 'ftp';
      const profile = {
        protocol,
        host: cfg.host,
        port: cfg.port ?? (protocol === 'sftp' ? 22 : cfg.secure === 'implicit' ? 990 : 21),
        username: cfg.username ?? (protocol === 'sftp' ? undefined : 'anonymous'),
        remotePath: cfg.remotePath ?? '/',
        ...(cfg.secure === 'implicit' ? { secure: 'implicit' } : {}),
        ...(cfg.secureOptions?.rejectUnauthorized === false ? { rejectUnauthorized: false } : {}),
        ...(cfg.privateKeyPath ? { privateKeyPath: cfg.privateKeyPath } : {}),
        ...(cfg.agent ? { agent: true } : {}),
        ...(cfg.uploadOnSave ? { uploadOnSave: true } : {}),
        ...(Array.isArray(cfg.ignore) ? { ignore: cfg.ignore } : {}),
        ...(cfg.connectTimeout ? { timeout: cfg.connectTimeout } : {}),
      };
      if (profile.username === undefined) delete profile.username;
      profiles[name] = profile;
      if (typeof cfg.password === 'string' && cfg.password) secrets.push({ profile, password: cfg.password });
      if (cfg.context && cfg.context !== '.' && cfg.context !== './') {
        warnings.push(t('"{0}": "context" ({1}) is not supported, the project root is used', name, cfg.context));
      }
      if (typeof cfg.passphrase === 'string') warnings.push(t('"{0}": the key passphrase will be asked when connecting', name));
      if (sub && entry.defaultProfile === sub && !defaultProfile) defaultProfile = name;
    }
  });

  const names = Object.keys(profiles);
  return { config: { defaultProfile: defaultProfile ?? names[0], profiles }, secrets, warnings };
}

function slug(name) {
  return String(name).trim().replace(/\s+/g, '-').replace(/[^\w.-]/g, '').toLowerCase() || 'profil';
}

function uniqueName(existing, name) {
  let candidate = name;
  for (let i = 2; candidate in existing; i++) candidate = `${name}-${i}`;
  return candidate;
}

module.exports = { convertSftpConfig };
