// API publique (v1) de FTP SFTP Deploy, extension facultative : ce qu'utilise Git Forge.
import * as vscode from 'vscode';

export const DEPLOY_EXTENSION_ID = 'yuval-abdm.ftp-sftp-deploy';

export interface DeployApi {
  hasConfig(): boolean;
  resolve(uris: vscode.Uri[]): { uri: vscode.Uri; host: string; profile: string }[];
  upload(uris: vscode.Uri[]): Promise<unknown>;
}

export function deployInstalled(): boolean {
  return vscode.extensions.getExtension(DEPLOY_EXTENSION_ID) !== undefined;
}

export async function deployApi(): Promise<DeployApi | undefined> {
  const extension = vscode.extensions.getExtension<DeployApi>(DEPLOY_EXTENSION_ID);
  if (!extension) return undefined;
  return extension.isActive ? extension.exports : extension.activate();
}
