import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const FIREBASE_CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const FIREBASE_CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

export async function loadProjectId(explicitProject = '') {
  if (explicitProject) {
    return explicitProject;
  }

  const firebasercPath = path.join(process.cwd(), '.firebaserc');
  const raw = await fs.readFile(firebasercPath, 'utf8');
  const parsed = JSON.parse(raw);
  const projectId = parsed?.projects?.default;
  if (!projectId) {
    throw new Error(`No default Firebase project found in ${firebasercPath}`);
  }
  return projectId;
}

export async function loadAccessToken() {
  const authPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const raw = await fs.readFile(authPath, 'utf8');
  const parsed = JSON.parse(raw);
  const refreshToken = parsed?.tokens?.refresh_token;
  const accessToken = parsed?.tokens?.access_token;

  if (!refreshToken && !accessToken) {
    throw new Error(`No Firebase CLI credentials found in ${authPath}`);
  }

  if (!refreshToken) {
    return accessToken;
  }

  const form = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: FIREBASE_CLIENT_ID,
    client_secret: FIREBASE_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://www.googleapis.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok || typeof data.access_token !== 'string') {
    throw new Error(`Unable to refresh Firebase CLI access token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}
